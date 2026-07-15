import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { fetchAllPages } from '../../utils/query'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum, round2, roundRupees } from '../../utils/money'
import { fmtDate, today, currentFYLabel, parseFlexibleDate, fyCodeForDate } from '../../utils/dates'
import { suggestNextNo } from '../../utils/numbering'
import { buildHSNMap } from '../../utils/hsn'
import { withTimeout } from '../../utils/query'
import { cleanProductName, productMatchKey, findNearMatchProduct } from '../../utils/products'
import DocumentAttachments from '../../components/DocumentAttachments'
import { downloadTemplate, downloadCSV, detectDelimiter, parseCSVLine } from '../../utils/csvTemplate'
import { useAuth } from '../../hooks/useAuth'
import { hasFullAccess } from '../../utils/roles'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { fetchEntityAvailableStock, findLinesMissingProductId, findLinesExceedingStock, getInvoiceLifecycleStage } from '../../utils/stock'

const INV_STATUSES = ['draft', 'submitted', 'partial', 'paid', 'cancelled']
const TDS_SECTIONS = ['194C', '194H', '194I', '194J', '194Q', '206C']
const TDS_SECTION_LABELS = {
  '194C': 'Payment to Contractors',
  '194H': 'Commission or Brokerage',
  '194I': 'Rent',
  '194J': 'Professional/Technical Services',
  '194Q': 'Purchase of Goods',
  '206C': 'TCS on Sale of Goods',
}

// CHANGED: LineItemsEditor lines carry UI-only helper fields (_id, _cost_rate,
// _margin_pct, _hsn_*) that are NOT columns on invoice_lines. Sending them made
// the insert fail with "Could not find the '_id' column…", which — because the
// insert result wasn't checked before — silently left invoices with ZERO lines.
// That was the real root cause of stock never moving: an invoice with no lines
// moves no stock. This keeps only the real DB columns.
const INVOICE_LINE_COLUMNS = [
  'product_id', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate',
  'taxable_amount', 'cgst_rate', 'cgst_amount', 'sgst_rate', 'sgst_amount',
  'igst_rate', 'igst_amount', 'total_amount',
]
function toInvoiceLinePayload(computedLine, invoiceId, lineNo) {
  const out = { invoice_id: invoiceId, line_no: lineNo }
  for (const col of INVOICE_LINE_COLUMNS) if (computedLine[col] !== undefined) out[col] = computedLine[col]
  return out
}

const EMPTY_FORM = {
  invoice_date: today(), due_date: '', invoice_type: 'sales', status: 'draft',
  seller_entity_id: '', buyer_entity_id: '',
  order_id: '', order_leg_id: '', pi_id: '', po_id: '',
  is_interstate: false,
  bill_from: '', bill_to: '', ship_from: '', ship_to: '',
  eway_bill_no: '', eway_bill_date: '',
  einvoice_irn: '', einvoice_ack_no: '', einvoice_ack_date: '',
  tds_amount: 0, tcs_amount: 0,
  notes: '',
  invoice_no: '', // CHANGED: optional manual invoice number — blank suggests one via suggestNextNo()
}

// CHANGED: auto-completes the buyer's purchase-register mirror the moment an
// E-way Bill is generated on a 'sales' invoice — the E-way Bill is the actual
// physical-movement event, so this is the only trustworthy trigger for it
// (previously this was created as a 'draft' at invoice-submit time, before
// goods had actually moved, and required the buyer to manually confirm it).
// Skipped for external buyers (no internal bookkeeping needed) and no-ops if
// a mirror already exists for this invoice (idempotent — safe to call every
// time the E-way Bill fields are saved).
async function autoCompletePurchaseMirror(inv, lines) {
  if (inv.invoice_type !== 'sales' || !inv.eway_bill_no) return {}
  if (!inv.buyer_entity_id || inv.buyer?.type === 'external') return {}

  const { data: existing } = await supabase.from('invoices')
    .select('id').eq('source_invoice_id', inv.id).eq('invoice_type', 'purchase').limit(1)
  if (existing?.length) return {}

  const fyCode = fyCodeForDate(inv.eway_bill_date || inv.invoice_date)
  const invoiceNo = await suggestNextNo({ table: 'invoices', noCol: 'invoice_no', entityShort: inv.buyer?.short_name || inv.buyer?.name, fyCode })

  const { data: purchaseInv, error } = await supabase.from('invoices').insert({
    invoice_no: invoiceNo,
    invoice_date: inv.invoice_date,
    due_date: inv.due_date || null,
    invoice_type: 'purchase',
    status: 'submitted',
    seller_entity_id: inv.seller_entity_id,
    buyer_entity_id: inv.buyer_entity_id,
    source_invoice_id: inv.id,
    pi_id: inv.pi_id || null,
    po_id: inv.po_id || null,
    is_interstate: inv.is_interstate,
    eway_bill_no: inv.eway_bill_no,
    eway_bill_date: inv.eway_bill_date || null,
    taxable_amount: inv.taxable_amount,
    cgst_amount: inv.cgst_amount,
    sgst_amount: inv.sgst_amount,
    igst_amount: inv.igst_amount,
    total_amount: inv.total_amount,
    outstanding_amount: inv.total_amount,
    paid_amount: 0,
    notes: `Auto-completed from ${inv.invoice_no || 'linked sales invoice'} on E-way Bill generation`,
  }).select().single()

  if (error || !purchaseInv) return { error }

  if (lines?.length) {
    const purchaseLines = lines.map((l, i) => toInvoiceLinePayload(l, purchaseInv.id, i + 1))
    const { error: lineErr } = await supabase.from('invoice_lines').insert(purchaseLines)
    if (lineErr) return { purchaseInv, error: lineErr }
  }
  return { purchaseInv }
}

