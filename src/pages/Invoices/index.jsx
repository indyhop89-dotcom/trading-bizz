import { useState, useEffect, useCallback } from 'react'
import { Route, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { fetchAllPages } from '../../utils/query'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard, CsvFileDrop, MultiSelectDropdown,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, formatQty, toNum, round2, roundRupees } from '../../utils/money'
import { fmtDate, today, currentFYLabel, parseFlexibleDate, fyCodeForDate } from '../../utils/dates'
import { suggestNextNo } from '../../utils/numbering'
import { buildHSNMap, resolveGSTRate } from '../../utils/hsn'
import { calcLineTax } from '../../utils/tax'
import { withTimeout } from '../../utils/query'
import { cleanProductName, findProductByName, productKey } from '../../utils/products'
import DocumentAttachments from '../../components/DocumentAttachments'
import { downloadTemplate, downloadCSV, detectDelimiter, parseCSVLine } from '../../utils/csvTemplate'
import { useAuth } from '../../hooks/useAuth'
import { hasFullAccess } from '../../utils/roles'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { fetchEntityAvailableStock, findLinesMissingProductName, findLinesExceedingStock, getInvoiceLifecycleStage } from '../../utils/stock'
import { isOrderOpenForDocs, orderLabel } from '../../utils/orders'
import { PAYMENT_TERMS_OPTIONS, dueDateForTerms } from '../../utils/paymentTerms'
import { printDocument } from '../../utils/documentTemplate'
import { downloadDocumentExcel } from '../../utils/documentExcel'
import { isValidEwayBill, EWAY_BILL_ERROR } from '../../utils/validation'
// CHANGED: buildInvoiceDoc moved to utils/documentBuilders.js — see that
// file's header comment (same rationale as PI/index.jsx's buildPIDoc move).
import { buildInvoiceDoc } from '../../utils/documentBuilders'
// CHANGED: one PI/PO can now be billed across several invoices — see utils/docLinks.js.
import { fetchRemainingLines, syncLinkedDocStatus } from '../../utils/docLinks'
// CHANGED: vehicle / transporter / challan are now one row per vehicle (invoice_vehicles) — see utils/challans.js.
import InvoiceVehicles from '../../components/InvoiceVehicles'
import KeepListMounted from '../../components/KeepListMounted'

const INV_STATUSES = ['draft', 'submitted', 'partial', 'paid', 'cancelled']

// CHANGED: LineItemsEditor lines carry UI-only helper fields (_id, _cost_rate,
// _margin_pct, _hsn_*) that are NOT columns on invoice_lines. Sending them made
// the insert fail with "Could not find the '_id' column…", which — because the
// insert result wasn't checked before — silently left invoices with ZERO lines.
// That was the real root cause of stock never moving: an invoice with no lines
// moves no stock. This keeps only the real DB columns.
const INVOICE_LINE_COLUMNS = [
  'product_name', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate',
  'taxable_amount', 'cgst_rate', 'cgst_amount', 'sgst_rate', 'sgst_amount',
  'igst_rate', 'igst_amount', 'total_amount',
]
function toInvoiceLinePayload(computedLine, invoiceId, lineNo) {
  const out = { invoice_id: invoiceId, line_no: lineNo }
  for (const col of INVOICE_LINE_COLUMNS) if (computedLine[col] !== undefined) out[col] = computedLine[col]
  return out
}

