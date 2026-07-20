import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { fetchAllPages } from '../../utils/query'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, CsvFileDrop,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum, round2, roundRupees } from '../../utils/money'
import { fmtDate, today, currentFYLabel, parseFlexibleDate, fyCodeForDate } from '../../utils/dates'
import { suggestNextNo } from '../../utils/numbering'
import { buildHSNMap, resolveGSTRate } from '../../utils/hsn'
import { calcLineTax } from '../../utils/tax'
import { withTimeout } from '../../utils/query'
import { cleanProductName, productMatchKey, findNearMatchProduct } from '../../utils/products'
import DocumentAttachments from '../../components/DocumentAttachments'
import { downloadTemplate, downloadCSV, detectDelimiter, parseCSVLine } from '../../utils/csvTemplate'
import { useAuth } from '../../hooks/useAuth'
import { hasFullAccess } from '../../utils/roles'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { printDocument, ENTITY_DOC_COLUMNS } from '../../utils/documentTemplate'
import { downloadDocumentExcel } from '../../utils/documentExcel'
import { getDriveViewUrl } from '../../utils/drive'

// A PO's letterhead/issuer is the BUYER (the entity placing the order) —
// the vendor being ordered from goes in the "Bill To" block. This is the
// reverse of PI/Invoice, where the seller is the issuer.
//
// Fetches its own full entity rows (address/bank/logo columns) by id rather
// than relying on the page's own load() query to embed them — this keeps
// the wider, newer entity columns (which may not exist yet until migration
// 025_entity_logo.sql is applied) isolated to document generation, so a
// missing column here can never break the PO detail page itself loading.
export async function buildPODoc(po, lines) {
  const [{ data: buyer }, { data: seller }] = await Promise.all([
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', po.buyer_entity_id).single(),
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', po.seller_entity_id).single(),
  ])
  let logoSrc = null
  if (buyer?.logo_file_id) { try { logoSrc = await getDriveViewUrl(buyer.logo_file_id) } catch { /* no logo — text-only header */ } }
  return {
    docType: 'PO',
    docNo: po.po_no, docDate: po.po_date, validOrDueDate: po.delivery_date,
    paymentTerms: po.payment_terms, deliveryTimeline: po.delivery_timeline, modeOfTransport: po.mode_of_transport || 'Road',
    sellerEntity: { ...buyer, logoSrc },
    buyerEntity: seller,
    lines,
    totals: { taxable_amount: po.taxable_amount, cgst_amount: po.cgst_amount, sgst_amount: po.sgst_amount, igst_amount: po.igst_amount, round_off_amount: po.round_off_amount, total_amount: po.total_amount },
    interstate: po.is_interstate,
    bankDetails: buyer,
    notes: po.notes,
    // CHANGED: see PI/index.jsx's buildPIDoc for the full rationale — these
    // were captured on the form but never reached the printed document.
    dispatchInfo: { billFrom: po.bill_from, billTo: po.bill_to, shipFrom: po.ship_from, shipTo: po.ship_to },
  }
}

const PO_STATUSES = ['open', 'partial', 'completed', 'cancelled']

// CHANGED: LineItemsEditor lines carry UI-only helper fields (_id, _cost_rate,
// _margin_pct, _hsn_*) that are NOT columns on purchase_order_lines. Sending
// them made every insert fail with "Could not find the '_id' column…". This
// keeps only the real DB columns. (The old `_id: undefined` trick didn't work —
// undefined survives supabase-js serialization for some fields, and the other
// _-prefixed helpers were still being sent regardless.)
const PO_LINE_COLUMNS = [
  'product_id', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate',
  'taxable_amount', 'cgst_rate', 'cgst_amount', 'sgst_rate', 'sgst_amount',
  'igst_rate', 'igst_amount', 'total_amount',
]
function toPOLinePayload(computedLine, poId, lineNo) {
  const out = { po_id: poId, line_no: lineNo }
  for (const col of PO_LINE_COLUMNS) if (computedLine[col] !== undefined) out[col] = computedLine[col]
  return out
}

const EMPTY_FORM = {
  po_date: today(), delivery_date: '', status: 'open',
  buyer_entity_id: '', seller_entity_id: '',
  order_id: '', order_leg_id: '', pi_id: '',
  is_interstate: false, notes: '',
  bill_from: '', bill_to: '', ship_from: '', ship_to: '',
  po_no: '', // CHANGED: optional manual PO number — blank suggests one via suggestNextNo()
  // CHANGED: same gap as PI — the generated PDF/Excel has always had a
  // Payment Terms/Delivery Timeline/Mode of Transport row that nothing
  // ever collected, so it rendered blank on every document.
  payment_terms: '', delivery_timeline: '', mode_of_transport: 'Road',
}