// ─── Invoice List ─────────────────────────────────────────────────────────────
function InvoiceList() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: bulk delete — restricted to 'master' role (see PI page for rationale)
  const canDelete = hasFullAccess(profile)
  const [selected, setSelected] = useState(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [invoices, setInvoices] = useState([])
  const [entities, setEntities] = useState([])
  // CHANGED: needed to resolve/auto-create products for CSV-uploaded lines —
  // previously this handler never set product_id at all, which silently
  // broke stock tracking for every CSV-created invoice line.
  const [products, setProducts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [typeFilter, setType]   = useState('all')
  const [entityFilter, setEntityF] = useState('')
  const [toast, setToast]       = useState(null)
  const [csvModal, setCsvModal]   = useState(false)
  const [csvText, setCsvText]     = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: invs }, { data: es }, { data: ps }] = await Promise.all([
      supabase.from('invoices')
        .select('*, seller:seller_entity_id(name,short_name), buyer:buyer_entity_id(name,short_name)')
        .eq('is_deleted', false).neq('invoice_type', 'intercompany')
        .order('invoice_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      // CHANGED: for CSV product resolution below. Paginated — products can
      // exceed PostgREST's default 1000-row cap, which would otherwise
      // silently drop products past that point from CSV matching.
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate')),
    ])
    setInvoices(invs || [])
    setEntities(es || [])
    setProducts(ps || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Format: invoice_date,invoice_type,seller_entity,buyer_entity,is_interstate,product,description,hsn_code,qty,unit,rate,gst_rate,due_date,notes,invoice_no
  // CHANGED: invoice_no was previously never set on CSV-created invoices at
  // all — not a hard insert failure (invoice_no is nullable on the live
  // schema, confirmed via information_schema), but every CSV-created invoice
  // was silently getting no invoice number whatsoever. This now generates
  // one via suggestNextNo() or uses a supplied value, same as PI/PO.
  // NOTE: financial_year_id does NOT exist on the live invoices table either
  // (confirmed) — fy.id is only used as the RPC's fy_id parameter, never stored.
  // DB default, so every CSV upload here would have failed outright. This adds the
  // same FY-resolve + suggestNextNo() generation the other modules use, plus lets you
  // supply your own invoice_no per row (optional — blank auto-generates).
  // CHANGED: added a "product" column + resolution step. Previously every line
  // from this uploader had product_id = null (no lookup existed at all), which
  // silently broke Actual Stock / Planned Stock tracking for every CSV-created
  // invoice line. Now mirrors the same find-or-auto-create pattern Opening
  // Stock's CSV upload already uses.
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    // CHANGED: added delimiter detection + quote-aware parsing, matching the
    // fix applied to PI/PO — this handler previously hardcoded a plain comma
    // split, which both broke on Excel tab-paste and shredded any product
    // name/description containing a comma inside quotes.
    const delim = detectDelimiter(lines[0])
    const header = parseCSVLine(lines[0], delim).map(h => h.trim().toLowerCase())
    let created = 0, errors = []
    const usedInvoiceNos = new Set(invoices.map(i => i.invoice_no?.toLowerCase()).filter(Boolean))
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i], delim)
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.invoice_date}__${row.seller_entity}__${row.buyer_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }

    // CHANGED: resolve/auto-create products up front, across all groups, in
    // one batch — same approach as Stock/Opening Stock's CSV handler.
    // CHANGED: match on name + HSN + rate + GST together, not name alone —
    // only merge when all four match (per product-owner decision); otherwise
    // treat as a different product even if the name is identical.
    // CHANGED: precomputed Map (key -> product) instead of an array .find()
    // re-run per row — avoids millions of redundant match-key computations on
    // a large file, which was slow enough to look like a hang.
    const productMap = new Map()
    for (const p of products) {
      productMap.set(productMatchKey({ name: p.name, hsn_code: p.hsn_code, rate: p.default_rate, gst_rate: p.gst_rate }), p)
    }
    const rowMatchKey = row => productMatchKey({ name: row.product, hsn_code: row.hsn_code, rate: row.rate, gst_rate: row.gst_rate })
    const findProduct = row => productMap.get(rowMatchKey(row))
    const allRows = Object.values(groups).flatMap(g => g.lines)
    const missingKeys = new Set()
    const missingRows = []
    const nearMatchNotes = []
    for (const r of allRows) {
      if (!r.product?.trim()) continue
      const k = rowMatchKey(r)
      if (productMap.has(k) || missingKeys.has(k)) continue
      // CHANGED: before treating this as a genuinely new product, check for
      // an existing one with the same name+HSN+GST at a near-identical rate
      // (see findNearMatchProduct) — reuse it instead of creating a phantom
      // duplicate that silently starts at zero stock.
      const near = findNearMatchProduct(products, { name: r.product, hsn_code: r.hsn_code, rate: r.rate, gst_rate: r.gst_rate })
      if (near) {
        productMap.set(k, near)
        nearMatchNotes.push(`${r.product} @ ₹${r.rate} → matched to existing "${near.name}" @ ₹${near.default_rate} (rate close enough, not creating a duplicate)`)
        continue
      }
      missingKeys.add(k); missingRows.push(r)
    }
    if (missingRows.length > 0) {
      const payloads = missingRows.map(src => ({ name: cleanProductName(src.product), hsn_code: src.hsn_code || null, gst_rate: toNum(src.gst_rate) || 18, unit: src.unit || 'Nos', default_rate: toNum(src.rate) || null, is_active: true }))
      const { data: newProducts, error: pErr } = await supabase.from('products').insert(payloads).select()
      if (pErr) {
        errors.push(`Could not auto-create ${missingRows.length} new product(s) — ${pErr.message}`)
      } else {
        for (const p of (newProducts || [])) {
          productMap.set(productMatchKey({ name: p.name, hsn_code: p.hsn_code, rate: p.default_rate, gst_rate: p.gst_rate }), p)
        }
      }
    }

    for (const [key, group] of Object.entries(groups)) {
      const { meta, lines: gLines } = group
      const sellerE = entities.find(e => e.short_name?.toLowerCase() === meta.seller_entity?.toLowerCase() || e.name?.toLowerCase() === meta.seller_entity?.toLowerCase())
      const buyerE  = entities.find(e => e.short_name?.toLowerCase() === meta.buyer_entity?.toLowerCase()  || e.name?.toLowerCase() === meta.buyer_entity?.toLowerCase())
      if (!sellerE) { errors.push(`Seller "${meta.seller_entity}" not found`); continue }
      if (!buyerE)  { errors.push(`Buyer "${meta.buyer_entity}" not found`); continue }

      // CHANGED: normalize date (YYYY-MM-DD or DD-MM-YYYY) — same fix as PI/PO,
      // a raw DD-MM-YYYY value fails Postgres with "date/time field value out
      // of range" once the day exceeds 12.
      const invoiceDate = parseFlexibleDate(meta.invoice_date)
      if (!invoiceDate) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: invoice_date "${meta.invoice_date}" is not a valid date — use YYYY-MM-DD or DD-MM-YYYY`); continue }
      const dueDate = meta.due_date ? parseFlexibleDate(meta.due_date) : null
      if (meta.due_date && !dueDate) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: due_date "${meta.due_date}" is not a valid date`); continue }

      // CHANGED: invoice_no taken from the CSV if supplied, else suggested
      // via suggestNextNo() keyed to the seller (the entity issuing the
      // invoice — mirrors PI's use of from_entity). FY code computed
      // directly from this row's own invoiceDate — no financial_years lookup.
      const fyCode = fyCodeForDate(invoiceDate)
      let invoiceNo = (meta.invoice_no || '').trim()
      if (invoiceNo) {
        if (usedInvoiceNos.has(invoiceNo.toLowerCase())) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: invoice number "${invoiceNo}" is already in use`); continue }
      } else {
        invoiceNo = await suggestNextNo({ table: 'invoices', noCol: 'invoice_no', entityShort: sellerE.short_name || sellerE.name, fyCode, excludeSet: usedInvoiceNos })
      }
      usedInvoiceNos.add(invoiceNo.toLowerCase())

      // CHANGED: require a resolvable product per line — a line with no
      // product reference cannot be tracked in stock, so we reject it
      // clearly rather than silently inserting it with product_id = null.
      let lineErr = false
      const interstate = meta.is_interstate === 'true' || (sellerE.state_code && buyerE.state_code && sellerE.state_code !== buyerE.state_code)
      const invLines = gLines.map((r, i) => {
        const product = r.product?.trim() ? findProduct(r) : null
        if (r.product?.trim() && !product) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}, line ${i+1}: product "${r.product}" could not be resolved or created`); lineErr = true }
        if (!r.product?.trim()) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}, line ${i+1}: product column is required for stock tracking`); lineErr = true }
        const rate = toNum(r.rate); const qty = toNum(r.qty); const taxable = round2(qty * rate)
        const gstRate = toNum(r.gst_rate) || 18; const half = gstRate / 2
        const igst = interstate ? round2(taxable * gstRate / 100) : 0
        const cgst = !interstate ? round2(taxable * half / 100) : 0
        return { line_no: i+1, product_id: product?.id || null, description: r.description, hsn_code: r.hsn_code, qty, unit: r.unit||'Nos', rate, gst_rate: gstRate, taxable_amount: taxable, cgst_rate: half, cgst_amount: cgst, sgst_rate: half, sgst_amount: cgst, igst_rate: interstate?gstRate:0, igst_amount: igst, total_amount: round2(taxable+igst+cgst+cgst) }
      })
      if (lineErr) continue
      const rawTotals = invLines.reduce((acc, l) => ({ taxable_amount: acc.taxable_amount+l.taxable_amount, cgst_amount: acc.cgst_amount+l.cgst_amount, sgst_amount: acc.sgst_amount+l.sgst_amount, igst_amount: acc.igst_amount+l.igst_amount, total_amount: acc.total_amount+l.total_amount, total_qty: acc.total_qty+l.qty }), { taxable_amount:0,cgst_amount:0,sgst_amount:0,igst_amount:0,total_amount:0,total_qty:0 })
      // Round off to the nearest whole rupee at the header level only — see
      // computeTotals() in LineItemsEditor.jsx for why.
      const invPreciseSubtotal = round2(rawTotals.taxable_amount + rawTotals.cgst_amount + rawTotals.sgst_amount + rawTotals.igst_amount)
      const invFinalTotal = roundRupees(invPreciseSubtotal)
      const totals = { ...rawTotals, taxable_amount: round2(rawTotals.taxable_amount), cgst_amount: round2(rawTotals.cgst_amount), sgst_amount: round2(rawTotals.sgst_amount), igst_amount: round2(rawTotals.igst_amount), total_amount: invFinalTotal, round_off_amount: round2(invFinalTotal - invPreciseSubtotal) }
      const { data: inv, error: invErr } = await supabase.from('invoices').insert({ invoice_no: invoiceNo, invoice_date: invoiceDate, invoice_type: meta.invoice_type||'sales', seller_entity_id: sellerE.id, buyer_entity_id: buyerE.id, is_interstate: interstate, due_date: dueDate, notes: meta.notes||null, status: 'draft', outstanding_amount: totals.total_amount, paid_amount: 0, ...totals }).select().single()
      if (invErr) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: ${invErr.message}`); continue }
      const { error: invLineErr } = await supabase.from('invoice_lines').insert(invLines.map(l => ({ ...l, invoice_id: inv.id })))
      if (invLineErr) { errors.push(`Invoice ${invoiceNo}: header created but line items failed to save: ${invLineErr.message}`); continue }
      created++
    }
    setCsvSaving(false); setCsvResult({ created, errors, nearMatchNotes }); load()
  }

  function handleExportCSV() {
    downloadCSV(`invoices_export_${today()}.csv`,['invoice_no','invoice_date','invoice_type','seller','buyer','tax_type','status','taxable_amount','total_amount','outstanding_amount'],filtered.map(i=>({invoice_no:i.invoice_no||'',invoice_date:i.invoice_date,invoice_type:i.invoice_type,seller:i.seller?.name||'',buyer:i.buyer?.name||'',tax_type:i.is_interstate?'Interstate':'Local',status:i.status,taxable_amount:i.taxable_amount||0,total_amount:i.total_amount||0,outstanding_amount:i.outstanding_amount||0})))
  }

  const filtered = invoices.filter(i => {
    const ms  = !search || (i.invoice_no || '').toLowerCase().includes(search.toLowerCase()) ||
      i.seller?.name?.toLowerCase().includes(search.toLowerCase()) ||
      i.buyer?.name?.toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter === 'all' || i.status === statusFilter
    const mt  = typeFilter === 'all' || i.invoice_type === typeFilter
    const me  = !entityFilter || i.seller_entity_id === entityFilter || i.buyer_entity_id === entityFilter
    return ms && mst && mt && me
  })

  // summary totals
  const totalOutstanding = filtered.reduce((s, i) => s + (i.outstanding_amount || 0), 0)
  const totalAmount      = filtered.reduce((s, i) => s + (i.total_amount || 0), 0)

  function toggleSelect(id) {
    setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleSelectAll() {
    setSelected(s => s.size === filtered.length ? new Set() : new Set(filtered.map(i => i.id)))
  }
  async function handleBulkDelete() {
    setBulkDeleting(true)
    const { error } = await supabase.from('invoices').update({ is_deleted: true }).in('id', [...selected])
    // Same reopen-the-source-PI fix as the single-invoice delete above —
    // otherwise a bulk-deleted invoice leaves its PI stuck on 'converted'.
    if (!error) {
      const piIds = invoices.filter(i => selected.has(i.id) && i.pi_id).map(i => i.pi_id)
      if (piIds.length) {
        await supabase.from('proforma_invoices').update({ status: 'accepted', converted_to_invoice_id: null }).in('id', piIds)
      }
    }
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${selected.size} invoice(s) deleted`, type: 'success' })
    setSelected(new Set())
    load()
  }

  const columns = [
    ...(canDelete ? [{
      label: <input type='checkbox' checked={filtered.length > 0 && selected.size === filtered.length}
        onChange={toggleSelectAll} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
      render: i => <input type='checkbox' checked={selected.has(i.id)}
        onChange={() => toggleSelect(i.id)} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
    }] : []),
    { label: 'S.No.',      render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    { label: 'Invoice No', render: i => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{i.invoice_no || '—'}</span> },
    { label: 'Type',    render: i => <Badge status={i.invoice_type} label={i.invoice_type === 'sales' ? 'Sales' : 'Purchase'} /> },
    { label: 'Seller',  render: i => <span style={{ fontSize: '12px' }}>{i.seller?.short_name || i.seller?.name}</span> },
    { label: 'Buyer',   render: i => <span style={{ fontSize: '12px' }}>{i.buyer?.short_name || i.buyer?.name}</span> },
    { label: 'Date',    render: i => <span style={{ fontSize: '12px' }}>{fmtDate(i.invoice_date)}</span> },
    { label: 'Due',     render: i => {
      if (!i.due_date) return <span style={{ color: C.textMuted }}>—</span>
      const overdue = new Date(i.due_date) < new Date() && i.status !== 'paid'
      return <span style={{ fontSize: '12px', color: overdue ? C.danger : C.text, fontWeight: overdue ? 700 : 400 }}>{fmtDate(i.due_date)}{overdue ? ' ⚠️' : ''}</span>
    }},
    { label: 'Qty', right: true, render: i => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{i.total_qty || '—'}</span> },
    { label: 'Amount',  right: true, render: i => <span style={{ fontWeight: 600 }}>{formatINR(i.total_amount)}</span> },
    { label: 'Outstanding', right: true, render: i => <span style={{ fontWeight: 600, color: i.outstanding_amount > 0 ? C.warning : C.success }}>{formatINR(i.outstanding_amount)}</span> },
    { label: 'Status',  render: i => <Badge status={i.status} /> },
    // CHANGED: separate from payment/document Status — this reflects
    // whether stock has actually moved yet (E-way Bill gated), which
    // 'submitted'/'paid' alone doesn't tell you.
    { label: 'Stock', render: i => { const s = getInvoiceLifecycleStage(i); return <Badge status={s.key} label={s.label} /> } },
  ]

  return (
    <div>
      <PageHeader
        title='Invoices'
        subtitle='Tax invoices — sales and purchases'
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
            <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
            <Btn onClick={() => navigate('/invoices/new')}>+ New Invoice</Btn>
          </div>
        }
      />

      {/* summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Total Invoiced' value={formatINR(totalAmount)} />
        <StatCard label='Outstanding' value={formatINR(totalOutstanding)} color={totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Invoices' value={filtered.length} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search invoice no, entity…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit' }} />
        <select value={typeFilter} onChange={e => setType(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All types</option>
          <option value='sales'>Sales</option>
          <option value='purchase'>Purchase</option>
        </select>
        <select value={statusFilter} onChange={e => setStatus(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {INV_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={entityFilter} onChange={e => setEntityF(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value=''>All entities</option>
          {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
        </select>
        <input type='date' value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='From date'/>
        <input type='date' value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='To date'/>
        {(dateFrom||dateTo)&&<Btn size='sm' variant='ghost' onClick={()=>{setDateFrom('');setDateTo('')}}>Clear</Btn>}
      </div>

      {canDelete && selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fdeeee', border: '1px solid #f0c4c4', borderRadius: '6px', padding: '10px 14px', marginBottom: '14px' }}>
          <span style={{ fontSize: '13px', color: '#8a2f2f' }}>{selected.size} invoice{selected.size > 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn size='sm' variant='ghost' onClick={() => setSelected(new Set())}>Clear</Btn>
            <Btn size='sm' variant='danger' onClick={() => setConfirmBulkDelete(true)} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : 'Delete Selected'}</Btn>
          </div>
        </div>
      )}

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={i => navigate(`/invoices/${i.id}`)}
              emptyState={<EmptyState icon='🧾' title='No invoices' action={<Btn onClick={() => navigate('/invoices/new')}>+ New Invoice</Btn>} />} />
        }
      </Card>

      <ConfirmModal open={confirmBulkDelete} onClose={() => setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Invoices' message={`Delete ${selected.size} selected invoice(s)? This cannot be undone.`} danger />


      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Invoices' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('invoices')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>invoice_date,invoice_type,seller_entity,buyer_entity,is_interstate,product,description,hsn_code,qty,unit,rate,gst_rate,due_date,notes,invoice_no</code><br /><br />
            Multiple rows with same <strong>invoice_date + seller + buyer</strong> are grouped into one Invoice. <code>invoice_no</code> is optional — leave it blank to auto-generate, or supply your own (checked against existing invoices and other rows in this file). <strong>product</strong> is required — match an existing product name exactly, or a new product is auto-created from this row's hsn_code/gst_rate/rate/unit. Lines without a resolvable product are rejected (stock tracking depends on this link).
          </div>
          <FormRow label='Paste CSV'>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          </FormRow>
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.created} invoices created.</strong>
              {csvResult.nearMatchNotes?.length > 0 && (
                <details style={{ marginTop: '6px' }}>
                  <summary style={{ cursor: 'pointer', color: C.textSoft }}>Show {csvResult.nearMatchNotes.length} row{csvResult.nearMatchNotes.length === 1 ? '' : 's'} matched to an existing product at a near-identical rate (no duplicate created)</summary>
                  <div style={{ maxHeight: '140px', overflowY: 'auto', marginTop: '4px' }}>
                    {csvResult.nearMatchNotes.map((t, i) => <div key={i} style={{ color: C.textMid, fontFamily: 'monospace', fontSize: '11px' }}>{t}</div>)}
                  </div>
                </details>
              )}
              {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── New Invoice Form ─────────────────────────────────────────────────────────
function NewInvoice() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fromPiId = searchParams.get('from_pi')

  // CHANGED: which entities this user may raise an invoice *as seller* —
  // master sees all, everyone else only entities they've been granted.
  const { entities: accessEntities, frozen: sellerEntityFrozen, defaultEntityId } = useEntityAccess()
  const [entities, setEntities] = useState([])
  const [orders, setOrders]     = useState([])
  const [pis, setPIs]           = useState([])
  const [pos, setPOs]           = useState([])
  // Which PI/PO ids already have a (non-deleted) invoice raised against them —
  // used to hide them from the Linked PI/PO dropdowns so the same PI/PO can't
  // be invoiced twice by accident.
  const [usedPiIds, setUsedPiIds] = useState(new Set())
  const [usedPoIds, setUsedPoIds] = useState(new Set())
  const [legs, setLegs]         = useState([])
  const [lines, setLines]       = useState([])
  const [hsnMap, setHsnMap]     = useState(new Map())
  // CHANGED: the existing product catalog — feeds LineItemsEditor's product
  // dropdown so lines reference an existing product_id (the same one stock was
  // created under) instead of leaving product_id blank / forcing a new one.
  const [products, setProducts] = useState([])
  const [form, setForm]         = useState({ ...EMPTY_FORM, pi_id: fromPiId || '' })
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  // CHANGED: TDS/TCS entries
  const [tdsEntries, setTdsEntries] = useState([])  // [{type,section,rate,base_amount}]
  // CHANGED: available stock for the seller entity — feeds LineItemsEditor's
  // stockMap so the seller can see (and be warned about) overselling past
  // what they actually have on hand. Was previously never wired in at all.
  const [stockMap, setStockMap] = useState({})
  const [stockWarning, setStockWarning] = useState(null)
  const [linesLoading, setLinesLoading] = useState(false)  // CHANGED: PI/PO line-item fetch in progress

  function addTdsRow(type) {
    setTdsEntries(rows => [...rows, { _id: Date.now(), type, section: type === 'tcs' ? '206C' : '194C', rate: type === 'tcs' ? 0.1 : 1, base_amount: '' }])
  }
  function updateTdsRow(id, key, val) {
    setTdsEntries(rows => rows.map(r => r._id === id ? { ...r, [key]: val } : r))
  }
  function removeTdsRow(id) {
    setTdsEntries(rows => rows.filter(r => r._id !== id))
  }

  useEffect(() => {
    Promise.all([
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('proforma_invoices').select('id,pi_no,from_entity_id,to_entity_id,total_amount,order_id,order_leg_id').eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('purchase_orders').select('id,po_no,buyer_entity_id,seller_entity_id,order_id,order_leg_id').eq('is_deleted', false).order('po_date', { ascending: false }),
      supabase.from('hsn_master').select('*').eq('is_active', true),
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate').eq('is_active', true).order('name')),
      fetchAllPages(() => supabase.from('invoices').select('pi_id,po_id').eq('is_deleted', false)),
    ]).then(([{ data: es }, { data: os }, { data: piData }, { data: poData }, { data: hsnRows }, { data: prods }, { data: invRefs }]) => {
      setEntities(es || [])
      setOrders(os || [])
      setPIs(piData || [])
      setPOs(poData || [])
      setHsnMap(buildHSNMap(hsnRows || []))
      setProducts(prods || [])
      setUsedPiIds(new Set((invRefs || []).map(r => r.pi_id).filter(Boolean)))
      setUsedPoIds(new Set((invRefs || []).map(r => r.po_id).filter(Boolean)))
    })
  }, [])

  // Pre-fill from PI if coming from convert button
  useEffect(() => {
    if (!fromPiId || !pis.length) return
    const pi = pis.find(p => p.id === fromPiId)
    if (!pi) return
    setF('seller_entity_id', pi.from_entity_id)
    setF('buyer_entity_id',  pi.to_entity_id)
    // Load PI lines
    // CHANGED: same 1000-row REST cap as elsewhere — a source PI with more
    // lines than that would otherwise convert to an invoice missing the rest.
    fetchAllPages(() => supabase.from('proforma_invoice_lines').select('*').eq('pi_id', fromPiId).order('line_no')).then(({ data }) => {
      if (data) setLines(data.map(l => ({ ...l, _id: l.id })))
    })
  }, [fromPiId, pis])

  // CHANGED: refresh available stock whenever the seller entity changes.
  useEffect(() => {
    if (!form.seller_entity_id) { setStockMap({}); return }
    fetchEntityAvailableStock(form.seller_entity_id).then(setStockMap)
  }, [form.seller_entity_id])

  // CHANGED: once we know which single entity this user is restricted to,
  // default the seller field to it (unless already set, e.g. from a PI
  // conversion) so a single-entity user doesn't have to pick from a list of one.
  useEffect(() => {
    if (defaultEntityId && !form.seller_entity_id) setF('seller_entity_id', defaultEntityId)
  }, [defaultEntityId])

  function setF(k, v) {
    setForm(f => {
      const updated = { ...f, [k]: v }
      if (k === 'seller_entity_id' || k === 'buyer_entity_id') {
        const sid = k === 'seller_entity_id' ? v : f.seller_entity_id
        const bid = k === 'buyer_entity_id'  ? v : f.buyer_entity_id
        const se  = entities.find(e => e.id === sid)
        const be  = entities.find(e => e.id === bid)
        if (se?.state_code && be?.state_code)
          updated.is_interstate = se.state_code !== be.state_code
      }
      return updated
    })
  }

  async function loadLegs(orderId) {
    if (!orderId) { setLegs([]); return }
    const { data } = await supabase.from('order_legs')
      .select('id,leg_no,from_entity:from_entity_id(name,short_name),to_entity:to_entity_id(name,short_name)')
      .eq('order_id', orderId).order('leg_no')
    setLegs(data || [])
  }

  // CHANGED: picking a Linked PI/PO from the manual dropdown (as opposed to
  // arriving via the "Convert to Invoice" button, which already had this)
  // previously only prefilled seller/buyer — the planned line items never
  // carried over. Mirrors the same fix in PO/index.jsx. Only overwrites
  // `lines` when it's empty so it won't clobber lines already being edited.
  async function handlePISelect(piId) {
    const pi = pis.find(p => p.id === piId)
    setForm(f => ({
      ...f,
      pi_id: piId,
      seller_entity_id: f.seller_entity_id || pi?.from_entity_id || '',
      buyer_entity_id:  f.buyer_entity_id  || pi?.to_entity_id   || '',
      order_id:         f.order_id         || pi?.order_id       || '',
      order_leg_id:     f.order_leg_id     || pi?.order_leg_id   || '',
    }))
    if (pi?.order_id && !form.order_id) loadLegs(pi.order_id)
    if (!piId || lines.length > 0) return
    setLinesLoading(true)
    try {
      const { data: piLines, error } = await withTimeout(
        fetchAllPages(() => supabase.from('proforma_invoice_lines')
          .select('product_id,description,hsn_code,qty,unit,rate,gst_rate,line_no')
          .eq('pi_id', piId).order('line_no')),
        20000, 'Loading PI line items',
      )
      if (error) { setToast({ message: `Could not load PI lines: ${error.message}`, type: 'error' }); return }
      if (piLines?.length) {
        // computeLine() is normally only run by LineItemsEditor's own onChange
        // handlers — lines injected directly via setLines skip it, leaving
        // taxable_amount/total_amount at 0. Run it up front so the preview is
        // correct immediately.
        setLines(piLines.map((l, i) => computeLine({
          _id: Date.now() + i, line_no: i + 1,
          product_id: l.product_id || '', description: l.description,
          hsn_code: l.hsn_code, qty: l.qty, unit: l.unit,
          rate: l.rate, gst_rate: l.gst_rate,
          _hsn_resolved_rate: null, _hsn_override: false, _cost_rate: null, _margin_pct: '',
        }, form.is_interstate)))
      } else {
        setToast({ message: `${pi?.pi_no || 'This PI'} has no line items saved — add lines manually below, or open the PI to check it.`, type: 'info' })
      }
    } catch (e) {
      setToast({ message: `Could not load PI lines: ${e.message}`, type: 'error' })
    } finally {
      setLinesLoading(false)
    }
  }

  async function handlePOSelect(poId) {
    const po = pos.find(p => p.id === poId)
    setForm(f => ({
      ...f,
      po_id: poId,
      seller_entity_id: f.seller_entity_id || po?.seller_entity_id || '',
      buyer_entity_id:  f.buyer_entity_id  || po?.buyer_entity_id  || '',
      order_id:         f.order_id         || po?.order_id         || '',
      order_leg_id:     f.order_leg_id     || po?.order_leg_id     || '',
    }))
    if (po?.order_id && !form.order_id) loadLegs(po.order_id)
    if (!poId || lines.length > 0) return
    setLinesLoading(true)
    try {
      const { data: poLines, error } = await withTimeout(
        fetchAllPages(() => supabase.from('purchase_order_lines')
          .select('product_id,description,hsn_code,qty,unit,rate,gst_rate,line_no')
          .eq('po_id', poId).order('line_no')),
        20000, 'Loading PO line items',
      )
      if (error) { setToast({ message: `Could not load PO lines: ${error.message}`, type: 'error' }); return }
      if (poLines?.length) {
        setLines(poLines.map((l, i) => computeLine({
          _id: Date.now() + i, line_no: i + 1,
          product_id: l.product_id || '', description: l.description,
          hsn_code: l.hsn_code, qty: l.qty, unit: l.unit,
          rate: l.rate, gst_rate: l.gst_rate,
          _hsn_resolved_rate: null, _hsn_override: false, _cost_rate: null, _margin_pct: '',
        }, form.is_interstate)))
      } else {
        setToast({ message: `${po?.po_no || 'This PO'} has no line items saved — add lines manually below, or open the PO to check it.`, type: 'info' })
      }
    } catch (e) {
      setToast({ message: `Could not load PO lines: ${e.message}`, type: 'error' })
    } finally {
      setLinesLoading(false)
    }
  }

  async function handleSave(skipStockCheck = false) {
    if (!form.seller_entity_id || !form.buyer_entity_id) return setToast({ message: 'Seller and Buyer are required', type: 'error' })
    if (lines.length === 0) return setToast({ message: 'At least one line item is required', type: 'error' })

    // CHANGED: every stock-affecting line must carry a product_id — otherwise
    // it's invisible to Actual Stock / Stock Position. Hard block.
    const missing = findLinesMissingProductId(lines)
    if (missing.length > 0) {
      return setToast({ message: `Line ${missing.map(l => l._lineNo).join(', ')}: select a product before saving — stock tracking needs it.`, type: 'error' })
    }

    // CHANGED: billing more than the seller actually has on hand is a
    // warning, not a hard block (they may dispatch from a fresh purchase
    // before the E-way Bill goes out) — same pattern as PI's stock check.
    if (!skipStockCheck) {
      const exceeding = findLinesExceedingStock(lines, stockMap)
      if (exceeding.length > 0) {
        setStockWarning(`${exceeding.length} line(s) bill more quantity than ${entities.find(e => e.id === form.seller_entity_id)?.short_name || 'the seller'} currently has in stock. Create this invoice anyway?`)
        return
      }
    }

    const computedLines = lines.map(l => computeLine(l, form.is_interstate))
    const totals = computeTotals(computedLines)
    setSaving(true)

    // CHANGED: invoice_no was previously never set here at all (not a hard
    // constraint failure — invoice_no is nullable on the live schema — but
    // every manually-created invoice was getting no invoice number). This
    // mirrors PI/PO: use the typed invoice_no, or suggest one via
    // suggestNextNo(). FY code computed directly from the invoice's own date
    // (Indian FY: Apr–Mar) — no financial_years lookup needed.
    const fyCode = fyCodeForDate(form.invoice_date)
    let invoiceNo = (form.invoice_no || '').trim()
    if (invoiceNo) {
      const { data: dup } = await supabase.from('invoices').select('id').ilike('invoice_no', invoiceNo).limit(1)
      if (dup?.length) { setSaving(false); return setToast({ message: `Invoice number "${invoiceNo}" is already in use`, type: 'error' }) }
    } else {
      const sellerEntity = entities.find(e => e.id === form.seller_entity_id)
      invoiceNo = await suggestNextNo({ table: 'invoices', noCol: 'invoice_no', entityShort: sellerEntity?.short_name || sellerEntity?.name, fyCode })
    }

    const payload = {
      ...form,
      ...totals,
      invoice_no: invoiceNo,
      outstanding_amount: totals.total_amount,
      paid_amount: 0,
    }
    // CHANGED: drop every optional FK/date field that's blank. A blank date
    // ('') is invalid for a Postgres date column ("invalid input syntax for
    // type date") — blank means "not set", so omit it and let the column
    // default to NULL. eway_bill_date in particular was previously left in the
    // payload as '' on every create (E-way Bill is filled in later), which is
    // what caused this save to fail.
    for (const k of ['order_id', 'order_leg_id', 'pi_id', 'po_id', 'due_date', 'eway_bill_date', 'einvoice_ack_date']) {
      if (!payload[k]) delete payload[k]
    }
    if (!payload.tds_amount)    delete payload.tds_amount
    if (!payload.tcs_amount)    delete payload.tcs_amount

    const { data: inv, error } = await supabase.from('invoices').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }

    // Insert lines — strip UI-only helper fields (_id etc.) that aren't real
    // columns; sending them was making this insert fail. Its result was also
    // never checked before, so the invoice header would exist with zero lines
    // and nobody would know — that's exactly why stock never moved.
    const linesPayload = computedLines.map((l, i) => toInvoiceLinePayload(l, inv.id, i + 1))
    const { error: linesErr } = await supabase.from('invoice_lines').insert(linesPayload)
    if (linesErr) {
      setSaving(false)
      return setToast({ message: `Invoice ${invoiceNo} was created, but its line items failed to save: ${linesErr.message}. Delete this invoice and try again.`, type: 'error' })
    }

    // CHANGED: Insert TDS/TCS entries
    if (tdsEntries.length > 0) {
      const tdsPayload = tdsEntries
        .filter(r => r.base_amount && parseFloat(r.base_amount) > 0)
        .map(r => {
          const base   = Math.round(parseFloat(r.base_amount))
          const amount = Math.round(base * parseFloat(r.rate) / 100)
          return {
            invoice_id:            inv.id,
            entry_type:            r.type,
            section_code:          r.section,
            section_desc:          TDS_SECTION_LABELS[r.section] || r.section,
            deducted_by_entity_id: r.type === 'tds' ? form.buyer_entity_id  : form.seller_entity_id,
            deductee_entity_id:    r.type === 'tds' ? form.seller_entity_id : form.buyer_entity_id,
            base_amount:           base,
            rate:                  parseFloat(r.rate),
            amount,
          }
        })
      if (tdsPayload.length > 0) {
        const { error: tdsErr } = await supabase.from('tds_tcs_entries').insert(tdsPayload)
        if (tdsErr) setToast({ message: `Invoice ${invoiceNo} saved, but TDS/TCS entries failed to save: ${tdsErr.message}`, type: 'error' })
      }
    }

    // Mark PI as converted if applicable
    if (form.pi_id) {
      await supabase.from('proforma_invoices').update({ status: 'converted', converted_to_invoice_id: inv.id }).eq('id', form.pi_id)
    }

    // CHANGED: no buyer-side purchase entry is created here anymore. Goods
    // haven't moved yet at submit time (physical movement only happens once
    // an E-way Bill is generated — see the E-way Bill save handler in
    // InvoiceDetail), so creating the buyer's purchase-register mirror this
    // early would record it before the transaction is real. It's now
    // auto-created (and posted, not draft) the moment the E-way Bill is
    // saved on this invoice.

    setSaving(false)
    navigate(`/invoices/${inv.id}`)
  }

  return (
    <div>
      <button onClick={() => navigate('/invoices')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>← Invoices</button>
      <PageHeader title={fromPiId ? 'Convert PI to Invoice' : 'New Invoice'} />
      <div style={{background:'#e8f3ec',border:'1px solid #b8dfca',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#1a5c30',marginBottom:'16px'}}>📅 Will be created under <strong>{currentFYLabel()}</strong> — stock stays with the seller until an E-way Bill is generated on this invoice. Once it is, stock moves to the buyer and (for internal buyers) their purchase entry is created automatically — no manual entry needed.</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '100%' }}>
        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Invoice Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '12px' }}>
            <FormRow label='Invoice Date' required>
              <Input type='date' value={form.invoice_date} onChange={e => setF('invoice_date', e.target.value)} />
            </FormRow>
            <FormRow label='Invoice Number' hint='Leave blank to auto-generate'>
              <Input value={form.invoice_no} onChange={e => setF('invoice_no', e.target.value)} placeholder='Auto-generated if blank' />
            </FormRow>
            <FormRow label='Due Date'>
              <Input type='date' value={form.due_date} onChange={e => setF('due_date', e.target.value)} />
            </FormRow>
            <FormRow label='Type'>
              <Select value={form.invoice_type} onChange={e => setF('invoice_type', e.target.value)}>
                <option value='sales'>Sales Invoice</option>
                <option value='purchase'>Purchase Invoice</option>
              </Select>
            </FormRow>
            <FormRow label='Seller Entity' required hint={sellerEntityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.seller_entity_id} onChange={e => setF('seller_entity_id', e.target.value)} disabled={sellerEntityFrozen}>
                <option value=''>Select seller</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Buyer Entity' required>
              <Select value={form.buyer_entity_id} onChange={e => setF('buyer_entity_id', e.target.value)}>
                <option value=''>Select buyer</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Tax Type' hint='Auto-detected from state codes'>
              <Select value={form.is_interstate ? '1' : '0'} onChange={e => setF('is_interstate', e.target.value === '1')}>
                <option value='0'>Local — Same State (CGST + SGST)</option>
                <option value='1'>Interstate — Different State (IGST)</option>
              </Select>
            </FormRow>
            <FormRow label='Linked PI'>
              <Select value={form.pi_id} onChange={e => handlePISelect(e.target.value)}>
                <option value=''>No PI</option>
                {pis
                  .filter(p => (!form.order_id || p.order_id === form.order_id) && (p.id === form.pi_id || !usedPiIds.has(p.id)))
                  .map(p => <option key={p.id} value={p.id}>{p.pi_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Linked PO'>
              <Select value={form.po_id} onChange={e => handlePOSelect(e.target.value)}>
                <option value=''>No PO</option>
                {pos
                  .filter(p => (!form.order_id || p.order_id === form.order_id) && (p.id === form.po_id || !usedPoIds.has(p.id)))
                  .map(p => <option key={p.id} value={p.id}>{p.po_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Order'>
              <Select value={form.order_id} onChange={e => { setF('order_id', e.target.value); loadLegs(e.target.value) }}>
                <option value=''>No order</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </FormRow>
          </div>
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Line Items' />
          {linesLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#fff8e6', border: '1px solid #e6c877', borderRadius: '6px', padding: '10px 14px', fontSize: '13px', color: '#7a5000', marginTop: '12px' }}>
              <span style={{ width: 16, height: 16, border: '2px solid #d9b24d', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
              Loading line items from the linked PI/PO…
            </div>
          )}
          <div style={{ marginTop: '12px' }}>
            <LineItemsEditor lines={lines} setLines={setLines} interstate={form.is_interstate} hsnMap={hsnMap} stockMap={stockMap} products={products} />
          </div>
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='E-Invoice (GST Portal)' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '12px' }}>
            <FormRow label='IRN'>
              <Input value={form.einvoice_irn} onChange={e => setF('einvoice_irn', e.target.value)} placeholder='Invoice Reference Number' />
            </FormRow>
            <FormRow label='Ack No'>
              <Input value={form.einvoice_ack_no} onChange={e => setF('einvoice_ack_no', e.target.value)} />
            </FormRow>
            <FormRow label='Ack Date'>
              <Input type='date' value={form.einvoice_ack_date} onChange={e => setF('einvoice_ack_date', e.target.value)} />
            </FormRow>
          </div>
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Billing, Shipping & E-way Bill' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
            <FormRow label='Bill From'>
              <Input value={form.bill_from} onChange={e => setF('bill_from', e.target.value)} placeholder='Billing address of seller' />
            </FormRow>
            <FormRow label='Bill To'>
              <Input value={form.bill_to} onChange={e => setF('bill_to', e.target.value)} placeholder='Billing address of buyer' />
            </FormRow>
            <FormRow label='Ship From'>
              <Input value={form.ship_from} onChange={e => setF('ship_from', e.target.value)} placeholder='Dispatch location' />
            </FormRow>
            <FormRow label='Ship To'>
              <Input value={form.ship_to} onChange={e => setF('ship_to', e.target.value)} placeholder='Delivery location' />
            </FormRow>
            <FormRow label='E-way Bill No'>
              <Input value={form.eway_bill_no} onChange={e => setF('eway_bill_no', e.target.value)} placeholder='EWB number' />
            </FormRow>
            <FormRow label='E-way Bill Date' hint='Can differ from invoice date'>
              <Input type='date' value={form.eway_bill_date} onChange={e => setF('eway_bill_date', e.target.value)} />
            </FormRow>
          </div>
        </Card>

        {/* CHANGED: TDS/TCS section */}
        <Card style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <SectionDivider label='TDS / TCS (optional)' />
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              <Btn size='sm' variant='ghost' onClick={() => addTdsRow('tds')}>+ TDS</Btn>
              <Btn size='sm' variant='ghost' onClick={() => addTdsRow('tcs')}>+ TCS</Btn>
            </div>
          </div>
          {tdsEntries.length === 0 ? (
            <div style={{ fontSize: '12px', color: C.textMuted, padding: '8px 0' }}>No TDS/TCS entries. Click + TDS or + TCS to add.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {tdsEntries.map(row => {
                const base   = parseFloat(row.base_amount) || 0
                const amount = Math.round(base * parseFloat(row.rate) / 100)
                return (
                  <div key={row._id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr auto', gap: '10px', alignItems: 'center', padding: '10px 12px', background: C.bg, borderRadius: '6px', border: `1px solid ${C.border}` }}>
                    <Badge status={row.type === 'tcs' ? 'export' : 'domestic'} label={row.type.toUpperCase()} />
                    <Select value={row.section} onChange={e => updateTdsRow(row._id, 'section', e.target.value)}>
                      {TDS_SECTIONS.map(s => <option key={s} value={s}>{s} — {TDS_SECTION_LABELS[s]}</option>)}
                    </Select>
                    <FormRow label='Base Amount (₹)'>
                      <Input type='number' value={row.base_amount} onChange={e => updateTdsRow(row._id, 'base_amount', e.target.value)} placeholder='0' />
                    </FormRow>
                    <FormRow label={`Rate % → ₹${amount.toLocaleString('en-IN')}`}>
                      <Input type='number' step='0.01' value={row.rate} onChange={e => updateTdsRow(row._id, 'rate', e.target.value)} />
                    </FormRow>
                    <button onClick={() => removeTdsRow(row._id)} style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: '18px', padding: '0 4px' }}>×</button>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Notes' />
          <div style={{ marginTop: '12px' }}>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </div>
        </Card>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Btn variant='ghost' onClick={() => navigate('/invoices')}>Cancel</Btn>
          <Btn onClick={() => handleSave(false)} disabled={saving}>{saving ? 'Saving…' : 'Create Invoice'}</Btn>
        </div>
      </div>

      <ConfirmModal open={!!stockWarning} onClose={() => setStockWarning(null)}
        onConfirm={() => { setStockWarning(null); handleSave(true) }}
        title='Billed Quantity Exceeds Stock' message={stockWarning || ''} danger />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Invoice Detail ───────────────────────────────────────────────────────────
function InvoiceDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const canDelete = hasFullAccess(profile)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [inv, setInv]     = useState(null)
  const [lines, setLines] = useState([])
  const [tdsRows, setTdsRows] = useState([])  // CHANGED: TDS/TCS entries
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  // CHANGED: inline edit state for EWB/Challan and IRN sections
  const [ewbEdit, setEwbEdit]   = useState(false)
  const [ewbForm, setEwbForm]   = useState({})
  const [irnEdit, setIrnEdit]   = useState(false)
  const [irnForm, setIrnForm]   = useState({})
  const [sectSaving, setSectSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: i }, { data: ls }, { data: tds }] = await Promise.all([
      supabase.from('invoices')
        // CHANGED: `type` on buyer/seller is needed to decide whether an
        // auto purchase-mirror entry should be created when the E-way Bill
        // is saved (only for internal group/associate entities, not
        // external customers/vendors).
        .select('*, seller:seller_entity_id(name,short_name,gstin,state_code,address,city,type), buyer:buyer_entity_id(name,short_name,gstin,state_code,address,city,type), orders(name)')
        .eq('id', id).single(),
      // CHANGED: a plain .select() caps at PostgREST's default 1000-row
      // response — an invoice with more line items than that silently lost
      // the rest, undercounting totals here vs the DB-side total_qty/
      // total_amount columns (recomputed directly in Postgres, no REST cap).
      fetchAllPages(() => supabase.from('invoice_lines').select('*').eq('invoice_id', id).order('line_no')),
      supabase.from('tds_tcs_entries').select('*').eq('invoice_id', id),  // CHANGED
    ])
    setInv(i)
    setLines(ls || [])
    setTdsRows(tds || [])  // CHANGED
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function updateStatus(status) {
    // CHANGED: if this invoice's E-way Bill was already generated, cancelling
    // it now needs to reverse the buyer-side purchase mirror too, and leave
    // a visible trail — the goods have physically moved already, so this
    // needs a human to notice and reconcile, not just quietly disappear.
    // Actual stock itself reverses automatically: the live stock calc
    // excludes any 'cancelled' invoice regardless of E-way Bill status, so
    // no separate stock reversal step is needed here.
    const cancellingAfterEway = status === 'cancelled' && !!inv.eway_bill_no
    const { error } = await supabase.from('invoices').update({ status, updated_at: new Date() }).eq('id', id)
    if (error) return setToast({ message: error.message, type: 'error' })

    if (cancellingAfterEway) {
      await supabase.from('invoices').update({ status: 'cancelled', updated_at: new Date() })
        .eq('source_invoice_id', id).eq('invoice_type', 'purchase')
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await supabase.from('notifications').insert({
          user_id:           user.id,
          title:             'Invoice cancelled after E-way Bill',
          message:           `${inv.invoice_no || id.slice(0,8)} was cancelled after its E-way Bill (${inv.eway_bill_no}) was already generated — stock reverses from ${inv.buyer?.name || 'buyer'} back to ${inv.seller?.name || 'seller'}. Verify the physical goods movement matches.`,
          notification_type: 'invoice_cancelled_after_eway',
          source_type:       'invoices',
          source_id:         id,
          entity_id:         inv.seller_entity_id,
        })
      }
    }

    setToast({ message: `Invoice ${status}`, type: 'success' })
    load()
  }

  async function handleDelete() {
    setDeleting(true)
    const { error } = await supabase.from('invoices').update({ is_deleted: true }).eq('id', id)
    // Deleting an invoice that was converted from a PI left the source PI
    // stuck on status 'converted' pointing at a now soft-deleted invoice —
    // reopen it so it shows up as needing conversion again.
    if (!error && inv?.pi_id) {
      await supabase.from('proforma_invoices').update({ status: 'accepted', converted_to_invoice_id: null }).eq('id', inv.pi_id)
    }
    setDeleting(false); setConfirmDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    navigate('/invoices')
  }

  // CHANGED: save EWB + Challan fields
  function openEwbEdit() {
    setEwbForm({
      eway_bill_no:     inv.eway_bill_no     || '',
      eway_bill_date:   inv.eway_bill_date   || '',
      challan_no:       inv.challan_no       || '',
      vehicle_no:       inv.vehicle_no       || '',
      transporter_name: inv.transporter_name || '',
    })
    setEwbEdit(true)
  }
  async function saveEwbForm() {
    setSectSaving(true)
    const wasEwaySet = !!inv.eway_bill_no
    const { error } = await supabase.from('invoices').update({
      eway_bill_no:     ewbForm.eway_bill_no     || null,
      eway_bill_date:   ewbForm.eway_bill_date   || null,
      challan_no:       ewbForm.challan_no       || null,
      vehicle_no:       ewbForm.vehicle_no       || null,
      transporter_name: ewbForm.transporter_name || null,
      updated_at:       new Date(),
    }).eq('id', id)
    if (error) { setSectSaving(false); return setToast({ message: error.message, type: 'error' }) }

    // CHANGED: this is the actual physical-movement event — stock moves from
    // seller to buyer from here on (see stock.js), and for internal buyers
    // their purchase-register entry is auto-completed right now too, with
    // zero manual entry required on their side.
    if (!wasEwaySet && ewbForm.eway_bill_no) {
      const updatedInv = { ...inv, eway_bill_no: ewbForm.eway_bill_no, eway_bill_date: ewbForm.eway_bill_date || null }
      const { error: mirrorErr } = await autoCompletePurchaseMirror(updatedInv, lines)
      if (mirrorErr) setToast({ message: `E-way Bill saved, but the buyer purchase entry failed: ${mirrorErr.message}`, type: 'error' })
      // CHANGED: e-way bill generation IS the physical stock-movement event —
      // sync the leg's movement_status so it doesn't stay stuck on "pending"
      // (previously only updated via a manual edit on the leg that nobody
      // remembered to make, so it drifted out of sync with the Stock column).
      // cargo_status is the separate field Document Database actually shows —
      // it was never touched here either, so a leg with an invoice + EWB
      // already on file could still read "awaiting cargo" forever.
      if (inv.order_leg_id) {
        await supabase.from('order_legs').update({ movement_status: 'delivered', cargo_status: 'cargo_dispatched' }).eq('id', inv.order_leg_id)
      }
    }

    setSectSaving(false)
    setEwbEdit(false)
    setToast({ message: 'E-way Bill & Challan saved', type: 'success' })
    load()
  }

  // CHANGED: save IRN fields
  function openIrnEdit() {
    setIrnForm({
      einvoice_irn:      inv.einvoice_irn      || '',
      einvoice_ack_no:   inv.einvoice_ack_no   || '',
      einvoice_ack_date: inv.einvoice_ack_date || '',
      einvoice_qr_code:  inv.einvoice_qr_code  || '',
    })
    setIrnEdit(true)
  }
  async function saveIrnForm() {
    setSectSaving(true)
    const { error } = await supabase.from('invoices').update({
      einvoice_irn:      irnForm.einvoice_irn      || null,
      einvoice_ack_no:   irnForm.einvoice_ack_no   || null,
      einvoice_ack_date: irnForm.einvoice_ack_date || null,
      einvoice_qr_code:  irnForm.einvoice_qr_code  || null,
      updated_at:        new Date(),
    }).eq('id', id)
    setSectSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setIrnEdit(false)
    setToast({ message: 'E-Invoice IRN saved', type: 'success' })
    load()
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!inv)    return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>Invoice not found.</div>

  // 'paid' wasn't locked before, only 'cancelled' — added here since a paid
  // invoice's E-way Bill/IRN sections could otherwise still be changed after
  // settlement, which is a live-data-integrity risk (an EWB save also moves
  // stock, which shouldn't happen for a settled or cancelled invoice).
  // Master/admin can still override the lock when a correction is genuinely needed.
  const isLocked = !hasFullAccess(profile) && ['cancelled', 'paid'].includes(inv.status)

  return (
    <div>
      <button onClick={() => navigate('/invoices')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>← Invoices</button>
      <PageHeader
        title={inv.invoice_no || `Invoice — ${fmtDate(inv.invoice_date)}`}
        subtitle={`${inv.seller?.name} → ${inv.buyer?.name} · ${fmtDate(inv.invoice_date)}`}
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {inv.status === 'draft' && <Btn size='sm' onClick={() => updateStatus('submitted')}>Submit</Btn>}
            {inv.status === 'submitted' && <Btn size='sm' variant='ghost' onClick={() => updateStatus('paid')}>Mark Paid</Btn>}
            {!['cancelled','paid'].includes(inv.status) && <Btn size='sm' variant='ghost' onClick={() => setConfirmCancel(true)} style={{ color: C.danger }}>Cancel</Btn>}
            {canDelete && <Btn size='sm' variant='danger' onClick={() => setConfirmDelete(true)} disabled={deleting}>{deleting?'Deleting…':'Delete'}</Btn>}
            <Badge status={inv.invoice_type} label={inv.invoice_type === 'sales' ? 'Sales Invoice' : 'Purchase Invoice'} />
            <Badge status={inv.status} />
            {(() => { const s = getInvoiceLifecycleStage(inv); return <Badge status={s.key} label={s.label} /> })()}
          </div>
        }
      />

      {/* Seller / Buyer */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Seller</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{inv.seller?.name}</div>
          {inv.seller?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {inv.seller.gstin}</div>}
          {inv.seller?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{inv.seller.city}</div>}
        </Card>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Buyer</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{inv.buyer?.name}</div>
          {inv.buyer?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {inv.buyer.gstin}</div>}
          {inv.buyer?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{inv.buyer.city}</div>}
        </Card>
      </div>

      {/* Details strip */}
      <div style={{ display: 'flex', gap: '20px', marginBottom: '20px', flexWrap: 'wrap', fontSize: '13px' }}>
        <div><span style={{ color: C.textMuted }}>Date:</span> <strong>{fmtDate(inv.invoice_date)}</strong></div>
        {inv.due_date && <div>
          <span style={{ color: C.textMuted }}>Due:</span>{' '}
          <strong style={{ color: inv.due_date < new Date().toISOString().slice(0,10) && inv.status !== 'paid' ? C.danger : C.text }}>
            {fmtDate(inv.due_date)}
          </strong>
        </div>}
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={inv.is_interstate ? 'export' : 'domestic'} label={inv.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /></div>
        {inv.einvoice_irn && <div><span style={{ color: C.textMuted }}>IRN:</span> <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{inv.einvoice_irn}</span></div>}
        {inv.orders?.name && <div><span style={{ color: C.textMuted }}>Order:</span> <strong>{inv.orders.name}</strong></div>}
      </div>

      {/* Outstanding */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Invoice Total' value={formatINR(inv.total_amount)} />
        <StatCard label='Paid' value={formatINR(inv.paid_amount)} color={C.success} />
        <StatCard label='Outstanding' value={formatINR(inv.outstanding_amount)} color={inv.outstanding_amount > 0 ? C.warning : C.success} />
      </div>

      <Card>
        <LineItemsEditor lines={lines.map(l => ({ ...l, _id: l.id }))} setLines={() => {}} interstate={inv.is_interstate} readOnly />
      </Card>

      {(inv.bill_from || inv.bill_to || inv.ship_from || inv.ship_to || inv.eway_bill_no) && (
        <div style={{ marginTop: '12px', padding: '12px 14px', background: '#f8f4ee', borderRadius: '6px', border: `1px solid ${C.border}`, fontSize: '13px' }}>
          <div style={{ fontWeight: 700, marginBottom: '8px', color: C.textMid }}>Billing & Shipping</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px' }}>
            {inv.bill_from && <div><span style={{ color: C.textMuted }}>Bill From:</span> {inv.bill_from}</div>}
            {inv.bill_to   && <div><span style={{ color: C.textMuted }}>Bill To:</span> {inv.bill_to}</div>}
            {inv.ship_from && <div><span style={{ color: C.textMuted }}>Ship From:</span> {inv.ship_from}</div>}
            {inv.ship_to   && <div><span style={{ color: C.textMuted }}>Ship To:</span> {inv.ship_to}</div>}
          </div>
        </div>
      )}

      {/* CHANGED: E-way Bill & Challan section */}
      <div style={{ marginTop: '12px', border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: '13px', color: C.textMid }}>
            🚛 E-way Bill & Challan
            {(inv.eway_bill_no || inv.challan_no) && (
              <span style={{ marginLeft: 8, fontSize: '11px', fontWeight: 400, color: C.success }}>✓ Filled</span>
            )}
          </div>
          {!ewbEdit && !isLocked && (
            <Btn size='sm' variant='ghost' onClick={openEwbEdit}>
              {(inv.eway_bill_no || inv.challan_no) ? 'Edit' : '+ Add'}
            </Btn>
          )}
        </div>
        {ewbEdit && !isLocked ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {!inv.eway_bill_no && inv.invoice_type === 'sales' && (
              <div style={{background:'#fff3cc',border:'1px solid #e6c040',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#7a5000'}}>
                📦 Saving an E-way Bill number here moves stock now: {lines.length} line item(s) totalling{' '}
                <strong>{lines.reduce((s,l)=>s+Number(l.qty||0),0).toLocaleString('en-IN')}</strong> unit(s) leave{' '}
                <strong>{inv.seller?.short_name || inv.seller?.name}</strong> and land with{' '}
                <strong>{inv.buyer?.short_name || inv.buyer?.name}</strong>
                {inv.buyer?.type !== 'external' && <> — {inv.buyer?.short_name || inv.buyer?.name}'s purchase entry is auto-completed too</>}.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormRow label='EWB Number'>
                <Input value={ewbForm.eway_bill_no} onChange={e => setEwbForm(f => ({...f, eway_bill_no: e.target.value}))} placeholder='e.g. 421234567890' />
              </FormRow>
              <FormRow label='EWB Date'>
                <Input type='date' value={ewbForm.eway_bill_date} onChange={e => setEwbForm(f => ({...f, eway_bill_date: e.target.value}))} />
              </FormRow>
              <FormRow label='Challan No'>
                <Input value={ewbForm.challan_no} onChange={e => setEwbForm(f => ({...f, challan_no: e.target.value}))} placeholder='Transporter challan number' />
              </FormRow>
              <FormRow label='Vehicle No'>
                <Input value={ewbForm.vehicle_no} onChange={e => setEwbForm(f => ({...f, vehicle_no: e.target.value}))} placeholder='e.g. KA01AB1234' />
              </FormRow>
              <FormRow label='Transporter Name' style={{ gridColumn: '1 / -1' }}>
                <Input value={ewbForm.transporter_name} onChange={e => setEwbForm(f => ({...f, transporter_name: e.target.value}))} />
              </FormRow>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Btn variant='ghost' onClick={() => setEwbEdit(false)}>Cancel</Btn>
              <Btn onClick={saveEwbForm} disabled={sectSaving}>{sectSaving ? 'Saving…' : 'Save'}</Btn>
            </div>
          </div>
        ) : (inv.eway_bill_no || inv.challan_no || inv.vehicle_no || inv.transporter_name) ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0', fontSize: '13px' }}>
            {[
              ['EWB No',       inv.eway_bill_no],
              ['EWB Date',     fmtDate(inv.eway_bill_date)],
              ['Challan No',   inv.challan_no],
              ['Vehicle No',   inv.vehicle_no],
              ['Transporter',  inv.transporter_name],
            ].filter(([, v]) => v).map(([label, val]) => (
              <div key={label} style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                <span style={{ color: C.textMuted }}>{label}: </span>
                <strong>{val}</strong>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: '12px 14px', fontSize: '12px', color: C.textMuted }}>
            {isLocked
              ? `No E-way Bill or Challan details entered. Invoice is ${inv.status} — locked from further edits.`
              : <>No E-way Bill or Challan details entered. Click <strong>+ Add</strong> to fill in.</>}
          </div>
        )}
      </div>

      {/* CHANGED: E-Invoice IRN section */}
      <div style={{ marginTop: '12px', border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: '13px', color: C.textMid }}>
            📄 E-Invoice IRN
            {inv.einvoice_irn && inv.einvoice_ack_no && (
              <span style={{ marginLeft: 8, fontSize: '11px', fontWeight: 400, color: C.success }}>✓ Filled</span>
            )}
          </div>
          {!irnEdit && !isLocked && (
            <Btn size='sm' variant='ghost' onClick={openIrnEdit}>
              {(inv.einvoice_irn || inv.einvoice_ack_no) ? 'Edit' : '+ Add'}
            </Btn>
          )}
        </div>
        {irnEdit && !isLocked ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <FormRow label='IRN (Invoice Reference Number)'>
              <Input
                value={irnForm.einvoice_irn}
                onChange={e => setIrnForm(f => ({...f, einvoice_irn: e.target.value}))}
                placeholder='64-character hash from GST portal'
                style={{ fontFamily: 'monospace', fontSize: '12px' }}
              />
            </FormRow>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormRow label='Acknowledgement No'>
                <Input
                  value={irnForm.einvoice_ack_no}
                  onChange={e => setIrnForm(f => ({...f, einvoice_ack_no: e.target.value}))}
                  placeholder='Ack number'
                  style={{ fontFamily: 'monospace' }}
                />
              </FormRow>
              <FormRow label='Acknowledgement Date'>
                <Input type='date' value={irnForm.einvoice_ack_date} onChange={e => setIrnForm(f => ({...f, einvoice_ack_date: e.target.value}))} />
              </FormRow>
            </div>
            <FormRow label='QR Code Data'>
              <Textarea
                value={irnForm.einvoice_qr_code}
                onChange={e => setIrnForm(f => ({...f, einvoice_qr_code: e.target.value}))}
                rows={3}
                placeholder='Paste QR code data from signed e-invoice PDF'
                style={{ fontFamily: 'monospace', fontSize: '11px' }}
              />
            </FormRow>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Btn variant='ghost' onClick={() => setIrnEdit(false)}>Cancel</Btn>
              <Btn onClick={saveIrnForm} disabled={sectSaving}>{sectSaving ? 'Saving…' : 'Save'}</Btn>
            </div>
          </div>
        ) : (inv.einvoice_irn || inv.einvoice_ack_no) ? (
          <div style={{ fontSize: '13px' }}>
            {inv.einvoice_irn && (
              <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                <div style={{ fontSize: '10px', color: C.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>IRN</div>
                <div style={{ fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all', color: C.text }}>{inv.einvoice_irn}</div>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              {inv.einvoice_ack_no && (
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                  <span style={{ color: C.textMuted }}>Ack No: </span><strong style={{ fontFamily: 'monospace' }}>{inv.einvoice_ack_no}</strong>
                </div>
              )}
              {inv.einvoice_ack_date && (
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${C.border}` }}>
                  <span style={{ color: C.textMuted }}>Ack Date: </span><strong>{fmtDate(inv.einvoice_ack_date)}</strong>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ padding: '12px 14px', fontSize: '12px', color: C.textMuted }}>
            {isLocked
              ? `No IRN entered. Invoice is ${inv.status} — locked from further edits.`
              : <>No IRN entered yet. Click <strong>+ Add</strong> after generating from GST portal.</>}
          </div>
        )}
      </div>
      {inv.notes && <div style={{ marginTop: '12px', fontSize: '13px', color: C.textSoft }}><strong>Notes:</strong> {inv.notes}</div>}

      <div style={{marginTop:'12px',marginBottom:'16px'}}>
        <Btn size='sm' variant='ghost' onClick={()=>downloadCSV(`${inv.invoice_no||'invoice'}_lines_${today()}.csv`,['line_no','description','hsn_code','qty','unit','rate','gst_rate','taxable_amount','cgst_amount','sgst_amount','igst_amount','total_amount'],lines)}>↓ Export Lines CSV</Btn>
      </div>

      {/* CHANGED: TDS/TCS display */}
      {tdsRows.length > 0 && (
        <div style={{ marginTop: '12px', border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', background: C.bg, fontWeight: 700, fontSize: '13px', color: C.textMid }}>TDS / TCS Entries</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr>{['Type','Section','Description','Base Amount','Rate %','Amount','Paid'].map(h => (
                <th key={h} style={{ padding: '7px 12px', textAlign: h==='Base Amount'||h==='Rate %'||h==='Amount'?'right':'left', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', background: C.bg, borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {tdsRows.map((r,i) => (
                <tr key={r.id} style={{ background: i%2===0?C.surface:'#faf6ed' }}>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}><Badge status={r.entry_type==='tcs'?'export':'domestic'} label={r.entry_type.toUpperCase()} /></td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, fontFamily: 'monospace', fontWeight: 600 }}>{r.section_code}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, color: C.textSoft }}>{r.section_desc || '—'}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right' }}>{formatINR(r.base_amount)}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right' }}>{r.rate}%</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontWeight: 700 }}>{formatINR(r.amount)}</td>
                  <td style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}><Badge status={r.is_paid?'paid':'pending'} label={r.is_paid?'Paid':'Pending'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: '20px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments
          sourceType='invoices'
          sourceId={inv.id}
          entityId={inv.seller_entity_id}
          entityName={inv.seller?.name || 'General'}
        />
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel Invoice'
        message={inv.eway_bill_no
          ? `Cancel this invoice? Its E-way Bill (${inv.eway_bill_no}) was already generated — stock will reverse from ${inv.buyer?.name || 'the buyer'} back to ${inv.seller?.name || 'the seller'}, and the buyer's auto-created purchase entry will be cancelled too.`
          : 'Cancel this invoice? No E-way Bill has been generated yet, so no stock has moved — nothing to reverse.'}
        danger />
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={handleDelete}
        title='Delete Invoice' message={`Delete ${inv.invoice_no || 'this invoice'}? This cannot be undone.`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function Invoices() {
  return (
    <Routes>
      <Route index         element={<InvoiceList />} />
      <Route path='new'    element={<NewInvoice />} />
      <Route path=':id'    element={<InvoiceDetail />} />
    </Routes>
  )
}