const EMPTY_FORM = {
  // CHANGED: payment_terms drives due_date (see setF) — picking "Net 30 Days"
  // on a 2026-07-01 invoice auto-fills due_date 2026-07-31; the date stays
  // manually overridable after that.
  invoice_date: today(), due_date: '', payment_terms: '', invoice_type: 'sales', status: 'draft',
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
    payment_terms: inv.payment_terms || null,
    invoice_type: 'purchase',
    status: 'submitted',
    seller_entity_id: inv.seller_entity_id,
    buyer_entity_id: inv.buyer_entity_id,
    source_invoice_id: inv.id,
    pi_id: inv.pi_id || null,
    po_id: inv.po_id || null,
    order_id: inv.order_id || null,
    order_leg_id: inv.order_leg_id || null,
    is_interstate: inv.is_interstate,
    eway_bill_no: inv.eway_bill_no,
    eway_bill_date: inv.eway_bill_date || null,
    // CHANGED: was missing total_qty/round_off_amount entirely — the source
    // sales invoice already has both, so this mirror just showed a blank Qty
    // column and a $0 round-off instead of copying them across.
    total_qty: inv.total_qty,
    taxable_amount: inv.taxable_amount,
    cgst_amount: inv.cgst_amount,
    sgst_amount: inv.sgst_amount,
    igst_amount: inv.igst_amount,
    round_off_amount: inv.round_off_amount,
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
function InvoiceList({ refreshKey }) {
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
  const [statusFilter, setStatus] = useState([])
  // CHANGED: every list filter is multi-select — an empty array means "all".
  const [typeFilter, setType]   = useState([])
  const [sellerEntityFilter, setSellerEntityF] = useState([])
  const [buyerEntityFilter, setBuyerEntityF] = useState([])
  const [orderFilter, setOrderF] = useState([])
  const [orders, setOrders]     = useState([])
  const [toast, setToast]       = useState(null)
  const [csvModal, setCsvModal]   = useState(false)
  const [csvText, setCsvText]     = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  // CHANGED: needed so the CSV upload below can resolve each row's GST rate
  // from HSN master as of its own invoice_date (see handleCSV) instead of
  // taking the CSV's gst_rate column as literal truth, which silently
  // ignored HSN effective-dated rate changes.
  const [hsnMap, setHsnMap]     = useState(new Map())

  const load = useCallback(async (silent) => {
    if (silent !== true) setLoading(true)
    const [{ data: invs }, { data: es }, { data: ps }, { data: hsnRows }, { data: ords }] = await Promise.all([
      // CHANGED: hides the auto-generated buyer-side "purchase" mirror that
      // autoCompletePurchaseMirror() creates the moment a sales invoice gets
      // an E-way Bill — every real transaction was showing up twice (once as
      // the seller's Sales invoice, once as this auto-created duplicate),
      // which just reads as confusing noise in this list. Only the *auto*
      // mirrors are hidden (source_invoice_id set) — a Purchase invoice
      // created manually via the New Invoice form has no source_invoice_id
      // and still shows normally.
      supabase.from('invoices')
        .select('*, seller:seller_entity_id(name,short_name), buyer:buyer_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).neq('invoice_type', 'intercompany')
        .or('invoice_type.neq.purchase,source_invoice_id.is.null')
        .order('invoice_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      // CHANGED: for CSV product resolution below. Paginated — products can
      // exceed PostgREST's default 1000-row cap, which would otherwise
      // silently drop products past that point from CSV matching.
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate')),
      supabase.from('hsn_master').select('*').eq('is_active', true),
      supabase.from('orders').select('id,name,description').eq('is_deleted', false).order('name'),
    ])
    setInvoices(invs || [])
    setEntities(es || [])
    setProducts(ps || [])
    setHsnMap(buildHSNMap(hsnRows || []))
    setOrders(ords || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  // CHANGED: the list stays mounted while an invoice is open (KeepListMounted);
  // on coming back it re-fetches quietly so saved changes show, without
  // touching filters, search or scroll.
  useEffect(() => { if (refreshKey) load(true) }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

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

    // CHANGED: product identity is now NAME alone (migration
    // 046_product_name_as_key.sql) — no more HSN/rate/GST tie-breaking.
    // Resolve/auto-create products up front, across all groups — same
    // approach as Stock/Opening Stock's CSV handler. `allProducts` is a
    // local working copy so a product created mid-batch is immediately
    // visible to later rows in this same file.
    const allProducts = [...products]
    const findProduct = row => findProductByName(allProducts, row.product)
    const allRows = Object.values(groups).flatMap(g => g.lines)
    const missingKeys = new Set()
    const missingRows = []
    for (const r of allRows) {
      if (!r.product?.trim()) continue
      if (findProduct(r)) continue
      const k = productKey(r.product)
      if (missingKeys.has(k)) continue
      missingKeys.add(k); missingRows.push(r)
    }
    if (missingRows.length > 0) {
      const payloads = missingRows.map(src => ({ name: cleanProductName(src.product), hsn_code: src.hsn_code || null, gst_rate: toNum(src.gst_rate) || 18, unit: src.unit || 'Nos', default_rate: toNum(src.rate) || null, is_active: true }))
      const { data: newProducts, error: pErr } = await supabase.from('products').insert(payloads).select()
      if (pErr) {
        errors.push(`Could not auto-create ${missingRows.length} new product(s) — ${pErr.message}`)
      } else {
        allProducts.push(...(newProducts || []))
      }
    }

    for (const group of Object.values(groups)) {
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
      let dueDate = meta.due_date ? parseFlexibleDate(meta.due_date) : null
      if (meta.due_date && !dueDate) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: due_date "${meta.due_date}" is not a valid date`); continue }
      // CHANGED: optional payment_terms column — when due_date is blank, the
      // due date is derived from it (same rule as the form).
      const paymentTerms = (meta.payment_terms || '').trim() || null
      if (!dueDate && paymentTerms) dueDate = dueDateForTerms(invoiceDate, paymentTerms) || null

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
        // CHANGED: resolve GST rate from HSN master using this row's own
        // invoice_date (same as PI's CSV upload fix — see that file for the
        // full rationale) instead of taking the CSV's gst_rate column as
        // literal truth. Falls back to the CSV's own gst_rate (or 18) only
        // when HSN master has no resolvable rate.
        const resolved = r.hsn_code ? resolveGSTRate(r.hsn_code, rate, hsnMap, invoiceDate) : { gst_rate: null }
        const gstRate = resolved.gst_rate !== null ? resolved.gst_rate : (toNum(r.gst_rate) || 18)
        // CHANGED: use the shared calcLineTax (same math the interactive
        // editor uses via computeLine) instead of a separately duplicated
        // inline formula — see PI/index.jsx's handleCSV for the full
        // rationale.
        const tax = calcLineTax(taxable, gstRate, interstate)
        return { line_no: i+1, product_name: product?.name || null, description: r.description, hsn_code: r.hsn_code, qty, unit: r.unit||'Nos', rate, gst_rate: gstRate, taxable_amount: taxable, ...tax, total_amount: round2(taxable+tax.total_tax) }
      })
      if (lineErr) continue
      const rawTotals = invLines.reduce((acc, l) => ({ taxable_amount: acc.taxable_amount+l.taxable_amount, cgst_amount: acc.cgst_amount+l.cgst_amount, sgst_amount: acc.sgst_amount+l.sgst_amount, igst_amount: acc.igst_amount+l.igst_amount, total_amount: acc.total_amount+l.total_amount, total_qty: acc.total_qty+l.qty }), { taxable_amount:0,cgst_amount:0,sgst_amount:0,igst_amount:0,total_amount:0,total_qty:0 })
      // Round off to the nearest whole rupee at the header level only — see
      // computeTotals() in LineItemsEditor.jsx for why.
      const invPreciseSubtotal = round2(rawTotals.taxable_amount + rawTotals.cgst_amount + rawTotals.sgst_amount + rawTotals.igst_amount)
      const invFinalTotal = roundRupees(invPreciseSubtotal)
      const totals = { ...rawTotals, taxable_amount: round2(rawTotals.taxable_amount), cgst_amount: round2(rawTotals.cgst_amount), sgst_amount: round2(rawTotals.sgst_amount), igst_amount: round2(rawTotals.igst_amount), total_qty: round2(rawTotals.total_qty), total_amount: invFinalTotal, round_off_amount: round2(invFinalTotal - invPreciseSubtotal) }
      const { data: inv, error: invErr } = await supabase.from('invoices').insert({ invoice_no: invoiceNo, invoice_date: invoiceDate, invoice_type: meta.invoice_type||'sales', seller_entity_id: sellerE.id, buyer_entity_id: buyerE.id, is_interstate: interstate, due_date: dueDate, payment_terms: paymentTerms, notes: meta.notes||null, status: 'draft', outstanding_amount: totals.total_amount, paid_amount: 0, ...totals }).select().single()
      if (invErr) { errors.push(`Invoice ${meta.invoice_date} ${meta.seller_entity}→${meta.buyer_entity}: ${invErr.message}`); continue }
      const { error: invLineErr } = await supabase.from('invoice_lines').insert(invLines.map(l => ({ ...l, invoice_id: inv.id })))
      if (invLineErr) { errors.push(`Invoice ${invoiceNo}: header created but line items failed to save: ${invLineErr.message}`); continue }
      created++
    }
    setCsvSaving(false); setCsvResult({ created, errors }); load()
  }

  function handleExportCSV() {
    downloadCSV(`invoices_export_${today()}.csv`,['invoice_no','invoice_date','invoice_type','seller','buyer','tax_type','status','taxable_amount','total_amount','outstanding_amount'],filtered.map(i=>({invoice_no:i.invoice_no||'',invoice_date:i.invoice_date,invoice_type:i.invoice_type,seller:i.seller?.name||'',buyer:i.buyer?.name||'',tax_type:i.is_interstate?'Interstate':'Local',status:i.status,taxable_amount:i.taxable_amount||0,total_amount:i.total_amount||0,outstanding_amount:i.outstanding_amount||0})))
  }

  const filtered = invoices.filter(i => {
    const ms  = !search || (i.invoice_no || '').toLowerCase().includes(search.toLowerCase()) ||
      i.seller?.name?.toLowerCase().includes(search.toLowerCase()) ||
      i.buyer?.name?.toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter.length === 0 || statusFilter.includes(i.status)
    const mt  = typeFilter.length === 0 || typeFilter.includes(i.invoice_type)
    const mse = sellerEntityFilter.length === 0 || sellerEntityFilter.includes(i.seller_entity_id)
    const mbe = buyerEntityFilter.length === 0 || buyerEntityFilter.includes(i.buyer_entity_id)
    const mo  = orderFilter.length === 0 || orderFilter.includes(i.order_id)
    // CHANGED: dateFrom/dateTo inputs were rendered but never actually
    // applied — every invoice matched regardless of the date range picked.
    const mdf = !dateFrom || i.invoice_date >= dateFrom
    const mdt = !dateTo   || i.invoice_date <= dateTo
    return ms && mst && mt && mse && mbe && mo && mdf && mdt
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
    // CHANGED: re-derived from whatever invoices are LEFT on each PI/PO
    // (a PI can carry several) instead of blindly reopening it.
    if (!error) {
      const piIds = [...new Set(invoices.filter(i => selected.has(i.id) && i.pi_id).map(i => i.pi_id))]
      for (const piId of piIds) await syncLinkedDocStatus('pi', piId, { allowReopen: true })
      // Same for any linked PO — otherwise a bulk-deleted invoice leaves its
      // PO stuck on 'completed'.
      const poIds = [...new Set(invoices.filter(i => selected.has(i.id) && i.po_id).map(i => i.po_id))]
      for (const poId of poIds) await syncLinkedDocStatus('po', poId, { allowReopen: true })
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
    { label: 'Order',   render: i => <span style={{ fontSize: '12px', color: C.textSoft }}>{i.orders?.name || '—'}</span> },
    { label: 'Due',     render: i => {
      if (!i.due_date) return <span style={{ color: C.textMuted }}>—</span>
      const overdue = new Date(i.due_date) < new Date() && i.status !== 'paid'
      return <span style={{ fontSize: '12px', color: overdue ? C.danger : C.text, fontWeight: overdue ? 700 : 400 }}>{fmtDate(i.due_date)}{overdue ? ' ⚠️' : ''}</span>
    }},
    { label: 'Qty', right: true, render: i => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{i.total_qty ? formatQty(i.total_qty) : '—'}</span> },
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
        <MultiSelectDropdown options={[{ value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }]} selected={typeFilter} onChange={setType} placeholder='All types' />
        <MultiSelectDropdown options={INV_STATUSES} selected={statusFilter} onChange={setStatus} placeholder='All statuses' />
        <MultiSelectDropdown options={entities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={sellerEntityFilter} onChange={setSellerEntityF} placeholder='All Seller Entities' capitalize={false} title='Seller Entity' />
        <MultiSelectDropdown options={entities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={buyerEntityFilter} onChange={setBuyerEntityF} placeholder='All Buyer Entities' capitalize={false} title='Buyer Entity' />
        <MultiSelectDropdown options={orders.map(o => ({ value: o.id, label: orderLabel(o) }))} selected={orderFilter} onChange={setOrderF} placeholder='All orders' capitalize={false} />
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
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>invoice_date,invoice_type,seller_entity,buyer_entity,is_interstate,product,description,hsn_code,qty,unit,rate,gst_rate,payment_terms,due_date,notes,invoice_no</code><br /><br />
            Multiple rows with same <strong>invoice_date + seller + buyer</strong> are grouped into one Invoice. <code>invoice_no</code> is optional — leave it blank to auto-generate, or supply your own (checked against existing invoices and other rows in this file). <strong>product</strong> is required — match an existing product name exactly, or a new product is auto-created from this row's hsn_code/gst_rate/rate/unit. Lines without a resolvable product are rejected (stock tracking depends on this link).
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          </FormRow>
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.created} invoices created.</strong>
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
  // CHANGED: a PI/PO can now be invoiced more than once (partial dispatches),
  // so the Linked PI/PO dropdowns no longer hide one just because an invoice
  // exists against it — only once it's FULLY invoiced (PI 'converted' / PO
  // 'completed', kept in step by syncLinkedDocStatus). Picking a part-invoiced
  // one prefills just the remaining quantity.
  // setter-only: loadLegs() populates this for a leg-picker that was never
  // wired into the form; kept as-is rather than guessing at the missing UI
  // or deleting a fetch something else may still depend on.
  // eslint-disable-next-line no-unused-vars
  const [legs, setLegs]         = useState([])
  const [lines, setLines]       = useState([])
  // CHANGED: lets the user pin round_off_amount to a specific value instead
  // of always auto-computing it — see computeTotals in LineItemsEditor.jsx.
  const [roundOffOverride, setRoundOffOverride] = useState('')
  // CHANGED: bulk-CSV correction for this in-progress invoice's lines —
  // same pattern as PI's edit-page "Load Into Editor", adapted to the
  // create flow since Invoices has no post-save edit mode. Useful right
  // after lines are auto-copied in from a linked PI/PO and just need bulk
  // corrections instead of hand-editing every row.
  const [linesCsvModal, setLinesCsvModal]     = useState(false)
  const [linesCsvText, setLinesCsvText]       = useState('')
  const [linesCsvResult, setLinesCsvResult]   = useState(null)
  const [linesCsvSaving, setLinesCsvSaving]   = useState(false)
  const [hsnMap, setHsnMap]     = useState(new Map())
  // CHANGED: the existing product catalog — feeds LineItemsEditor's product
  // dropdown so lines reference an existing product_id (the same one stock was
  // created under) instead of leaving product_id blank / forcing a new one.
  const [products, setProducts] = useState([])
  const [form, setForm]         = useState({ ...EMPTY_FORM, pi_id: fromPiId || '' })
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  // CHANGED: available stock for the seller entity — feeds LineItemsEditor's
  // stockMap so the seller can see (and be warned about) overselling past
  // what they actually have on hand. Was previously never wired in at all.
  const [stockMap, setStockMap] = useState({})
  const [stockWarning, setStockWarning] = useState(null)
  const [linesLoading, setLinesLoading] = useState(false)  // CHANGED: PI/PO line-item fetch in progress

  useEffect(() => {
    Promise.all([
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      // `status` so the Order dropdown can offer only still-open orders
      supabase.from('orders').select('id,name,description,status').eq('is_deleted', false).order('name'),
      supabase.from('proforma_invoices').select('id,pi_no,status,po_id,from_entity_id,to_entity_id,total_amount,order_id,order_leg_id').eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('purchase_orders').select('id,po_no,status,buyer_entity_id,seller_entity_id,order_id,order_leg_id').eq('is_deleted', false).order('po_date', { ascending: false }),
      supabase.from('hsn_master').select('*').eq('is_active', true),
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate').eq('is_active', true).order('name')),
    ]).then(([{ data: es }, { data: os }, { data: piData }, { data: poData }, { data: hsnRows }, { data: prods }]) => {
      setEntities(es || [])
      setOrders(os || [])
      setPIs(piData || [])
      setPOs(poData || [])
      setHsnMap(buildHSNMap(hsnRows || []))
      setProducts(prods || [])
    })
  }, [])

  // Pre-fill from PI if coming from convert button
  useEffect(() => {
    if (!fromPiId || !pis.length) return
    const pi = pis.find(p => p.id === fromPiId)
    if (!pi) return
    setF('seller_entity_id', pi.from_entity_id)
    setF('buyer_entity_id',  pi.to_entity_id)
    if (pi.po_id) setF('po_id', pi.po_id) // CHANGED: carry the PI's PO across — see handlePISelect
    // Load PI lines
    // CHANGED: only what's still left to invoice on this PI (see
    // prefillFromSource) — it may already be part-invoiced. Tax type is
    // derived from the PI's own entities here because the setF() calls
    // above haven't landed in `form` yet.
    const se = entities.find(e => e.id === pi.from_entity_id)
    const be = entities.find(e => e.id === pi.to_entity_id)
    prefillFromSource('pi', fromPiId, pi.pi_no, !!(se?.state_code && be?.state_code && se.state_code !== be.state_code))
    // setF is intentionally omitted below: it's a plain (unmemoized) function
    // recreated every render, so including it would rerun this effect on
    // every render instead of only when fromPiId/pis actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Intentionally fires only when defaultEntityId (re)resolves, not on
    // every manual edit to form.seller_entity_id or every render (setF is
    // unmemoized) — the `!form.seller_entity_id` guard already makes this a
    // one-time default, not an ongoing sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // CHANGED: payment terms drive the due date — recompute it whenever
      // terms are picked or the invoice date shifts under known terms. A
      // custom terms string that doesn't imply a day count leaves due_date
      // alone, and the user can still override the date manually afterwards.
      if (k === 'payment_terms' || (k === 'invoice_date' && f.payment_terms)) {
        const derived = dueDateForTerms(updated.invoice_date, updated.payment_terms)
        if (derived) updated.due_date = derived
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
      // CHANGED: a PI raised against a PO (proforma_invoices.po_id) carries
      // that PO onto the invoice too, so the PO's invoiced progress counts it.
      po_id: f.po_id || pi?.po_id || '',
      seller_entity_id: f.seller_entity_id || pi?.from_entity_id || '',
      buyer_entity_id:  f.buyer_entity_id  || pi?.to_entity_id   || '',
      order_id:         f.order_id         || pi?.order_id       || '',
      order_leg_id:     f.order_leg_id     || pi?.order_leg_id   || '',
    }))
    if (pi?.order_id && !form.order_id) loadLegs(pi.order_id)
    if (!piId || lines.length > 0) return
    prefillFromSource('pi', piId, pi?.pi_no, form.is_interstate)
  }

  // CHANGED: shared by Linked PI, Linked PO and the "Convert to Invoice"
  // entry point — previously three near-identical copies that each pulled
  // the source's FULL lines. A PI/PO can now be billed across several
  // invoices, so this prefills only what is still left to invoice on it
  // (source qty minus every active invoice already raised against it, per
  // product — see utils/docLinks.js).
  async function prefillFromSource(kind, docId, docNo, interstate) {
    const label = docNo || (kind === 'pi' ? 'This PI' : 'This PO')
    setLinesLoading(true)
    try {
      const { lines: remaining, invoiceCount, error } = await withTimeout(
        fetchRemainingLines(kind, docId), 20000, `Loading ${kind.toUpperCase()} line items`,
      )
      if (error) { setToast({ message: `Could not load ${kind.toUpperCase()} lines: ${error.message}`, type: 'error' }); return }
      if (remaining.length) {
        // computeLine() is normally only run by LineItemsEditor's own onChange
        // handlers — lines injected directly via setLines skip it, leaving
        // taxable_amount/total_amount at 0. Run it up front so the preview is
        // correct immediately.
        setLines(remaining.map((l, i) => computeLine({
          _id: Date.now() + i, line_no: i + 1,
          product_name: l.product_name || '', description: l.description,
          hsn_code: l.hsn_code, qty: l.qty, unit: l.unit,
          rate: l.rate, gst_rate: l.gst_rate,
          _hsn_resolved_rate: null, _hsn_override: false, _cost_rate: null, _margin_pct: '',
        }, interstate)))
        if (invoiceCount) setToast({ message: `${label} already has ${invoiceCount} invoice(s) against it — the lines below are the remaining quantity only.`, type: 'info' })
      } else if (invoiceCount) {
        setToast({ message: `${label} is already fully invoiced — nothing is left to bill. Add lines manually if this is an extra invoice.`, type: 'info' })
      } else {
        setToast({ message: `${label} has no line items saved — add lines manually below, or open it to check.`, type: 'info' })
      }
    } catch (e) {
      setToast({ message: `Could not load ${kind.toUpperCase()} lines: ${e.message}`, type: 'error' })
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
    prefillFromSource('po', poId, po?.po_no, form.is_interstate)
  }

  async function handleSave(skipStockCheck = false) {
    if (!form.seller_entity_id || !form.buyer_entity_id) return setToast({ message: 'Seller and Buyer are required', type: 'error' })
    if (lines.length === 0) return setToast({ message: 'At least one line item is required', type: 'error' })

    // CHANGED: every stock-affecting line must carry a product_name — otherwise
    // it's invisible to Actual Stock / Stock Position. Hard block.
    const missing = findLinesMissingProductName(lines)
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
    const totals = computeTotals(computedLines, roundOffOverride)
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
      const { data: dup } = await supabase.from('invoices').select('id').ilike('invoice_no', invoiceNo).eq('is_deleted', false).limit(1)
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
    for (const k of ['order_id', 'order_leg_id', 'pi_id', 'po_id', 'due_date', 'payment_terms', 'eway_bill_date', 'einvoice_ack_date']) {
      if (!payload[k]) delete payload[k]
    }
    if (!payload.tds_amount)    delete payload.tds_amount
    if (!payload.tcs_amount)    delete payload.tcs_amount
    // CHANGED: eway_bill_no/eway_bill_date must never be set at creation —
    // unconditionally, not just when blank. saveEwbForm's stock/purchase-mirror/
    // cargo-status side effects only fire on the false→true transition of
    // eway_bill_no; if it arrived already-set from creation, that transition
    // (and both side effects) would silently never happen. Every invoice must
    // start EWB-less and get it exclusively through that one dedicated flow.
    delete payload.eway_bill_no
    delete payload.eway_bill_date

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

    // TDS/TCS is no longer recorded at invoice creation — it's recognized at
    // payment time instead (Payments → Invoice Payment Tracker), which is the
    // single source of truth going forward. See tds_tcs_entries: still read
    // (never written) below for invoices created before this change.

    // Mark PI as converted if applicable
    // CHANGED: only once the PI is FULLY invoiced — a part-invoiced PI stays
    // open so the rest can be billed on a later invoice.
    if (form.pi_id) await syncLinkedDocStatus('pi', form.pi_id)
    // Same for the PO — 'partial' until fully invoiced, then 'completed'.
    if (form.po_id) await syncLinkedDocStatus('po', form.po_id)

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

  function handleExportLines() {
    if (!lines.length) return
    const rows = lines.map(l => ({ ...l, product: l.product_name || '' }))
    downloadCSV(`invoice_lines_${today()}.csv`, ['line_no','product','description','hsn_code','qty','unit','rate','gst_rate','taxable_amount','cgst_amount','sgst_amount','igst_amount','total_amount'], rows)
  }

  // CHANGED: bulk-CSV correction for this in-progress invoice's lines — same
  // approach as PI's handleBulkLinesCsv (edit page), adapted to the create
  // flow since Invoices has no post-save edit mode. Replaces `lines`
  // entirely (a corrections file represents the full corrected set).
  // Product resolution: match by `product` column name (case/junk-
  // insensitive — product identity is name alone); if blank, inherit
  // product_name from the existing line at the same line_no — so a file
  // that only touches qty/rate doesn't need to restate every product.
  async function handleBulkLinesCsv() {
    setLinesCsvSaving(true)
    const rows = linesCsvText.trim().split('\n').filter(l => l.trim())
    if (rows.length < 2) { setLinesCsvSaving(false); return setLinesCsvResult({ loaded: 0, errors: ['Need header + data rows'] }) }
    const delim = detectDelimiter(rows[0])
    const header = parseCSVLine(rows[0], delim).map(h => h.trim().toLowerCase())
    const byLineNo = new Map(lines.map(l => [String(l.line_no), l]))
    const errors = []
    const newLines = []
    for (let i = 1; i < rows.length; i++) {
      const cols = parseCSVLine(rows[i], delim)
      const row = {}
      header.forEach((h, j) => { row[h] = (cols[j] || '').trim() })
      if (!row.description && !row.qty && !row.rate) continue // blank row
      const existing = row.line_no ? byLineNo.get(row.line_no) : null
      const matchedProduct = row.product ? findProductByName(products, row.product) : null
      if (row.product && !matchedProduct) errors.push(`Row ${i + 1}: product "${row.product}" not found — line added without a product, pick one manually before saving.`)
      const productName = matchedProduct?.name || (!row.product ? existing?.product_name : null) || ''
      const hsnCode = row.hsn_code || existing?.hsn_code || ''
      const rowRate = toNum(row.rate)
      const resolved = hsnCode ? resolveGSTRate(hsnCode, rowRate, hsnMap, form.invoice_date) : { gst_rate: null }
      const gstRate = resolved.gst_rate !== null ? resolved.gst_rate : (toNum(row.gst_rate) || existing?.gst_rate || 18)
      newLines.push({
        _id: existing?.id || Date.now() + i, line_no: newLines.length + 1,
        product_name: productName, description: row.description || existing?.description || '',
        hsn_code: hsnCode, qty: toNum(row.qty), unit: row.unit || existing?.unit || 'Nos',
        rate: rowRate, gst_rate: gstRate,
        taxable_amount: 0, cgst_rate: 0, cgst_amount: 0, sgst_rate: 0, sgst_amount: 0, igst_rate: 0, igst_amount: 0, total_amount: 0,
        _hsn_resolved_rate: resolved.gst_rate, _hsn_override: false, _hsn_manually_set: false, _cost_rate: null, _margin_pct: '',
      })
    }
    const computed = newLines.map(l => computeLine(l, form.is_interstate))
    setLines(computed)
    setLinesCsvSaving(false)
    setLinesCsvResult({ loaded: computed.length, errors })
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
            <FormRow label='Payment Terms' hint='Due date auto-calculates from this'>
              <Input list='inv-payment-terms' value={form.payment_terms} onChange={e => setF('payment_terms', e.target.value)} placeholder='e.g. Net 30 Days' />
              <datalist id='inv-payment-terms'>{PAYMENT_TERMS_OPTIONS.map(o => <option key={o} value={o} />)}</datalist>
            </FormRow>
            <FormRow label='Due Date' hint={form.payment_terms ? 'Auto-set from payment terms — override if needed' : undefined}>
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
                  .filter(p => (!form.order_id || p.order_id === form.order_id) && (p.id === form.pi_id || p.status !== 'converted'))
                  .map(p => <option key={p.id} value={p.id}>{p.pi_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Linked PO'>
              <Select value={form.po_id} onChange={e => handlePOSelect(e.target.value)}>
                <option value=''>No PO</option>
                {pos
                  .filter(p => (!form.order_id || p.order_id === form.order_id) && (p.id === form.po_id || p.status !== 'completed'))
                  .map(p => <option key={p.id} value={p.id}>{p.po_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Order'>
              <Select value={form.order_id} onChange={e => { setF('order_id', e.target.value); loadLegs(e.target.value) }}>
                <option value=''>No order</option>
                {/* CHANGED: only orders still open for documents — completed/cancelled hidden (current selection stays visible) */}
                {orders.filter(o => isOrderOpenForDocs(o) || o.id === form.order_id).map(o => <option key={o.id} value={o.id}>{orderLabel(o)}</option>)}
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
          {lines.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <Btn size='sm' variant='ghost' onClick={handleExportLines}>↓ Download Lines as CSV</Btn>
              <Btn size='sm' variant='ghost' onClick={() => { setLinesCsvText(''); setLinesCsvResult(null); setLinesCsvModal(true) }}>↑ Bulk Correct Lines from CSV</Btn>
            </div>
          )}
          <div style={{ marginTop: '12px' }}>
            <LineItemsEditor lines={lines} setLines={setLines} interstate={form.is_interstate} hsnMap={hsnMap} asOfDate={form.invoice_date} stockMap={stockMap} products={products} roundOffOverride={roundOffOverride} onRoundOffOverrideChange={setRoundOffOverride} />
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
          {/* CHANGED: E-way Bill entry removed from here — it must only ever be
              added via the dedicated flow on the invoice detail page
              (saveEwbForm). That's the ONLY path that auto-creates the buyer's
              purchase-register mirror and syncs the order leg's movement/cargo
              status on the false→true transition; entering it here at creation
              time would set eway_bill_no from the start, so that transition
              (and both side effects) would silently never fire. */}
          <SectionDivider label='Billing & Shipping' />
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
          </div>
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

      <Modal open={linesCsvModal} onClose={() => setLinesCsvModal(false)} title='Bulk Correct Line Items' width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: C.textMid }}>
            Columns: <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>line_no,product,description,hsn_code,qty,unit,rate,gst_rate</code><br />
            This <b>replaces every line</b> currently below with the rows in this file — download the current lines first (e.g. right after picking a linked PI/PO),
            correct the numbers in Excel/Sheets, then re-upload. <code>line_no</code> matches a row back to its existing product/line;
            leave <code>product</code> blank on a row to keep that line's current product. Extra columns (taxable_amount, etc.) are ignored — they're recomputed.
          </div>
          <CsvFileDrop onText={setLinesCsvText} />
          <textarea value={linesCsvText} onChange={e => setLinesCsvText(e.target.value)} rows={8} placeholder='Or paste CSV data here…'
            style={{ padding: '8px', border: `1px solid ${C.border}`, borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace', resize: 'vertical' }} />
          {linesCsvResult && (
            <div style={{ background: linesCsvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${linesCsvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              {linesCsvResult.loaded} line(s) loaded{linesCsvResult.errors.length ? ` — ${linesCsvResult.errors.length} warning(s)` : ''}. Review below, then Create Invoice.
              {linesCsvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setLinesCsvModal(false)}>Close</Btn>
            <Btn onClick={handleBulkLinesCsv} disabled={linesCsvSaving || !linesCsvText.trim()}>{linesCsvSaving ? 'Loading…' : 'Load Into Editor'}</Btn>
          </div>
        </div>
      </Modal>

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
  // CHANGED: seller is now editable — offer only entities this user can act as (same rule as the New Invoice form)
  const { entities: accessEntities, isMaster } = useEntityAccess()
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
  const [docBusy, setDocBusy] = useState('') // 'pdf' | 'excel' | ''
  // CHANGED: post-save editing of header fields + line items — same
  // pattern as PI's edit flow. Available to any role at any status/EWB
  // state; `isLocked` above (EWB/IRN inline sections) is unrelated.
  const [editing, setEditing]       = useState(false)
  const [editForm, setEditForm]     = useState({})
  const [editLines, setEditLines]   = useState([])
  const [editRoundOffOverride, setEditRoundOffOverride] = useState('')
  const [hsnMap, setHsnMap]         = useState(new Map())
  const [products, setProducts]     = useState([])
  const [saving, setSaving]         = useState(false)
  const [linesCsvModal, setLinesCsvModal]   = useState(false)
  const [linesCsvText, setLinesCsvText]     = useState('')
  const [linesCsvResult, setLinesCsvResult] = useState(null)
  const [linesCsvSaving, setLinesCsvSaving] = useState(false)
  // CHANGED: Order / Leg / Linked PI / Linked PO are now editable after save
  // (they could only be set on the New Invoice form before). Pick lists are
  // loaded the first time Edit is opened; linkNames is just the PI/PO number
  // for the read-only details strip.
  const [orders, setOrders]       = useState([])
  const [legs, setLegs]           = useState([])
  const [pis, setPIs]             = useState([])
  const [pos, setPOs]             = useState([])
  const [linkNames, setLinkNames] = useState({ pi_no: '', po_no: '' })
  // CHANGED: Edit now turns the whole invoice editable IN PLACE (no separate
  // "Edit Details" box) — seller, buyer, header, links, addresses, E-way
  // Bill, IRN, notes and lines are all saved by the one "Save Changes".
  const [entities, setEntities]             = useState([])
  const [confirmParties, setConfirmParties] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: i }, { data: ls }, { data: tds }, { data: hsnRows }, { data: prods }] = await Promise.all([
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
      supabase.from('hsn_master').select('*').eq('is_active', true),
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate')),
    ])
    setInv(i)
    setLines(ls || [])
    setTdsRows(tds || [])  // CHANGED
    setHsnMap(buildHSNMap(hsnRows || []))
    setProducts(prods || [])
    setLoading(false)
    // CHANGED: PI / PO numbers for the details strip. Separate small lookups
    // (not an embed on the main query) so a failure here can never stop the
    // invoice itself from loading.
    if (i) {
      const [piRes, poRes] = await Promise.all([
        i.pi_id ? supabase.from('proforma_invoices').select('pi_no').eq('id', i.pi_id).maybeSingle() : Promise.resolve({ data: null }),
        i.po_id ? supabase.from('purchase_orders').select('po_no').eq('id', i.po_id).maybeSingle() : Promise.resolve({ data: null }),
      ])
      setLinkNames({ pi_no: piRes.data?.pi_no || '', po_no: poRes.data?.po_no || '' })
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // CHANGED: pick lists for the link fields in edit mode.
  async function loadLinkOptions() {
    const [{ data: es }, { data: os }, { data: piData }, { data: poData }] = await Promise.all([
      supabase.from('entities').select('id,name,short_name,gstin,city,state_code,type').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name,description,status').eq('is_deleted', false).order('name'),
      supabase.from('proforma_invoices').select('id,pi_no,status,po_id,from_entity_id,to_entity_id,order_id,order_leg_id').eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('purchase_orders').select('id,po_no,status,buyer_entity_id,seller_entity_id,order_id,order_leg_id').eq('is_deleted', false).order('po_date', { ascending: false }),
    ])
    setEntities(es || [])
    setOrders(os || [])
    setPIs(piData || [])
    setPOs(poData || [])
  }

  // CHANGED: changing seller / buyer re-derives Local vs Interstate from the
  // two state codes (same as the New Invoice form); still overridable after.
  function setEditParty(key, value) {
    setEditForm(f => {
      const nf = { ...f, [key]: value }
      const se = entities.find(e => e.id === nf.seller_entity_id)
      const be = entities.find(e => e.id === nf.buyer_entity_id)
      if (se?.state_code && be?.state_code) nf.is_interstate = se.state_code !== be.state_code
      return nf
    })
  }

  async function loadLegs(orderId) {
    if (!orderId) { setLegs([]); return }
    const { data } = await supabase.from('order_legs')
      .select('id,leg_no,from_entity:from_entity_id(name,short_name),to_entity:to_entity_id(name,short_name)')
      .eq('order_id', orderId).order('leg_no')
    setLegs(data || [])
  }

  // CHANGED: picking a PI / PO in edit mode only changes the LINK. It fills
  // the PO (from the PI) and the order / leg when those are still blank, and
  // never touches line items — this invoice may already have an E-way Bill
  // and moved stock.
  function handleEditPISelect(piId) {
    const pi = pis.find(p => p.id === piId)
    setEditForm(f => ({
      ...f, pi_id: piId,
      po_id:        f.po_id        || pi?.po_id        || '',
      order_id:     f.order_id     || pi?.order_id     || '',
      order_leg_id: f.order_leg_id || (!f.order_id || f.order_id === pi?.order_id ? pi?.order_leg_id : '') || '',
    }))
    if (pi?.order_id && !editForm.order_id) loadLegs(pi.order_id)
  }
  function handleEditPOSelect(poId) {
    const po = pos.find(p => p.id === poId)
    setEditForm(f => ({
      ...f, po_id: poId,
      order_id:     f.order_id     || po?.order_id     || '',
      order_leg_id: f.order_leg_id || (!f.order_id || f.order_id === po?.order_id ? po?.order_leg_id : '') || '',
    }))
    if (po?.order_id && !editForm.order_id) loadLegs(po.order_id)
  }

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
    // CHANGED: a cancelled invoice no longer counts against its PI/PO — free
    // that quantity up so it can be invoiced again.
    if (status === 'cancelled') {
      if (inv.pi_id) await syncLinkedDocStatus('pi', inv.pi_id, { allowReopen: true })
      if (inv.po_id) await syncLinkedDocStatus('po', inv.po_id, { allowReopen: true })
    }

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
    // CHANGED: re-derived from the invoices still standing against the PI
    // (it can carry several) instead of blindly reopening it.
    if (!error && inv?.pi_id) await syncLinkedDocStatus('pi', inv.pi_id, { allowReopen: true })
    // Same for a linked PO — otherwise a deleted invoice leaves its PO stuck
    // on 'completed'.
    if (!error && inv?.po_id) await syncLinkedDocStatus('po', inv.po_id, { allowReopen: true })
    setDeleting(false); setConfirmDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    navigate('/invoices')
  }

  async function handleDownloadPDF() {
    setDocBusy('pdf')
    try { printDocument(await buildInvoiceDoc(inv, lines)) }
    catch (err) { setToast({ message: err.message || 'Could not generate PDF', type: 'error' }) }
    finally { setDocBusy('') }
  }

  async function handleDownloadExcel() {
    setDocBusy('excel')
    try { downloadDocumentExcel(await buildInvoiceDoc(inv, lines)) }
    catch (err) { setToast({ message: err.message || 'Could not generate Excel', type: 'error' }) }
    finally { setDocBusy('') }
  }

  // CHANGED: save EWB + Challan fields
  function openEwbEdit() {
    setEwbForm({
      eway_bill_no:     inv.eway_bill_no     || '',
      eway_bill_date:   inv.eway_bill_date   || '',
    })
    setEwbEdit(true)
  }
  async function saveEwbForm() {
    if (!isValidEwayBill(ewbForm.eway_bill_no)) return setToast({ message: EWAY_BILL_ERROR, type: 'error' })
    setSectSaving(true)
    const wasEwaySet = !!inv.eway_bill_no
    const { error } = await supabase.from('invoices').update({
      eway_bill_no:     ewbForm.eway_bill_no     || null,
      eway_bill_date:   ewbForm.eway_bill_date   || null,
      // CHANGED: challan_no / vehicle_no / transporter_name are no longer
      // written here — they are a combined copy of the invoice_vehicles rows,
      // kept in step by <InvoiceVehicles> (utils/challans.js).
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
    setToast({ message: 'E-way Bill saved', type: 'success' })
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

  function startEdit() {
    setEditForm({
      invoice_no: inv.invoice_no || '', invoice_date: inv.invoice_date || '', due_date: inv.due_date || '',
      payment_terms: inv.payment_terms || '',
      status: inv.status || 'draft', notes: inv.notes || '', is_interstate: inv.is_interstate,
      bill_from: inv.bill_from || '', bill_to: inv.bill_to || '', ship_from: inv.ship_from || '', ship_to: inv.ship_to || '',
      // CHANGED: link fields are editable too
      order_id: inv.order_id || '', order_leg_id: inv.order_leg_id || '', pi_id: inv.pi_id || '', po_id: inv.po_id || '',
      // CHANGED: everything else on the invoice is editable in the same pass
      seller_entity_id: inv.seller_entity_id || '', buyer_entity_id: inv.buyer_entity_id || '',
      eway_bill_no: inv.eway_bill_no || '', eway_bill_date: inv.eway_bill_date || '', challan_no: inv.challan_no || '',
      vehicle_no: inv.vehicle_no || '', transporter_name: inv.transporter_name || '',
      einvoice_irn: inv.einvoice_irn || '', einvoice_ack_no: inv.einvoice_ack_no || '',
      einvoice_ack_date: inv.einvoice_ack_date || '', einvoice_qr_code: inv.einvoice_qr_code || '',
    })
    setEwbEdit(false); setIrnEdit(false)
    loadLinkOptions()
    loadLegs(inv.order_id)
    setEditLines(lines.map(l => ({ ...l, _id: l.id, _hsn_resolved_rate: null, _hsn_override: false, _hsn_manually_set: false, _cost_rate: null, _margin_pct: '' })))
    setEditRoundOffOverride('')
    setEditing(true)
  }

  function handleExportEditLines() {
    if (!lines.length) return
    const rows = lines.map(l => ({ ...l, product: l.product_name || '' }))
    downloadCSV(`${inv.invoice_no || 'invoice'}_lines_${today()}.csv`, ['line_no','product','description','hsn_code','qty','unit','rate','gst_rate','taxable_amount','cgst_amount','sgst_amount','igst_amount','total_amount'], rows)
  }

  // CHANGED: bulk-CSV correction while editing — identical approach to
  // PI's handleBulkLinesCsv (see PI/index.jsx for the full rationale).
  async function handleBulkLinesCsv() {
    setLinesCsvSaving(true)
    const rows = linesCsvText.trim().split('\n').filter(l => l.trim())
    if (rows.length < 2) { setLinesCsvSaving(false); return setLinesCsvResult({ loaded: 0, errors: ['Need header + data rows'] }) }
    const delim = detectDelimiter(rows[0])
    const header = parseCSVLine(rows[0], delim).map(h => h.trim().toLowerCase())
    const byLineNo = new Map(editLines.map(l => [String(l.line_no), l]))
    const errors = []
    const newLines = []
    for (let i = 1; i < rows.length; i++) {
      const cols = parseCSVLine(rows[i], delim)
      const row = {}
      header.forEach((h, j) => { row[h] = (cols[j] || '').trim() })
      if (!row.description && !row.qty && !row.rate) continue
      const existing = row.line_no ? byLineNo.get(row.line_no) : null
      const matchedProduct = row.product ? findProductByName(products, row.product) : null
      if (row.product && !matchedProduct) errors.push(`Row ${i + 1}: product "${row.product}" not found — line added without a product, pick one manually before saving.`)
      const productName = matchedProduct?.name || (!row.product ? existing?.product_name : null) || ''
      const hsnCode = row.hsn_code || existing?.hsn_code || ''
      const rowRate = toNum(row.rate)
      const resolved = hsnCode ? resolveGSTRate(hsnCode, rowRate, hsnMap, editForm.invoice_date) : { gst_rate: null }
      const gstRate = resolved.gst_rate !== null ? resolved.gst_rate : (toNum(row.gst_rate) || existing?.gst_rate || 18)
      newLines.push({
        _id: existing?.id || Date.now() + i, line_no: newLines.length + 1,
        product_name: productName, description: row.description || existing?.description || '',
        hsn_code: hsnCode, qty: toNum(row.qty), unit: row.unit || existing?.unit || 'Nos',
        rate: rowRate, gst_rate: gstRate,
        taxable_amount: 0, cgst_rate: 0, cgst_amount: 0, sgst_rate: 0, sgst_amount: 0, igst_rate: 0, igst_amount: 0, total_amount: 0,
        _hsn_resolved_rate: resolved.gst_rate, _hsn_override: false, _hsn_manually_set: false, _cost_rate: null, _margin_pct: '',
      })
    }
    const computed = newLines.map(l => computeLine(l, editForm.is_interstate))
    setEditLines(computed)
    setLinesCsvSaving(false)
    setLinesCsvResult({ loaded: computed.length, errors })
  }

  async function handleSaveEdit(partiesConfirmed = false) {
    const invoiceNo = (editForm.invoice_no || '').trim()
    if (!invoiceNo) return setToast({ message: 'Invoice number cannot be blank', type: 'error' })
    // CHANGED: seller / buyer / E-way Bill / IRN are part of the same save now.
    const sellerId = editForm.seller_entity_id, buyerId = editForm.buyer_entity_id
    if (!sellerId || !buyerId) return setToast({ message: 'Select both a seller and a buyer', type: 'error' })
    if (sellerId === buyerId) return setToast({ message: 'Seller and buyer cannot be the same entity', type: 'error' })
    const partiesChanged = sellerId !== inv.seller_entity_id || buyerId !== inv.buyer_entity_id
    // Same lock the E-way Bill / IRN sections have always had (see isLocked below).
    const transportLocked = !hasFullAccess(profile) && ['cancelled', 'paid'].includes(inv.status)
    if (!transportLocked && editForm.eway_bill_no && !isValidEwayBill(editForm.eway_bill_no)) return setToast({ message: EWAY_BILL_ERROR, type: 'error' })
    // CHANGED: same rule the create flow enforces — a line with no
    // product_id is invisible to stock tracking.
    const missing = findLinesMissingProductName(editLines)
    if (missing.length > 0) return setToast({ message: `Line ${missing.map(l => l._lineNo).join(', ')}: select a product before saving — stock tracking needs it.`, type: 'error' })
    // CHANGED: a seller / buyer change moves stock, the buyer's purchase entry
    // and recorded payments with it — ask once before doing that.
    if (partiesChanged && !partiesConfirmed) return setConfirmParties(true)
    setSaving(true)
    if (invoiceNo.toLowerCase() !== (inv.invoice_no || '').toLowerCase()) {
      const { data: dup } = await supabase.from('invoices').select('id').ilike('invoice_no', invoiceNo).eq('is_deleted', false).neq('id', id).limit(1)
      if (dup?.length) { setSaving(false); return setToast({ message: `Invoice number "${invoiceNo}" is already in use`, type: 'error' }) }
    }
    const computedLines = editLines.map(l => computeLine(l, editForm.is_interstate))
    const totals = computeTotals(computedLines, editRoundOffOverride)
    // outstanding_amount tracks total_amount minus whatever's already been
    // paid — recompute it from the invoice's own paid_amount rather than
    // resetting it, so an edit after partial payment doesn't wipe that out.
    const outstanding = round2(totals.total_amount - (Number(inv.paid_amount) || 0))
    const links = {
      pi_id: editForm.pi_id || null, po_id: editForm.po_id || null,
      order_id: editForm.order_id || null, order_leg_id: editForm.order_leg_id || null,
    }
    const linksChanged = Object.keys(links).some(k => (links[k] || null) !== (inv[k] || null))
    // CHANGED: E-way Bill / IRN fields come out of the header spread — they
    // are written only when not locked, and '' must go in as null.
    const { eway_bill_no: _a, eway_bill_date: _b, challan_no: _c, vehicle_no: _d, transporter_name: _e,
      einvoice_irn: _f, einvoice_ack_no: _g, einvoice_ack_date: _h, einvoice_qr_code: _i, ...header } = editForm
    const transport = transportLocked ? {} : {
      eway_bill_no: editForm.eway_bill_no || null, eway_bill_date: editForm.eway_bill_date || null,
      // CHANGED: challan_no / vehicle_no / transporter_name are not written
      // here any more (still stripped from `header` above) — <InvoiceVehicles>
      // owns them, so a full-invoice save can never overwrite them with stale values.
      einvoice_irn: editForm.einvoice_irn || null, einvoice_ack_no: editForm.einvoice_ack_no || null,
      einvoice_ack_date: editForm.einvoice_ack_date || null, einvoice_qr_code: editForm.einvoice_qr_code || null,
    }
    const newEwbNo  = transportLocked ? inv.eway_bill_no : transport.eway_bill_no
    const firstEwb  = !inv.eway_bill_no && !!newEwbNo
    const { error: invErr } = await supabase.from('invoices').update({
      ...header, invoice_no: invoiceNo, due_date: editForm.due_date || null,
      payment_terms: editForm.payment_terms || null,
      // CHANGED: uuid columns — '' must go in as null
      ...links, ...transport,
      ...totals, outstanding_amount: outstanding, updated_at: new Date(),
    }).eq('id', id)
    if (invErr) { setSaving(false); return setToast({ message: invErr.message, type: 'error' }) }
    const warns = []
    const { error: delErr } = await supabase.from('invoice_lines').delete().eq('invoice_id', id)
    if (delErr) { setSaving(false); return setToast({ message: `Could not clear old line items: ${delErr.message}. Invoice header was updated but lines were left unchanged to avoid duplicates.`, type: 'error' }) }
    const linesPayload = computedLines.map((l, i) => toInvoiceLinePayload(l, id, i + 1))
    if (linesPayload.length) {
      const { error: lErr } = await supabase.from('invoice_lines').insert(linesPayload)
      if (lErr) { setSaving(false); return setToast({ message: lErr.message, type: 'error' }) }
    }
    // CHANGED: edited quantities (or status) change how much of the linked
    // PI/PO is invoiced — keep their status in step.
    // CHANGED: when the link itself was changed, BOTH sides need re-deriving —
    // the PI/PO this invoice was moved off (may reopen) and the one it was
    // moved onto (may become partial / converted / completed).
    for (const piId of new Set([inv.pi_id, links.pi_id].filter(Boolean))) await syncLinkedDocStatus('pi', piId, { allowReopen: true })
    for (const poId of new Set([inv.po_id, links.po_id].filter(Boolean))) await syncLinkedDocStatus('po', poId, { allowReopen: true })

    // CHANGED: everything that hangs off this invoice's parties / links / EWB.
    // Stock itself needs nothing here — it is recomputed live from the
    // invoice's own seller, buyer and E-way Bill.
    const sellerEnt = entities.find(e => e.id === sellerId) || inv.seller
    const buyerEnt  = entities.find(e => e.id === buyerId)  || inv.buyer
    const cancelled = header.status === 'cancelled'
    // 1. Payments recorded against this invoice carry their own copy of the
    //    paying (buyer) and paid (seller) entity.
    if (partiesChanged) {
      const { error: payErr } = await supabase.from('invoice_payments')
        .update({ entity_id: buyerId, party_entity_id: sellerId }).eq('invoice_id', id)
      if (payErr) warns.push(`payments were not moved to the new parties (${payErr.message})`)
    }
    // 2. Buyer-side purchase entry (the auto mirror made on E-way Bill).
    const { data: mirrors, error: mirSelErr } = await supabase.from('invoices').select('id,status')
      .eq('source_invoice_id', id).eq('invoice_type', 'purchase').eq('is_deleted', false).limit(1)
    const mirror = mirrors?.[0]
    if (mirSelErr) warns.push(`buyer purchase entry could not be checked (${mirSelErr.message})`)
    else if (mirror) {
      const patch = {}
      if (linksChanged) Object.assign(patch, links)
      if (partiesChanged) {
        patch.seller_entity_id = sellerId
        patch.buyer_entity_id  = buyerId
        if (buyerEnt?.type === 'external') patch.status = 'cancelled' // external buyers keep no purchase entry here
        else {
          if (mirror.status === 'cancelled' && !cancelled) patch.status = 'submitted'
          // it sits in the BUYER's number series — a new buyer needs a number from their own
          if (buyerId !== inv.buyer_entity_id) {
            patch.invoice_no = await suggestNextNo({ table: 'invoices', noCol: 'invoice_no', entityShort: buyerEnt?.short_name || buyerEnt?.name, fyCode: fyCodeForDate(newEwbNo ? (transportLocked ? inv.eway_bill_date : transport.eway_bill_date) || header.invoice_date : header.invoice_date) })
          }
        }
      }
      if (Object.keys(patch).length) {
        const { error: mirrorErr } = await supabase.from('invoices').update({ ...patch, updated_at: new Date() }).eq('id', mirror.id)
        if (mirrorErr) warns.push(`buyer purchase entry was not updated (${mirrorErr.message})`)
      }
    } else if (newEwbNo && !cancelled && (firstEwb || partiesChanged)) {
      // No entry yet: the E-way Bill was entered in this save, or the buyer
      // changed to an internal entity. No-ops for external buyers / purchase invoices.
      const { error: mirrorErr } = await autoCompletePurchaseMirror({
        ...inv, ...header, ...links, ...transport, ...totals, id, invoice_no: invoiceNo,
        seller_entity_id: sellerId, buyer_entity_id: buyerId, seller: sellerEnt, buyer: buyerEnt,
      }, computedLines)
      if (mirrorErr) warns.push(`buyer purchase entry failed (${mirrorErr.message})`)
    }
    // 3. First E-way Bill = the physical movement — same leg sync the
    //    E-way Bill section's own Save does.
    if (firstEwb && links.order_leg_id) {
      await supabase.from('order_legs').update({ movement_status: 'delivered', cargo_status: 'cargo_dispatched' }).eq('id', links.order_leg_id)
    }

    setSaving(false); setEditing(false)
    setToast(warns.length
      ? { message: `Invoice updated, but ${warns.join('; ')}`, type: 'error' }
      : { message: 'Invoice updated', type: 'success' })
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
            <Btn size='sm' variant='ghost' onClick={handleDownloadPDF} disabled={!!docBusy}>{docBusy==='pdf'?'Generating…':'⎙ Download PDF'}</Btn>
            <Btn size='sm' variant='ghost' onClick={handleDownloadExcel} disabled={!!docBusy}>{docBusy==='excel'?'Generating…':'↓ Download Excel'}</Btn>
            {!editing && <Btn size='sm' variant='ghost' onClick={startEdit}>✏ Edit</Btn>}
            {editing && <Btn size='sm' variant='ghost' onClick={() => setEditing(false)}>Discard</Btn>}
            {editing && <Btn size='sm' onClick={() => handleSaveEdit()} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>}
            {!editing && inv.status === 'draft' && <Btn size='sm' onClick={() => updateStatus('submitted')}>Submit</Btn>}
            {!editing && inv.status === 'submitted' && <Btn size='sm' variant='ghost' onClick={() => updateStatus('paid')}>Mark Paid</Btn>}
            {!editing && !['cancelled','paid'].includes(inv.status) && <Btn size='sm' variant='ghost' onClick={() => setConfirmCancel(true)} style={{ color: C.danger }}>Cancel</Btn>}
            {!editing && canDelete && <Btn size='sm' variant='danger' onClick={() => setConfirmDelete(true)} disabled={deleting}>{deleting?'Deleting…':'Delete'}</Btn>}
            <Badge status={inv.invoice_type} label={inv.invoice_type === 'sales' ? 'Sales Invoice' : 'Purchase Invoice'} />
            <Badge status={inv.status} />
            {(() => { const s = getInvoiceLifecycleStage(inv); return <Badge status={s.key} label={s.label} /> })()}
          </div>
        }
      />
      {editing && <div style={{background:'#fffbf0',border:`1px solid #e6c040`,borderRadius:'6px',padding:'8px 14px',fontSize:'12px',color:'#7a5000',marginBottom:'16px'}}>✏ Editing mode — click "Save Changes" to confirm</div>}

      {/* Seller / Buyer */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Seller</div>
          {editing ? (() => { const e = entities.find(x => x.id === editForm.seller_entity_id); return (<>
            <Select value={editForm.seller_entity_id} onChange={ev => setEditParty('seller_entity_id', ev.target.value)}>
              <option value=''>Select seller…</option>
              {entities.filter(x => isMaster || x.id === inv.seller_entity_id || accessEntities.some(a => a.id === x.id)).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
            {e?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '6px' }}>GSTIN: {e.gstin}</div>}
            {e?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{e.city}</div>}
          </>) })() : (<>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{inv.seller?.name}</div>
          {inv.seller?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {inv.seller.gstin}</div>}
          {inv.seller?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{inv.seller.city}</div>}
          </>)}
        </Card>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Buyer</div>
          {editing ? (() => { const e = entities.find(x => x.id === editForm.buyer_entity_id); return (<>
            <Select value={editForm.buyer_entity_id} onChange={ev => setEditParty('buyer_entity_id', ev.target.value)}>
              <option value=''>Select buyer…</option>
              {entities.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
            {e?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '6px' }}>GSTIN: {e.gstin}</div>}
            {e?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{e.city}</div>}
          </>) })() : (<>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{inv.buyer?.name}</div>
          {inv.buyer?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {inv.buyer.gstin}</div>}
          {inv.buyer?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{inv.buyer.city}</div>}
          </>)}
        </Card>
      </div>

      {/* Details strip */}
      {/* CHANGED: in edit mode the strip itself becomes the inputs — no separate "Edit Details" box. Only PIs / POs between the selected seller and buyer are offered; changing a link never changes the line items. */}
      {editing && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '12px', marginBottom: '20px' }}>
            <FormRow label='Invoice Date' required><Input type='date' value={editForm.invoice_date} onChange={e=>setEditForm(f=>{const nf={...f,invoice_date:e.target.value};const d=dueDateForTerms(nf.invoice_date,nf.payment_terms);return d?{...nf,due_date:d}:nf})}/></FormRow>
            <FormRow label='Invoice Number' required><Input value={editForm.invoice_no} onChange={e=>setEditForm(f=>({...f,invoice_no:e.target.value}))}/></FormRow>
            {/* CHANGED: payment terms drive due date, same as the create form */}
            <FormRow label='Payment Terms' hint='Due date auto-calculates from this'>
              <Input list='inv-edit-payment-terms' value={editForm.payment_terms} onChange={e=>setEditForm(f=>{const nf={...f,payment_terms:e.target.value};const d=dueDateForTerms(nf.invoice_date,nf.payment_terms);return d?{...nf,due_date:d}:nf})} placeholder='e.g. Net 30 Days'/>
              <datalist id='inv-edit-payment-terms'>{PAYMENT_TERMS_OPTIONS.map(o=><option key={o} value={o}/>)}</datalist>
            </FormRow>
            <FormRow label='Due Date' hint={editForm.payment_terms?'Auto-set from payment terms — override if needed':undefined}><Input type='date' value={editForm.due_date} onChange={e=>setEditForm(f=>({...f,due_date:e.target.value}))}/></FormRow>
            <FormRow label='Status'><Select value={editForm.status} onChange={e=>setEditForm(f=>({...f,status:e.target.value}))}>{INV_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}</Select></FormRow>
            <FormRow label='Tax Type'><Select value={editForm.is_interstate?'1':'0'} onChange={e=>setEditForm(f=>({...f,is_interstate:e.target.value==='1'}))}><option value='0'>Local — CGST+SGST</option><option value='1'>Interstate — IGST</option></Select></FormRow>
            <FormRow label='Order'>
              <Select value={editForm.order_id} onChange={e=>{setEditForm(f=>({...f,order_id:e.target.value,order_leg_id:''}));loadLegs(e.target.value)}}>
                <option value=''>No order</option>
                {orders.filter(o=>isOrderOpenForDocs(o)||o.id===editForm.order_id).map(o=><option key={o.id} value={o.id}>{orderLabel(o)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Order Leg'>
              <Select value={editForm.order_leg_id} onChange={e=>setEditForm(f=>({...f,order_leg_id:e.target.value}))} disabled={!editForm.order_id||!legs.length}>
                <option value=''>Select leg</option>
                {legs.map(l=><option key={l.id} value={l.id}>Leg {l.leg_no}: {l.from_entity?.short_name||l.from_entity?.name} → {l.to_entity?.short_name||l.to_entity?.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Linked PI' hint='Line items are not changed'>
              <Select value={editForm.pi_id} onChange={e=>handleEditPISelect(e.target.value)}>
                <option value=''>No PI linked</option>
                {pis.filter(p=>p.id===editForm.pi_id||(p.status!=='cancelled'&&p.from_entity_id===editForm.seller_entity_id&&p.to_entity_id===editForm.buyer_entity_id&&(!editForm.order_id||!p.order_id||p.order_id===editForm.order_id))).map(p=><option key={p.id} value={p.id}>{p.pi_no||p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Linked PO' hint='Line items are not changed'>
              <Select value={editForm.po_id} onChange={e=>handleEditPOSelect(e.target.value)}>
                <option value=''>No PO linked</option>
                {pos.filter(p=>p.id===editForm.po_id||(p.status!=='cancelled'&&p.seller_entity_id===editForm.seller_entity_id&&p.buyer_entity_id===editForm.buyer_entity_id&&(!editForm.order_id||!p.order_id||p.order_id===editForm.order_id))).map(p=><option key={p.id} value={p.id}>{p.po_no||p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
        </div>
      )}
      {!editing && <div style={{ display: 'flex', gap: '20px', marginBottom: '20px', flexWrap: 'wrap', fontSize: '13px' }}>
        <div><span style={{ color: C.textMuted }}>Date:</span> <strong>{fmtDate(inv.invoice_date)}</strong></div>
        {inv.due_date && <div>
          <span style={{ color: C.textMuted }}>Due:</span>{' '}
          <strong style={{ color: inv.due_date < new Date().toISOString().slice(0,10) && inv.status !== 'paid' ? C.danger : C.text }}>
            {fmtDate(inv.due_date)}
          </strong>
        </div>}
        {inv.payment_terms && <div><span style={{ color: C.textMuted }}>Terms:</span> <strong>{inv.payment_terms}</strong></div>}
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={inv.is_interstate ? 'export' : 'domestic'} label={inv.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /></div>
        {inv.einvoice_irn && <div><span style={{ color: C.textMuted }}>IRN:</span> <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{inv.einvoice_irn}</span></div>}
        {inv.orders?.name && <div><span style={{ color: C.textMuted }}>Order:</span> <strong>{inv.orders.name}</strong></div>}
        {/* CHANGED: show what this invoice is linked to */}
        {inv.pi_id && <div><span style={{ color: C.textMuted }}>PI:</span> <strong style={{ color: C.accent, textDecoration: 'underline', cursor: 'pointer' }} onClick={() => navigate(`/pi/${inv.pi_id}`)}>{linkNames.pi_no || inv.pi_id.slice(0, 8)}</strong></div>}
        {inv.po_id && <div><span style={{ color: C.textMuted }}>PO:</span> <strong style={{ color: C.accent, textDecoration: 'underline', cursor: 'pointer' }} onClick={() => navigate(`/po/${inv.po_id}`)}>{linkNames.po_no || inv.po_id.slice(0, 8)}</strong></div>}
      </div>}

      {/* Outstanding */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Invoice Total' value={formatINR(inv.total_amount)} />
        <StatCard label='Paid' value={formatINR(inv.paid_amount)} color={C.success} />
        <StatCard label='Outstanding' value={formatINR(inv.outstanding_amount)} color={inv.outstanding_amount > 0 ? C.warning : C.success} />
      </div>

      <Card>
        {editing && (
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <Btn size='sm' variant='ghost' onClick={handleExportEditLines}>↓ CSV</Btn>
            <Btn size='sm' variant='ghost' onClick={() => { setLinesCsvText(''); setLinesCsvResult(null); setLinesCsvModal(true) }}>↑ Bulk Correct Lines from CSV</Btn>
          </div>
        )}
        <LineItemsEditor
          lines={editing ? editLines : lines.map(l => ({ ...l, _id: l.id }))}
          setLines={editing ? setEditLines : () => {}}
          interstate={editing ? editForm.is_interstate : inv.is_interstate}
          hsnMap={hsnMap}
          asOfDate={editing ? editForm.invoice_date : inv.invoice_date}
          readOnly={!editing}
          showMargin={true}
          products={editing ? products : undefined}
          roundOffOverride={editing ? editRoundOffOverride : ''}
          onRoundOffOverrideChange={editing ? setEditRoundOffOverride : undefined}
        />
      </Card>

      {editing && (
        <div style={{ marginTop: '12px', padding: '12px 14px', background: '#f8f4ee', borderRadius: '6px', border: `1px solid ${C.border}`, fontSize: '13px' }}>
          <div style={{ fontWeight: 700, marginBottom: '8px', color: C.textMid }}>Billing & Shipping</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Bill From'><Input value={editForm.bill_from} onChange={e=>setEditForm(f=>({...f,bill_from:e.target.value}))}/></FormRow>
            <FormRow label='Bill To'><Input value={editForm.bill_to} onChange={e=>setEditForm(f=>({...f,bill_to:e.target.value}))}/></FormRow>
            <FormRow label='Ship From'><Input value={editForm.ship_from} onChange={e=>setEditForm(f=>({...f,ship_from:e.target.value}))}/></FormRow>
            <FormRow label='Ship To'><Input value={editForm.ship_to} onChange={e=>setEditForm(f=>({...f,ship_to:e.target.value}))}/></FormRow>
          </div>
        </div>
      )}
      {!editing && (inv.bill_from || inv.bill_to || inv.ship_from || inv.ship_to || inv.eway_bill_no) && (
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
          {!editing && !ewbEdit && !isLocked && (
            <Btn size='sm' variant='ghost' onClick={openEwbEdit}>
              {inv.eway_bill_no ? 'Edit' : '+ Add'}
            </Btn>
          )}
        </div>
        {editing && !isLocked ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {!inv.eway_bill_no && inv.invoice_type === 'sales' && (
              <div style={{background:'#fff3cc',border:'1px solid #e6c040',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#7a5000'}}>
                📦 Entering an E-way Bill number moves stock from the seller to the buyer when you click "Save Changes".
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormRow label='EWB Number' error={editForm.eway_bill_no && !isValidEwayBill(editForm.eway_bill_no) ? EWAY_BILL_ERROR : undefined}>
                <Input value={editForm.eway_bill_no} onChange={e => setEditForm(f => ({...f, eway_bill_no: e.target.value}))} placeholder='e.g. 421234567890' />
              </FormRow>
              <FormRow label='EWB Date'><Input type='date' value={editForm.eway_bill_date} onChange={e => setEditForm(f => ({...f, eway_bill_date: e.target.value}))} /></FormRow>
            </div>
          </div>
        ) : ewbEdit && !isLocked ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {!inv.eway_bill_no && inv.invoice_type === 'sales' && (
              <div style={{background:'#fff3cc',border:'1px solid #e6c040',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#7a5000'}}>
                📦 Saving an E-way Bill number here moves stock now: {lines.length} line item(s) totalling{' '}
                <strong>{formatQty(lines.reduce((s,l)=>s+Number(l.qty||0),0))}</strong> unit(s) leave{' '}
                <strong>{inv.seller?.short_name || inv.seller?.name}</strong> and land with{' '}
                <strong>{inv.buyer?.short_name || inv.buyer?.name}</strong>
                {inv.buyer?.type !== 'external' && <> — {inv.buyer?.short_name || inv.buyer?.name}'s purchase entry is auto-completed too</>}.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormRow label='EWB Number' error={!isValidEwayBill(ewbForm.eway_bill_no) ? EWAY_BILL_ERROR : undefined}>
                <Input value={ewbForm.eway_bill_no} onChange={e => setEwbForm(f => ({...f, eway_bill_no: e.target.value}))} placeholder='e.g. 421234567890' />
              </FormRow>
              <FormRow label='EWB Date'>
                <Input type='date' value={ewbForm.eway_bill_date} onChange={e => setEwbForm(f => ({...f, eway_bill_date: e.target.value}))} />
              </FormRow>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Btn variant='ghost' onClick={() => setEwbEdit(false)}>Cancel</Btn>
              <Btn onClick={saveEwbForm} disabled={sectSaving}>{sectSaving ? 'Saving…' : 'Save'}</Btn>
            </div>
          </div>
        ) : inv.eway_bill_no ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0', fontSize: '13px' }}>
            {[
              ['EWB No',       inv.eway_bill_no],
              ['EWB Date',     fmtDate(inv.eway_bill_date)],
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
              ? `No E-way Bill entered. Invoice is ${inv.status} — locked from further edits.`
              : <>No E-way Bill entered. Click <strong>+ Add</strong> to fill in.</>}
          </div>
        )}
        {/* CHANGED: one row per vehicle, each with its own transporter challan.
            Saves field-by-field on its own, independent of the E-way Bill form
            and of "Save Changes". onMirror keeps `inv` (and so the printed
            invoice) in step without reloading the page. */}
        <InvoiceVehicles invoiceId={id} locked={isLocked} onToast={setToast}
          onMirror={mirror => setInv(i => i ? { ...i, ...mirror } : i)} />
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
          {!editing && !irnEdit && !isLocked && (
            <Btn size='sm' variant='ghost' onClick={openIrnEdit}>
              {(inv.einvoice_irn || inv.einvoice_ack_no) ? 'Edit' : '+ Add'}
            </Btn>
          )}
        </div>
        {editing && !isLocked ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <FormRow label='IRN (Invoice Reference Number)'>
              <Input value={editForm.einvoice_irn} onChange={e => setEditForm(f => ({...f, einvoice_irn: e.target.value}))} placeholder='64-character hash from GST portal' style={{ fontFamily: 'monospace', fontSize: '12px' }} />
            </FormRow>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormRow label='Acknowledgement No'><Input value={editForm.einvoice_ack_no} onChange={e => setEditForm(f => ({...f, einvoice_ack_no: e.target.value}))} placeholder='Ack number' style={{ fontFamily: 'monospace' }} /></FormRow>
              <FormRow label='Acknowledgement Date'><Input type='date' value={editForm.einvoice_ack_date} onChange={e => setEditForm(f => ({...f, einvoice_ack_date: e.target.value}))} /></FormRow>
            </div>
            <FormRow label='QR Code Data'>
              <Textarea value={editForm.einvoice_qr_code} onChange={e => setEditForm(f => ({...f, einvoice_qr_code: e.target.value}))} rows={3} placeholder='Paste QR code data from signed e-invoice PDF' style={{ fontFamily: 'monospace', fontSize: '11px' }} />
            </FormRow>
          </div>
        ) : irnEdit && !isLocked ? (
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
      {editing
        ? <div style={{ marginTop: '12px' }}><FormRow label='Notes'><Textarea value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))} rows={2}/></FormRow></div>
        : inv.notes && <div style={{ marginTop: '12px', fontSize: '13px', color: C.textSoft }}><strong>Notes:</strong> {inv.notes}</div>}

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
      <ConfirmModal open={confirmParties} onClose={() => setConfirmParties(false)} onConfirm={() => { setConfirmParties(false); handleSaveEdit(true) }}
        title='Change seller / buyer'
        message={`You are changing the seller or buyer on ${inv.invoice_no || 'this invoice'}.${inv.eway_bill_no ? ' Its E-way Bill is already entered, so stock moves to the new parties and the buyer purchase entry is re-pointed (or cancelled if the new buyer is external).' : ''}${Number(inv.paid_amount) > 0 ? ' Payments already recorded against it move to the new parties too.' : ''} The invoice number is not changed. Continue?`}
        danger />
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={handleDelete}
        title='Delete Invoice' message={`Delete ${inv.invoice_no || 'this invoice'}? This cannot be undone.`} danger />

      <Modal open={linesCsvModal} onClose={() => setLinesCsvModal(false)} title='Bulk Upload — Correct Line Items' width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: C.textMid }}>
            Columns: <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>line_no,product,description,hsn_code,qty,unit,rate,gst_rate</code><br />
            This <b>replaces every line</b> currently in the editor below with the rows in this file — download your current lines first,
            correct the numbers in Excel/Sheets, then re-upload. <code>line_no</code> matches a row back to its existing product/line;
            leave <code>product</code> blank on a row to keep that line's current product. Extra columns (taxable_amount, etc.) are ignored — they're recomputed.
          </div>
          <Btn size='sm' variant='ghost' onClick={handleExportEditLines}>↓ Download Current Lines as Template</Btn>
          <CsvFileDrop onText={setLinesCsvText} />
          <textarea value={linesCsvText} onChange={e => setLinesCsvText(e.target.value)} rows={8} placeholder='Or paste CSV data here…'
            style={{ padding: '8px', border: `1px solid ${C.border}`, borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace', resize: 'vertical' }} />
          {linesCsvResult && (
            <div style={{ background: linesCsvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${linesCsvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              {linesCsvResult.loaded} line(s) loaded into the editor{linesCsvResult.errors.length ? ` — ${linesCsvResult.errors.length} warning(s)` : ''}. Review below, then Save Changes.
              {linesCsvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setLinesCsvModal(false)}>Close</Btn>
            <Btn onClick={handleBulkLinesCsv} disabled={linesCsvSaving || !linesCsvText.trim()}>{linesCsvSaving ? 'Loading…' : 'Load Into Editor'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function Invoices() {
  return (
    // CHANGED: the list stays mounted underneath an open invoice — see components/KeepListMounted.jsx
    <KeepListMounted List={InvoiceList}>
      <Route path='new'    element={<NewInvoice />} />
      <Route path=':id'    element={<InvoiceDetail />} />
    </KeepListMounted>
  )
}