const PAYMENT_TERMS_OPTIONS = ['100% Advance', 'Net 30 Days', 'Net 45 Days', 'Net 60 Days', '50% Advance, 50% on Delivery', 'Against Delivery', 'LC at Sight', 'Cash on Delivery']
const TRANSPORT_MODES = ['Road', 'Air', 'Rail', 'Sea', 'Courier']

// ─── PO List ──────────────────────────────────────────────────────────────────
function POList() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: bulk delete — restricted to 'master' role (see PI page for rationale)
  const canDelete = hasFullAccess(profile)
  // CHANGED: which entities this user may raise a PO *as buyer* — the buyer
  // converts the seller's PI into their own PO, so buyer is the writing side
  // (see 015_fix_po_write_gate.sql — po_write is gated on buyer_entity_id).
  const { entities: accessEntities, frozen: buyerEntityFrozen, defaultEntityId } = useEntityAccess()
  const [selected, setSelected] = useState(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [pos, setPOs]       = useState([])
  const [entities, setEntities] = useState([])
  const [orders, setOrders] = useState([])
  const [pis, setPIs]       = useState([])
  // CHANGED: needed to resolve/auto-create products for CSV-uploaded lines —
  // same product_id=null gap found in PI and Invoice CSV upload also existed
  // here.
  const [products, setProducts] = useState([])
  const [hsnMap, setHsnMap] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]     = useState(EMPTY_FORM)
  const [legs, setLegs]     = useState([])
  const [poLines, setPOLines] = useState([])
  const [linesLoading, setLinesLoading] = useState(false)  // CHANGED: PI line-item fetch in progress
  const [saving, setSaving] = useState(false)
  const [toast, setToast]   = useState(null)
  const [csvModal, setCsvModal]   = useState(false)
  const [csvText, setCsvText]     = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ps }, { data: es }, { data: os }, { data: piData }, { data: hsnRows }, { data: prods }] = await Promise.all([
      supabase.from('purchase_orders')
        .select('*, buyer:buyer_entity_id(name,short_name), seller:seller_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).order('po_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('proforma_invoices').select('id,pi_no,from_entity_id,to_entity_id,order_id,order_leg_id').eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('hsn_master').select('*').eq('is_active', true),
      // CHANGED: for CSV product resolution below. Paginated — products can
      // exceed PostgREST's default 1000-row cap, which would otherwise
      // silently drop products past that point from CSV matching.
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate')),
    ])
    setPOs(ps || [])
    setEntities(es || [])
    setOrders(os || [])
    setPIs(piData || [])
    setHsnMap(buildHSNMap(hsnRows || []))
    setProducts(prods || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) {
    setForm(f => {
      const updated = { ...f, [k]: v }
      if (k === 'buyer_entity_id' || k === 'seller_entity_id') {
        const buyerId  = k === 'buyer_entity_id'  ? v : f.buyer_entity_id
        const sellerId = k === 'seller_entity_id' ? v : f.seller_entity_id
        const buyerE   = entities.find(e => e.id === buyerId)
        const sellerE  = entities.find(e => e.id === sellerId)
        if (buyerE?.state_code && sellerE?.state_code)
          updated.is_interstate = buyerE.state_code !== sellerE.state_code
      }
      return updated
    })
  }

  // CHANGED: selecting a linked PI previously only prefilled buyer/seller —
  // the actual planned line items from the PI never carried over, so every
  // PO required re-typing every line by hand even though the PI already had
  // them. Now pulls the PI's order/leg and its proforma_invoice_lines in,
  // converting them into PO line shape (recomputed via computeLine so tax
  // splits match this PO's own is_interstate). Only overwrites poLines when
  // it's empty, so it won't clobber lines you've already started editing.
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
    if (!piId || poLines.length > 0) return
    // CHANGED: show a visible "loading" state while the PI lines are fetched
    // (previously nothing appeared, so a slow query looked like a freeze), and
    // bound the wait with a timeout so it can't hang the modal indefinitely.
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
        // handlers — lines injected directly via setPOLines skip it, leaving
        // taxable_amount/total_amount at 0. Run it up front so the preview is
        // correct immediately.
        setPOLines(piLines.map((l, i) => computeLine({
          _id: Date.now() + i, line_no: i + 1,
          product_id: l.product_id || '', description: l.description,
          hsn_code: l.hsn_code, qty: l.qty, unit: l.unit,
          rate: l.rate, gst_rate: l.gst_rate,
          _hsn_resolved_rate: null, _hsn_override: false, _cost_rate: null, _margin_pct: '',
        }, form.is_interstate)))
      } else {
        // CHANGED: make "nothing to load" explicit — otherwise a PI with no
        // saved lines just silently shows an empty table, which looks like a
        // hang. (This is exactly what happened with PI/LS/01.)
        setToast({ message: `${pi?.pi_no || 'This PI'} has no line items saved — add lines manually below, or open the PI to check it.`, type: 'info' })
      }
    } catch (e) {
      setToast({ message: `Could not load PI lines: ${e.message}`, type: 'error' })
    } finally {
      setLinesLoading(false)
    }
  }

  // Picking an Order Leg (without manually touching Linked PI) should behave
  // the same as picking the PI directly — find the PI already tied to that
  // leg and pull its lines in. Otherwise users who go Order → Leg first (the
  // natural order when creating a PO against an existing order) never see
  // their line items auto-load, since Linked PI silently stays unset even
  // though a matching PI exists (confirmed against real data: PI order_leg_id
  // does get set once a PI is tied to a leg).
  function handleLegSelect(legId) {
    if (!legId || form.pi_id) return
    const pi = pis.find(p => p.order_leg_id === legId)
    if (pi) handlePISelect(pi.id)
  }

  async function loadLegs(orderId) {
    if (!orderId) { setLegs([]); return }
    const { data } = await supabase.from('order_legs')
      .select('id,leg_no,from_entity:from_entity_id(name,short_name),to_entity:to_entity_id(name,short_name)')
      .eq('order_id', orderId).order('leg_no')
    setLegs(data || [])
  }

  async function handleSave() {
    if (!form.buyer_entity_id || !form.seller_entity_id) return setToast({ message: 'Buyer and Seller are required', type: 'error' })
    const totals = computeTotals(poLines.map(l => computeLine(l, form.is_interstate)))
    setSaving(true)
    // CHANGED: use the manually-entered PO number if supplied, else suggest
    // one via suggestNextNo(). FY code computed directly from the PO's own
    // date (Indian FY: Apr–Mar) — no financial_years lookup needed.
    const fyCode = fyCodeForDate(form.po_date)
    let poNo = (form.po_no || '').trim()
    if (poNo) {
      const dup = pos.find(p => p.po_no?.toLowerCase() === poNo.toLowerCase())
      if (dup) { setSaving(false); return setToast({ message: `PO number "${poNo}" is already in use`, type: 'error' }) }
    } else {
      const buyerEntity = entities.find(e => e.id === form.buyer_entity_id)
      poNo = await suggestNextNo({ table: 'purchase_orders', noCol: 'po_no', entityShort: buyerEntity?.short_name || buyerEntity?.name, fyCode })
    }
    // CHANGED: financial_year_id does NOT exist on the live purchase_orders
    // table (confirmed via information_schema).
    const payload = { ...form, ...totals, po_no: poNo }
    if (!payload.order_id)     delete payload.order_id
    if (!payload.order_leg_id) delete payload.order_leg_id
    if (!payload.pi_id)        delete payload.pi_id
    if (!payload.delivery_date) delete payload.delivery_date

    const { data: po, error } = await supabase.from('purchase_orders').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }

    if (poLines.length > 0) {
      const linesPayload = poLines.map((l, i) => toPOLinePayload(computeLine(l, form.is_interstate), po.id, i + 1))
      // CHANGED: was never checking this insert's result — a silent failure
      // left a PO header with zero lines and no indication anything went wrong.
      const { error: lErr } = await supabase.from('purchase_order_lines').insert(linesPayload)
      if (lErr) {
        setSaving(false)
        return setToast({ message: `PO was created, but its line items failed to save: ${lErr.message}. Delete this PO and try again.`, type: 'error' })
      }
    }

    setSaving(false)
    setToast({ message: 'PO created', type: 'success' })
    setModalOpen(false)
    setPOLines([])
    navigate(`/po/${po.id}`)
  }

  // ── CSV handler ───────────────────────────────────────────────────────────────
  // Format: po_date,buyer_entity,seller_entity,is_interstate,product,description,hsn_code,qty,unit,rate,gst_rate,delivery_date,notes,po_no
  // CHANGED: po_no is optional — blank = suggested via suggestNextNo(); if
  // supplied, used as-is after a duplicate check (existing POs + this file).
  // CHANGED: added a "product" column + resolution step — same product_id=null
  // gap found and fixed in PI and Invoice CSV upload also existed here.
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    // CHANGED: quote-aware parsing — same fix applied to PI/Invoices, plain
    // split(delim) shredded any product name/description containing a comma
    // inside quotes.
    const header = parseCSVLine(lines[0], delim).map(h => h.trim().toLowerCase())
    let created = 0, errors = []
    const usedPoNos = new Set(pos.map(p => p.po_no?.toLowerCase()).filter(Boolean))
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i], delim)
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.po_date}__${row.buyer_entity}__${row.seller_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }

    // CHANGED: resolve/auto-create products up front, across all groups —
    // same approach as Opening Stock / PI / Invoices CSV handlers.
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
        nearMatchNotes.push(`${r.product} @ ${formatINR(toNum(r.rate))} → matched to existing "${near.name}" @ ${formatINR(near.default_rate)} (rate close enough, not creating a duplicate)`)
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

    for (const group of Object.values(groups)) {
      const { meta, lines: gLines } = group
      const buyerE  = entities.find(e => e.short_name?.toLowerCase() === meta.buyer_entity?.toLowerCase()  || e.name?.toLowerCase() === meta.buyer_entity?.toLowerCase())
      const sellerE = entities.find(e => e.short_name?.toLowerCase() === meta.seller_entity?.toLowerCase() || e.name?.toLowerCase() === meta.seller_entity?.toLowerCase())
      if (!buyerE)  { errors.push(`Buyer "${meta.buyer_entity}" not found`); continue }
      if (!sellerE) { errors.push(`Seller "${meta.seller_entity}" not found`); continue }

      // CHANGED: normalize date (accepts YYYY-MM-DD or DD-MM-YYYY) — a raw
      // DD-MM-YYYY string sent straight to Postgres fails with "date/time
      // field value out of range" once the day exceeds 12.
      const poDate = parseFlexibleDate(meta.po_date)
      if (!poDate) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: po_date "${meta.po_date}" is not a valid date — use YYYY-MM-DD or DD-MM-YYYY`); continue }
      const deliveryDate = meta.delivery_date ? parseFlexibleDate(meta.delivery_date) : null
      if (meta.delivery_date && !deliveryDate) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: delivery_date "${meta.delivery_date}" is not a valid date`); continue }

      // CHANGED: po_no taken from the CSV if supplied, else suggested via
      // suggestNextNo(). FY code computed directly from this row's own
      // poDate (Indian FY: Apr–Mar) instead of a financial_years lookup.
      const fyCode = fyCodeForDate(poDate)
      let poNo = (meta.po_no || '').trim()
      if (poNo) {
        if (usedPoNos.has(poNo.toLowerCase())) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: PO number "${poNo}" is already in use`); continue }
      } else {
        poNo = await suggestNextNo({ table: 'purchase_orders', noCol: 'po_no', entityShort: buyerE.short_name || buyerE.name, fyCode, excludeSet: usedPoNos })
      }
      usedPoNos.add(poNo.toLowerCase())

      // CHANGED: require a resolvable product per line — a line with no
      // product reference cannot be tracked in stock, so we reject it
      // clearly rather than silently inserting it with product_id = null.
      let lineErr = false
      const interstate = meta.is_interstate === 'true' || (buyerE.state_code && sellerE.state_code && buyerE.state_code !== sellerE.state_code)
      const poLines = gLines.map((r, i) => {
        const product = r.product?.trim() ? findProduct(r) : null
        if (r.product?.trim() && !product) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}, line ${i+1}: product "${r.product}" could not be resolved or created`); lineErr = true }
        if (!r.product?.trim()) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}, line ${i+1}: product column is required for stock tracking`); lineErr = true }
        const rate = toNum(r.rate); const qty = toNum(r.qty); const taxable = round2(qty * rate)
        // CHANGED: resolve GST rate from HSN master using this row's own
        // po_date (same as PI's CSV upload fix — see that file for the full
        // rationale) instead of taking the CSV's gst_rate column as literal
        // truth. Falls back to the CSV's own gst_rate (or 18) only when HSN
        // master has no resolvable rate.
        const resolved = r.hsn_code ? resolveGSTRate(r.hsn_code, rate, hsnMap, poDate) : { gst_rate: null }
        const gstRate = resolved.gst_rate !== null ? resolved.gst_rate : (toNum(r.gst_rate) || 18)
        // CHANGED: use the shared calcLineTax (same math the interactive
        // editor uses via computeLine) instead of a separately duplicated
        // inline formula — see PI/index.jsx's handleCSV for the full
        // rationale.
        const tax = calcLineTax(taxable, gstRate, interstate)
        return { line_no: i+1, product_id: product?.id || null, description: r.description, hsn_code: r.hsn_code, qty, unit: r.unit||'Nos', rate, gst_rate: gstRate, taxable_amount: taxable, ...tax, total_amount: round2(taxable+tax.total_tax) }
      })
      if (lineErr) continue
      const rawTotals = poLines.reduce((acc, l) => ({ taxable_amount: acc.taxable_amount+l.taxable_amount, cgst_amount: acc.cgst_amount+l.cgst_amount, sgst_amount: acc.sgst_amount+l.sgst_amount, igst_amount: acc.igst_amount+l.igst_amount, total_amount: acc.total_amount+l.total_amount, total_qty: acc.total_qty+l.qty }), { taxable_amount:0,cgst_amount:0,sgst_amount:0,igst_amount:0,total_amount:0,total_qty:0 })
      // Round off to the nearest whole rupee at the header level only — see
      // computeTotals() in LineItemsEditor.jsx for why.
      const poPreciseSubtotal = round2(rawTotals.taxable_amount + rawTotals.cgst_amount + rawTotals.sgst_amount + rawTotals.igst_amount)
      const poFinalTotal = roundRupees(poPreciseSubtotal)
      const totals = { ...rawTotals, taxable_amount: round2(rawTotals.taxable_amount), cgst_amount: round2(rawTotals.cgst_amount), sgst_amount: round2(rawTotals.sgst_amount), igst_amount: round2(rawTotals.igst_amount), total_amount: poFinalTotal, round_off_amount: round2(poFinalTotal - poPreciseSubtotal) }
      const { data: po, error: poErr } = await supabase.from('purchase_orders').insert({ po_date: poDate, buyer_entity_id: buyerE.id, seller_entity_id: sellerE.id, is_interstate: interstate, delivery_date: deliveryDate, notes: meta.notes||null, status: 'open', po_no: poNo, ...totals }).select().single()
      if (poErr) { errors.push(`PO ${meta.po_date}: ${poErr.message}`); continue }
      const { error: lineInsertErr } = await supabase.from('purchase_order_lines').insert(poLines.map(l => ({ ...l, po_id: po.id })))
      if (lineInsertErr) { errors.push(`PO ${poNo}: header created but line items failed to save: ${lineInsertErr.message}`); continue }
      created++
    }
    setCsvSaving(false); setCsvResult({ created, errors, nearMatchNotes }); load()
  }

  function handleExportCSV() {
    downloadCSV(`po_export_${today()}.csv`,['po_no','po_date','buyer','seller','delivery_date','tax_type','status','total_amount'],filtered.map(p=>({po_no:p.po_no||'',po_date:p.po_date,buyer:p.buyer?.name||'',seller:p.seller?.name||'',delivery_date:p.delivery_date||'',tax_type:p.is_interstate?'Interstate':'Local',status:p.status,total_amount:p.total_amount||0})))
  }

  const filtered = pos.filter(p => {
    const mdf = !dateFrom || p.po_date >= dateFrom
    const mdt = !dateTo   || p.po_date <= dateTo
    const ms  = !search || (p.po_no || '').toLowerCase().includes(search.toLowerCase()) ||
      p.buyer?.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.seller?.name?.toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter === 'all' || p.status === statusFilter
    return ms && mst && mdf && mdt
  })

  function toggleSelect(id) {
    setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleSelectAll() {
    setSelected(s => s.size === filtered.length ? new Set() : new Set(filtered.map(p => p.id)))
  }
  async function handleBulkDelete() {
    setBulkDeleting(true)
    const { error } = await supabase.from('purchase_orders').update({ is_deleted: true }).in('id', [...selected])
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${selected.size} PO(s) deleted`, type: 'success' })
    setSelected(new Set())
    load()
  }

  // CHANGED: live totals for the New PO modal — shown at top and bottom so the
  // buyer can confirm the figures before creating the PO.
  const modalTotals = computeTotals(poLines.map(l => computeLine(l, form.is_interstate)))

  const columns = [
    ...(canDelete ? [{
      label: <input type='checkbox' checked={filtered.length > 0 && selected.size === filtered.length}
        onChange={toggleSelectAll} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
      render: p => <input type='checkbox' checked={selected.has(p.id)}
        onChange={() => toggleSelect(p.id)} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
    }] : []),
    { label: 'S.No.',   render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    { label: 'PO No',   render: p => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{p.po_no || '—'}</span> },
    { label: 'Buyer',   render: p => <span style={{ fontSize: '12px' }}>{p.buyer?.short_name || p.buyer?.name}</span> },
    { label: 'Seller',  render: p => <span style={{ fontSize: '12px' }}>{p.seller?.short_name || p.seller?.name}</span> },
    { label: 'Date',    render: p => <span style={{ fontSize: '12px' }}>{fmtDate(p.po_date)}</span> },
    { label: 'Delivery',render: p => <span style={{ fontSize: '12px', color: C.textSoft }}>{p.delivery_date ? fmtDate(p.delivery_date) : '—'}</span> },
    { label: 'Qty', right: true, render: p => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{p.total_qty || '—'}</span> },
    { label: 'Amount',  right: true, render: p => <span style={{ fontWeight: 600 }}>{formatINR(p.total_amount)}</span> },
    { label: 'Status',  render: p => <Badge status={p.status} /> },
  ]

  return (
    <div>
      <PageHeader
        title='Purchase Orders'
        subtitle="Buyer's confirmation of intent to purchase"
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
            <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
            <Btn onClick={() => { setForm({ ...EMPTY_FORM, buyer_entity_id: defaultEntityId }); setPOLines([]); setModalOpen(true) }}>+ New PO</Btn>
          </div>
        }
      />

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search PO no, entity…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit' }} />
        <select value={statusFilter} onChange={e => setStatus(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type='date' value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='From date'/>
        <input type='date' value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{padding:'8px 10px',border:`1.5px solid ${C.border}`,borderRadius:'6px',background:C.surface,fontSize:'13px',outline:'none',fontFamily:'inherit'}} title='To date'/>
        {(dateFrom||dateTo)&&<Btn size='sm' variant='ghost' onClick={()=>{setDateFrom('');setDateTo('')}}>Clear</Btn>}
      </div>

      {canDelete && selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fdeeee', border: '1px solid #f0c4c4', borderRadius: '6px', padding: '10px 14px', marginBottom: '14px' }}>
          <span style={{ fontSize: '13px', color: '#8a2f2f' }}>{selected.size} PO{selected.size > 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn size='sm' variant='ghost' onClick={() => setSelected(new Set())}>Clear</Btn>
            <Btn size='sm' variant='danger' onClick={() => setConfirmBulkDelete(true)} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : 'Delete Selected'}</Btn>
          </div>
        </div>
      )}

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={p => navigate(`/po/${p.id}`)}
              emptyState={<EmptyState icon='📋' title='No purchase orders' action={<Btn onClick={() => setModalOpen(true)}>+ New PO</Btn>} />} />
        }
      </Card>

      <ConfirmModal open={confirmBulkDelete} onClose={() => setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Purchase Orders' message={`Delete ${selected.size} selected PO(s)? This cannot be undone.`} danger />

      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Purchase Orders' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('po')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>po_date,buyer_entity,seller_entity,is_interstate,product,description,hsn_code,qty,unit,rate,gst_rate,delivery_date,notes,po_no</code><br /><br />
            Multiple rows with same <strong>po_date + buyer + seller</strong> are grouped into one PO. <code>po_no</code> is optional — leave it blank to auto-generate, or supply your own (checked against existing POs and other rows in this file). <strong>product</strong> is required — match an existing product name exactly, or a new product is auto-created from this row's hsn_code/gst_rate/rate/unit. Lines without a resolvable product are rejected (stock tracking depends on this link).
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
          </FormRow>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.created} POs created.</strong>
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

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Purchase Order' width={900}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{background:'#e8f3ec',border:'1px solid #b8dfca',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#1a5c30'}}>📅 Will be created under <strong>{currentFYLabel()}</strong></div>
            {/* CHANGED: totals summary + a Create button at the top so the PO can
                be reviewed and created without scrolling to the bottom. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div style={{ textAlign: 'right', fontSize: '12px', color: C.textMid, lineHeight: 1.5 }}>
                <div>Taxable: <strong style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{formatINR(modalTotals.taxable_amount)}</strong>
                  {'  '}·{'  '}Tax: <strong style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{formatINR(modalTotals.cgst_amount + modalTotals.sgst_amount + modalTotals.igst_amount)}</strong></div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>Total: {formatINR(modalTotals.total_amount)}</div>
              </div>
              <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create PO'}</Btn>
            </div>
          </div>
          <SectionDivider label='Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
            <FormRow label='PO Date' required>
              <Input type='date' value={form.po_date} onChange={e => setF('po_date', e.target.value)} />
            </FormRow>
            <FormRow label='PO Number' hint='Leave blank to auto-generate'>
              <Input value={form.po_no} onChange={e => setF('po_no', e.target.value)} placeholder='Auto-generated if blank' />
            </FormRow>
            <FormRow label='Delivery Date'>
              <Input type='date' value={form.delivery_date} onChange={e => setF('delivery_date', e.target.value)} />
            </FormRow>
            <FormRow label='Linked PI'>
              <Select value={form.pi_id} onChange={e => handlePISelect(e.target.value)}>
                <option value=''>No PI linked</option>
                {pis.map(p => <option key={p.id} value={p.id}>{p.pi_no || p.id.slice(0, 8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Buyer Entity' required hint={buyerEntityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.buyer_entity_id} onChange={e => setF('buyer_entity_id', e.target.value)} disabled={buyerEntityFrozen}>
                <option value=''>Select buyer</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Seller Entity' required>
              <Select value={form.seller_entity_id} onChange={e => setF('seller_entity_id', e.target.value)}>
                <option value=''>Select seller</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Tax Type'>
              <Select value={form.is_interstate ? '1' : '0'} onChange={e => setF('is_interstate', e.target.value === '1')}>
                <option value='0'>Local — Same State (CGST + SGST)</option>
                <option value='1'>Interstate — Different State (IGST)</option>
              </Select>
            </FormRow>
            <FormRow label='Order'>
              <Select value={form.order_id} onChange={e => { setF('order_id', e.target.value); loadLegs(e.target.value) }}>
                <option value=''>No order</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Order Leg'>
              <Select value={form.order_leg_id} onChange={e => { setF('order_leg_id', e.target.value); handleLegSelect(e.target.value) }} disabled={!form.order_id}>
                <option value=''>Select leg</option>
                {legs.map(l => <option key={l.id} value={l.id}>Leg {l.leg_no}: {l.from_entity?.short_name || l.from_entity?.name} → {l.to_entity?.short_name || l.to_entity?.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Payment Terms' hint='Shown on the generated PO PDF/Excel'>
              <Input list='po-payment-terms' value={form.payment_terms} onChange={e => setF('payment_terms', e.target.value)} placeholder='e.g. Net 30 Days' />
              <datalist id='po-payment-terms'>{PAYMENT_TERMS_OPTIONS.map(o => <option key={o} value={o} />)}</datalist>
            </FormRow>
            <FormRow label='Delivery Timeline' hint='Shown on the generated PO PDF/Excel'>
              <Input value={form.delivery_timeline} onChange={e => setF('delivery_timeline', e.target.value)} placeholder='e.g. 7-10 working days from confirmation' />
            </FormRow>
            <FormRow label='Mode of Transport'>
              <Select value={form.mode_of_transport} onChange={e => setF('mode_of_transport', e.target.value)}>
                {TRANSPORT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
              </Select>
            </FormRow>
          </div>
          <SectionDivider label='Line Items' />
          {linesLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#fff8e6', border: '1px solid #e6c877', borderRadius: '6px', padding: '10px 14px', fontSize: '13px', color: '#7a5000' }}>
              <span style={{ width: 16, height: 16, border: '2px solid #d9b24d', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
              Loading line items from the linked PI…
            </div>
          )}
          <LineItemsEditor lines={poLines} setLines={setPOLines} interstate={form.is_interstate} hsnMap={hsnMap} asOfDate={form.po_date} products={products} />
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create PO'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── PO Detail ────────────────────────────────────────────────────────────────
function PODetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const canDelete = hasFullAccess(profile)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [po, setPO]     = useState(null)
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [docBusy, setDocBusy] = useState('') // 'pdf' | 'excel' | ''

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: ls }] = await Promise.all([
      supabase.from('purchase_orders')
        .select('*, buyer:buyer_entity_id(name,short_name,gstin,city), seller:seller_entity_id(name,short_name,gstin,city), orders(name)')
        .eq('id', id).single(),
      // CHANGED: a plain .select() caps at PostgREST's default 1000-row
      // response — a PO with more line items than that silently lost the
      // rest, undercounting totals here vs the DB-side total_qty/total_amount
      // columns (recomputed directly in Postgres, no REST cap). Same fix as PI.
      fetchAllPages(() => supabase.from('purchase_order_lines').select('*').eq('po_id', id).order('line_no')),
    ])
    setPO(p)
    setLines(ls || [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function updateStatus(status) {
    await supabase.from('purchase_orders').update({ status }).eq('id', id)
    setToast({ message: `PO marked as ${status}`, type: 'success' })
    load()
  }

  async function handleDelete() {
    setDeleting(true)
    const { error } = await supabase.from('purchase_orders').update({ is_deleted: true }).eq('id', id)
    setDeleting(false); setConfirmDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    navigate('/po')
  }

  async function handleDownloadPDF() {
    setDocBusy('pdf')
    try { printDocument(await buildPODoc(po, lines)) }
    catch (err) { setToast({ message: err.message || 'Could not generate PDF', type: 'error' }) }
    finally { setDocBusy('') }
  }

  async function handleDownloadExcel() {
    setDocBusy('excel')
    try { downloadDocumentExcel(await buildPODoc(po, lines)) }
    catch (err) { setToast({ message: err.message || 'Could not generate Excel', type: 'error' }) }
    finally { setDocBusy('') }
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!po)     return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>PO not found.</div>

  return (
    <div>
      <button onClick={() => navigate('/po')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>← Purchase Orders</button>
      <PageHeader
        title={po.po_no || `PO — ${fmtDate(po.po_date)}`}
        subtitle={`${po.buyer?.name} ← ${po.seller?.name} · ${fmtDate(po.po_date)}`}
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Btn size='sm' variant='ghost' onClick={handleDownloadPDF} disabled={!!docBusy}>{docBusy==='pdf'?'Generating…':'⎙ Download PDF'}</Btn>
            <Btn size='sm' variant='ghost' onClick={handleDownloadExcel} disabled={!!docBusy}>{docBusy==='excel'?'Generating…':'↓ Download Excel'}</Btn>
            {po.status === 'open' && <Btn size='sm' variant='ghost' onClick={() => updateStatus('completed')}>Mark Completed</Btn>}
            {!['cancelled','completed'].includes(po.status) && <Btn size='sm' variant='ghost' onClick={() => setConfirmCancel(true)} style={{ color: C.danger }}>Cancel</Btn>}
            {canDelete && <Btn size='sm' variant='danger' onClick={() => setConfirmDelete(true)} disabled={deleting}>{deleting?'Deleting…':'Delete'}</Btn>}
            <Badge status={po.status} />
          </div>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Buyer</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{po.buyer?.name}</div>
          {po.buyer?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '2px' }}>GSTIN: {po.buyer.gstin}</div>}
        </Card>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Seller</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{po.seller?.name}</div>
          {po.seller?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '2px' }}>GSTIN: {po.seller.gstin}</div>}
        </Card>
      </div>

      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap', fontSize: '13px' }}>
        <div><span style={{ color: C.textMuted }}>PO Date:</span> <strong>{fmtDate(po.po_date)}</strong></div>
        {po.delivery_date && <div><span style={{ color: C.textMuted }}>Delivery:</span> <strong>{fmtDate(po.delivery_date)}</strong></div>}
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={po.is_interstate ? 'export' : 'domestic'} label={po.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /></div>
        {po.orders?.name && <div><span style={{ color: C.textMuted }}>Order:</span> <strong>{po.orders.name}</strong></div>}
      </div>

      <Card>
        <LineItemsEditor lines={lines.map(l => ({ ...l, _id: l.id }))} setLines={() => {}} interstate={po.is_interstate} readOnly />
      </Card>

      <div style={{ marginTop: '20px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments
          sourceType='purchase_orders'
          sourceId={po.id}
          entityId={po.buyer_entity_id} // CHANGED: required for documents.entity_id NOT NULL
          entityName={po.buyer?.name || 'General'}
        />
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel PO' message='Cancel this purchase order?' danger />
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={handleDelete}
        title='Delete PO' message={`Delete ${po.po_no || 'this PO'}? This cannot be undone.`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function PO() {
  return (
    <Routes>
      <Route index      element={<POList />} />
      <Route path=':id' element={<PODetail />} />
    </Routes>
  )
}
