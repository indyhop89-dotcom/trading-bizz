import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { fetchAllPages } from '../../utils/query'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, CsvFileDrop,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today, parseFlexibleDate, fyCodeForDate } from '../../utils/dates'
import { suggestNextNo } from '../../utils/numbering'
import { cleanProductName, productMatchKey } from '../../utils/products'
import { buildHSNMap, resolveGSTRate } from '../../utils/hsn'
import DocumentAttachments from '../../components/DocumentAttachments'
import { calcSellRate } from '../../utils/margin'
import { downloadTemplate, downloadCSV, detectDelimiter, parseCSVLine } from '../../utils/csvTemplate'
import { useAuth } from '../../hooks/useAuth'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { fetchEntityAvailableStock, findLinesMissingProductId, findLinesExceedingStock } from '../../utils/stock'

const PI_STATUSES = ['draft', 'sent', 'accepted', 'converted', 'cancelled']

// CHANGED: LineItemsEditor's computeLine() spreads calcLineTax()'s return
// (which includes `total_tax`, a combined figure used for computing
// total_amount) onto the line, plus UI-only helper fields (_id, _cost_rate,
// _margin_pct, _hsn_*) — none of these are columns on
// proforma_invoice_lines. The previous approach explicitly destructured out
// only the known UI-only fields, which missed `total_tax` and made every
// save fail with "Could not find the 'total_tax' column…". Allow-listing
// real DB columns (as PO/Invoices already do) can't miss a field this way.
const PI_LINE_COLUMNS = [
  'product_id', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate',
  'taxable_amount', 'cgst_rate', 'cgst_amount', 'sgst_rate', 'sgst_amount',
  'igst_rate', 'igst_amount', 'total_amount',
]
function toPILinePayload(computedLine, piId, lineNo) {
  const out = { pi_id: piId, line_no: lineNo }
  for (const col of PI_LINE_COLUMNS) if (computedLine[col] !== undefined) out[col] = computedLine[col]
  return out
}

const EMPTY_FORM = {
  pi_date: today(), valid_upto: '', status: 'draft',
  from_entity_id: '', to_entity_id: '',
  order_id: '', order_leg_id: '',
  is_interstate: false, notes: '',
  bill_from: '', bill_to: '', ship_from: '', ship_to: '',
  pi_no: '', // CHANGED: optional manual PI number — blank suggests one via suggestNextNo()
}

// Write planned stock movements on PI create
async function writeStockMovementsForPI(pi, lines) {
  if (!lines?.length) return
  const entries = []
  for (const l of lines) {
    if (!l.product_id||!Number(l.qty)) continue
    const date = pi.pi_date || today()
    entries.push({entity_id:pi.from_entity_id,product_id:l.product_id,posting_date:date,qty_in:0,qty_out:Number(l.qty),rate:Number(l.rate),voucher_type:'pi',voucher_id:pi.id,voucher_no:pi.pi_no||pi.id,notes:`PI outgoing — ${pi.pi_no||''}`})
    entries.push({entity_id:pi.to_entity_id,product_id:l.product_id,posting_date:date,qty_in:Number(l.qty),qty_out:0,rate:Number(l.rate),voucher_type:'pi',voucher_id:pi.id,voucher_no:pi.pi_no||pi.id,notes:`PI incoming — ${pi.pi_no||''}`})
  }
  if (entries.length) await supabase.from('stock_movements').insert(entries)
}

// ─── PI List ──────────────────────────────────────────────────────────────────
function PIList() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: bulk delete — restricted to the 'master' role, which is the only
  // elevated/full-access role in this app's schema (ROLES = master, entity_user,
  // viewer — see Settings). This matches the existing `isAdmin` convention used
  // in Payments (`profile?.role === 'master'`).
  const canDelete = profile?.role === 'master'
  // CHANGED: which entities this user may raise a PI *from* — master sees
  // all, everyone else only the entities they've been granted access to.
  const { entities: accessEntities, frozen: fromEntityFrozen, defaultEntityId } = useEntityAccess()
  const [selected, setSelected] = useState(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [pis, setPIs]           = useState([])
  const [entities, setEntities] = useState([])
  const [orders, setOrders]     = useState([])
  // CHANGED: needed to resolve/auto-create products for CSV-uploaded lines —
  // previously this handler never set product_id at all, which silently
  // broke stock tracking (Planned Stock) for every CSV-created PI line.
  const [products, setProducts] = useState([])
  const [hsnMap, setHsnMap]     = useState(new Map())
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [entityFilter, setEntityF] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]         = useState(EMPTY_FORM)
  const [legs, setLegs]         = useState([])
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  const [csvModal, setCsvModal] = useState(false)
  const [csvText, setCsvText]   = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [stockMap, setStockMap] = useState({})
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [copyModal, setCopyModal]         = useState(false)
  const [prevPIs, setPrevPIs]             = useState([])
  const [copyPiId, setCopyPiId]           = useState('')
  const [copyMarginPct, setCopyMarginPct] = useState('5')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ps }, { data: es }, { data: os }, { data: hsnRows }, { data: prods }] = await Promise.all([
      supabase.from('proforma_invoices')
        .select('*, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('hsn_master').select('*').eq('is_active', true),
      // CHANGED: for CSV product resolution below. Paginated — products can
      // exceed PostgREST's default 1000-row cap, which would otherwise
      // silently drop products past that point from CSV matching.
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate')),
    ])
    setPIs(ps||[]); setEntities(es||[]); setOrders(os||[]); setHsnMap(buildHSNMap(hsnRows||[]))
    setProducts(prods||[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // CHANGED: stockMap must reflect what the *from* entity actually has on
  // hand right now (opening + invoiced-in − invoiced-out, E-way-Bill gated),
  // not a global sum of opening balances across every entity. Recomputed
  // whenever the selected from-entity changes so the "available" hint next
  // to each line in LineItemsEditor is accurate for a PI's actual seller.
  useEffect(() => {
    if (!form.from_entity_id) { setStockMap({}); return }
    fetchEntityAvailableStock(form.from_entity_id).then(setStockMap)
  }, [form.from_entity_id])

  function setF(k, v) {
    setForm(f => {
      const updated = { ...f, [k]: v }
      // auto-detect interstate when both entities set
      if (k === 'from_entity_id' || k === 'to_entity_id') {
        const fromId = k === 'from_entity_id' ? v : f.from_entity_id
        const toId   = k === 'to_entity_id'   ? v : f.to_entity_id
        const fromE  = entities.find(e => e.id === fromId)
        const toE    = entities.find(e => e.id === toId)
        if (fromE?.state_code && toE?.state_code)
          updated.is_interstate = fromE.state_code !== toE.state_code
      }
      return updated
    })
  }

  async function loadLegs(orderId) {
    if (!orderId) { setLegs([]); return }
    const { data } = await supabase.from('order_legs')
      .select('id, leg_no, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name)')
      .eq('order_id', orderId).order('leg_no')
    setLegs(data || [])
  }

  const [piLines, setPILines] = useState([])
  // CHANGED: PI planned qty exceeding the from-entity's actual available
  // stock is a warning, not a hard block — the seller may already have more
  // incoming, or plan to fulfil from a future purchase. handleSave(true)
  // (called from the confirm modal below) skips the check and proceeds.
  const [stockWarning, setStockWarning] = useState(null)

  async function handleSave(skipStockCheck = false) {
    if (!form.from_entity_id || !form.to_entity_id) return setToast({ message: 'From and To entity are required', type: 'error' })

    // CHANGED: every stock-planning line must carry a product_id — otherwise
    // it's invisible to every stock calculation. Hard block, not a warning.
    const missing = findLinesMissingProductId(piLines)
    if (missing.length > 0) {
      return setToast({ message: `Line ${missing.map(l => l._lineNo).join(', ')}: select a product before saving — stock tracking needs it.`, type: 'error' })
    }

    if (!skipStockCheck) {
      const exceeding = findLinesExceedingStock(piLines, stockMap)
      if (exceeding.length > 0) {
        setStockWarning(`${exceeding.length} line(s) plan more quantity than ${entities.find(e => e.id === form.from_entity_id)?.short_name || 'the from-entity'} currently has in stock. Create this PI anyway?`)
        return
      }
    }

    const totals = computeTotals(piLines.map(l => computeLine(l, form.is_interstate)))
    setSaving(true)
    // CHANGED: use the manually-entered PI number if the user supplied one,
    // otherwise suggest one via suggestNextNo(). FY code is now computed
    // directly from the PI's own date (Indian FY: Apr–Mar) instead of a
    // financial_years table lookup — the DB round-trip only ever existed to
    // fetch this one string, and this removes a "no financial year found"
    // failure path that no longer served any purpose.
    const fyCode = fyCodeForDate(form.pi_date)
    let piNo = (form.pi_no || '').trim()
    if (piNo) {
      const dup = pis.find(p => p.pi_no?.toLowerCase() === piNo.toLowerCase())
      if (dup) { setSaving(false); return setToast({ message: `PI number "${piNo}" is already in use`, type: 'error' }) }
    } else {
      const fromEntity = entities.find(e => e.id === form.from_entity_id)
      piNo = await suggestNextNo({ table: 'proforma_invoices', noCol: 'pi_no', entityShort: fromEntity?.short_name || fromEntity?.name, fyCode })
    }
    // CHANGED: financial_year_id does NOT exist on the live proforma_invoices
    // table (confirmed via information_schema — only pi_no, no FK column at all).
    const payload = { ...form, ...totals, pi_no: piNo }
    if (!payload.order_id)     delete payload.order_id
    if (!payload.order_leg_id) delete payload.order_leg_id
    if (!payload.valid_upto)   delete payload.valid_upto
    const { data: pi, error: piErr } = await supabase.from('proforma_invoices').insert(payload).select().single()
    if (piErr) { setSaving(false); return setToast({ message: piErr.message, type: 'error' }) }
    if (piLines.length > 0) {
      const linesPayload = piLines.map((l, i) => toPILinePayload(computeLine(l, form.is_interstate), pi.id, i + 1))
      const { error: lErr } = await supabase.from('proforma_invoice_lines').insert(linesPayload)
      if (lErr) { setSaving(false); return setToast({ message: lErr.message, type: 'error' }) }
      await writeStockMovementsForPI(pi, linesPayload)
    }
    setSaving(false)
    setToast({ message: 'PI created', type: 'success' })
    setModalOpen(false); setPILines([])
    navigate(`/pi/${pi.id}`)
  }


  async function openCopyModal() {
    let q = supabase.from('proforma_invoices').select('id,pi_no,pi_date,total_amount,from_entity:from_entity_id(name,short_name),to_entity:to_entity_id(name,short_name)').eq('is_deleted',false).order('pi_date',{ascending:false}).limit(60)
    if (form.order_id) q = q.eq('order_id', form.order_id)
    const { data } = await q
    setPrevPIs(data||[]); setCopyPiId(data?.[0]?.id||''); setCopyModal(true)
  }

  async function handleCopyLines() {
    if (!copyPiId) return
    const { data: srcLines } = await supabase.from('proforma_invoice_lines').select('*').eq('pi_id',copyPiId).order('line_no')
    if (!srcLines?.length) return setToast({message:'Source PI has no lines',type:'error'})
    const pct = parseFloat(copyMarginPct)||0
    const newLines = srcLines.map((l,i) => {
      const costRate = Number(l.rate)
      const newRate  = pct !== 0 ? calcSellRate(costRate, pct) : costRate
      let gstRate=l.gst_rate, hsnRes=null, hsnSrc='default'
      if (hsnMap && l.hsn_code) {
        const res = resolveGSTRate(l.hsn_code, newRate, hsnMap)
        if (res.gst_rate!==null){ gstRate=res.gst_rate; hsnRes=res.gst_rate; hsnSrc=res.source }
      }
      return computeLine({_id:Date.now()+i,line_no:i+1,product_id:l.product_id||'',description:l.description||'',hsn_code:l.hsn_code||'',qty:l.qty,unit:l.unit||'Nos',rate:newRate,gst_rate:gstRate,_cost_rate:costRate,_margin_pct:String(pct),_hsn_resolved_rate:hsnRes,_hsn_source:hsnSrc,_hsn_override:false,_hsn_manually_set:false}, form.is_interstate)
    })
    setPILines(newLines); setCopyModal(false)
    setToast({message:`${newLines.length} lines copied with ${pct}% margin. HSN re-evaluated.`,type:'success'})
  }

  const filtered = pis.filter(p => {
    const mdf = !dateFrom || p.pi_date >= dateFrom
    const mdt = !dateTo   || p.pi_date <= dateTo
    const ms  = !search || (p.pi_no || '').toLowerCase().includes(search.toLowerCase()) ||
      p.from_entity?.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.to_entity?.name?.toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter === 'all' || p.status === statusFilter
    const me  = !entityFilter || p.from_entity_id === entityFilter || p.to_entity_id === entityFilter
    return ms && mst && me && mdf && mdt
  })

  // ── CSV bulk upload ──────────────────────────────────────────────────────────
  // Format: pi_date,from_entity,to_entity,is_interstate,product,description,hsn_code,qty,unit,rate,gst_rate,valid_upto,notes,pi_no
  // Multiple rows with same pi_date+from+to = grouped into one PI.
  // CHANGED: pi_no is optional — blank = suggested via suggestNextNo() (see numbering.js
  // behaviour). If supplied, that exact number is used instead, after checking it
  // isn't already used by an existing PI or another row/group in this same file.
  // CHANGED: added a "product" column + resolution step. Previously every line
  // from this uploader had product_id = null (no lookup existed at all), which
  // silently broke Planned Stock tracking for every CSV-created PI line. Now
  // mirrors the same find-or-auto-create pattern Opening Stock's CSV upload
  // already uses, and the same fix just applied to Invoices' CSV upload.
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    // CHANGED: quote-aware parsing — plain split(delim) shredded any product
    // name/description containing a comma inside quotes (e.g. "Steel Tea,
    // Coffee & Sugar Container Set, 3 Pieces") across the wrong columns.
    const header = parseCSVLine(lines[0], delim).map(h => h.trim().toLowerCase())
    let created = 0, errors = []
    // CHANGED: dedupe pool for manually-supplied pi_no values — seeded with
    // every PI number already in the DB, then grown as this file assigns more.
    const usedPiNos = new Set(pis.map(p => p.pi_no?.toLowerCase()).filter(Boolean))

    // Group rows by pi_date+from_entity+to_entity
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i], delim)
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.pi_date}__${row.from_entity}__${row.to_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }

    // CHANGED: resolve/auto-create products up front, across all groups, in
    // one batch — same approach as Stock/Opening Stock's CSV handler.
    // CHANGED: match on name + HSN + rate + GST together, not name alone — a
    // single file can list several genuinely different products sharing one
    // generic name at different rates (per product-owner decision, only merge
    // when all four fields match). New products are stored with a cleaned name.
    // CHANGED: uses a precomputed Map (key -> product) instead of an array
    // .find() re-run per row — with ~1000+ products x ~1000+ rows, a linear
    // scan recomputing the match key for every candidate on every row is
    // millions of string/regex ops, slow enough to look like a hang.
    const productMap = new Map()
    for (const p of products) {
      productMap.set(productMatchKey({ name: p.name, hsn_code: p.hsn_code, rate: p.default_rate, gst_rate: p.gst_rate }), p)
    }
    const rowMatchKey = row => productMatchKey({ name: row.product, hsn_code: row.hsn_code, rate: row.rate, gst_rate: row.gst_rate })
    const findProduct = row => productMap.get(rowMatchKey(row))
    const allRows = Object.values(groups).flatMap(g => g.lines)
    const missingKeys = new Set()
    const missingRows = []
    for (const r of allRows) {
      if (!r.product?.trim()) continue
      const k = rowMatchKey(r)
      if (productMap.has(k) || missingKeys.has(k)) continue
      missingKeys.add(k); missingRows.push(r)
    }
    if (missingRows.length > 0) {
      const payloads = missingRows.map(src => {
        return { name: cleanProductName(src.product), hsn_code: src.hsn_code || null, gst_rate: toNum(src.gst_rate) || 18, unit: src.unit || 'Nos', default_rate: toNum(src.rate) || null, is_active: true }
      })
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
      const fromE = entities.find(e => e.short_name?.toLowerCase() === meta.from_entity?.toLowerCase() || e.name?.toLowerCase() === meta.from_entity?.toLowerCase())
      const toE   = entities.find(e => e.short_name?.toLowerCase() === meta.to_entity?.toLowerCase()   || e.name?.toLowerCase() === meta.to_entity?.toLowerCase())
      if (!fromE) { errors.push(`Row group ${meta.from_entity}: entity not found`); continue }
      if (!toE)   { errors.push(`Row group ${meta.to_entity}: entity not found`);   continue }

      // CHANGED: accept YYYY-MM-DD or DD-MM-YYYY from the CSV, normalize to ISO.
      // Raw DD-MM-YYYY strings sent straight to Postgres fail with
      // "date/time field value out of range" once the day exceeds 12.
      const piDate = parseFlexibleDate(meta.pi_date)
      if (!piDate) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: pi_date "${meta.pi_date}" is not a valid date — use YYYY-MM-DD or DD-MM-YYYY`); continue }
      const validUpto = meta.valid_upto ? parseFlexibleDate(meta.valid_upto) : null
      if (meta.valid_upto && !validUpto) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: valid_upto "${meta.valid_upto}" is not a valid date`); continue }

      // CHANGED: pi_no is used from the CSV if supplied, else suggested via
      // suggestNextNo(). FY code computed directly from this row's own
      // piDate (Indian FY: Apr–Mar) instead of a financial_years lookup.
      const fyCode = fyCodeForDate(piDate)

      let piNo = (meta.pi_no || '').trim()
      if (piNo) {
        if (usedPiNos.has(piNo.toLowerCase())) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: PI number "${piNo}" is already in use`); continue }
      } else {
        piNo = await suggestNextNo({ table: 'proforma_invoices', noCol: 'pi_no', entityShort: fromE.short_name || fromE.name, fyCode, excludeSet: usedPiNos })
      }
      usedPiNos.add(piNo.toLowerCase())

      const interstate = meta.is_interstate === 'true' || (fromE.state_code && toE.state_code && fromE.state_code !== toE.state_code)

      // CHANGED: require a resolvable product per line — a line with no
      // product reference cannot be tracked in stock, so we reject it
      // clearly rather than silently inserting it with product_id = null.
      let lineErr = false
      const piLines = gLines.map((r, i) => {
        const product = r.product?.trim() ? findProduct(r) : null
        if (r.product?.trim() && !product) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}, line ${i+1}: product "${r.product}" could not be resolved or created`); lineErr = true }
        if (!r.product?.trim()) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}, line ${i+1}: product column is required for stock tracking`); lineErr = true }
        const rate    = toNum(r.rate)
        const qty     = toNum(r.qty)
        const taxable = Math.round(qty * rate)
        const gstRate = toNum(r.gst_rate) || 18
        const half    = gstRate / 2
        const igst    = interstate ? Math.round(taxable * gstRate / 100) : 0
        const cgst    = !interstate ? Math.round(taxable * half / 100) : 0
        const sgst    = cgst
        return {
          line_no: i + 1, product_id: product?.id || null, description: r.description, hsn_code: r.hsn_code,
          qty, unit: r.unit || 'Nos', rate, gst_rate: gstRate,
          taxable_amount: taxable,
          cgst_rate: half, cgst_amount: cgst,
          sgst_rate: half, sgst_amount: sgst,
          igst_rate: interstate ? gstRate : 0, igst_amount: igst,
          total_amount: taxable + igst + cgst + sgst,
        }
      })
      if (lineErr) continue

      const totals = piLines.reduce((acc, l) => ({
        taxable_amount: acc.taxable_amount + l.taxable_amount,
        cgst_amount:    acc.cgst_amount    + l.cgst_amount,
        sgst_amount:    acc.sgst_amount    + l.sgst_amount,
        igst_amount:    acc.igst_amount    + l.igst_amount,
        total_amount:   acc.total_amount   + l.total_amount,
      }), { taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_amount: 0 })

      const { data: pi, error: piErr } = await supabase.from('proforma_invoices').insert({
        pi_date: piDate, from_entity_id: fromE.id, to_entity_id: toE.id,
        is_interstate: interstate, valid_upto: validUpto,
        notes: meta.notes || null, status: 'draft', pi_no: piNo, ...totals,
      }).select().single()

      if (piErr) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: ${piErr.message}`); continue }

      const { error: lErr } = await supabase.from('proforma_invoice_lines')
        .insert(piLines.map(l => ({ ...l, pi_id: pi.id })))
      if (lErr) errors.push(`Lines for PI ${pi.id}: ${lErr.message}`)
      else created++
    }

    setCsvSaving(false)
    setCsvResult({ created, errors })
    load()
  }

  function toggleSelect(id) {
    setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleSelectAll() {
    setSelected(s => s.size === filtered.length ? new Set() : new Set(filtered.map(p => p.id)))
  }
  async function handleBulkDelete() {
    setBulkDeleting(true)
    const { error } = await supabase.from('proforma_invoices').update({ is_deleted: true }).in('id', [...selected])
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${selected.size} PI(s) deleted`, type: 'success' })
    setSelected(new Set())
    load()
  }

  const columns = [
    ...(canDelete ? [{
      label: <input type='checkbox' checked={filtered.length > 0 && selected.size === filtered.length}
        onChange={toggleSelectAll} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
      render: p => <input type='checkbox' checked={selected.has(p.id)}
        onChange={() => toggleSelect(p.id)} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
    }] : []),
    { label: 'S.No.', render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    { label: 'PI No', render: p => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{p.pi_no || '—'}</span> },
    { label: 'From → To', render: p => <span style={{ fontSize: '12px' }}>{p.from_entity?.short_name || p.from_entity?.name} → {p.to_entity?.short_name || p.to_entity?.name}</span> },
    { label: 'Date',   render: p => <span style={{ fontSize: '12px' }}>{fmtDate(p.pi_date)}</span> },
    { label: 'Order',  render: p => <span style={{ fontSize: '12px', color: C.textSoft }}>{p.orders?.name || '—'}</span> },
    { label: 'Tax',    render: p => <Badge status={p.is_interstate ? 'export' : 'domestic'} label={p.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /> },
    { label: 'Amount', right: true, render: p => <span style={{ fontWeight: 600 }}>{formatINR(p.total_amount)}</span> },
    { label: 'Status', render: p => <Badge status={p.status} /> },
  ]


  function handleExportCSV() {
    downloadCSV(`pi_export_${today()}.csv`,
      ['pi_no','pi_date','from_entity','to_entity','tax_type','status','taxable_amount','total_amount','order'],
      filtered.map(p=>({pi_no:p.pi_no||'',pi_date:p.pi_date,from_entity:p.from_entity?.name||'',to_entity:p.to_entity?.name||'',tax_type:p.is_interstate?'Interstate':'Local',status:p.status,taxable_amount:p.taxable_amount||0,total_amount:p.total_amount||0,order:p.orders?.name||''}))
    )
  }

  return (
    <div>
      <PageHeader
        title='Proforma Invoices'
        subtitle='Draft invoices raised before goods move'
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
            <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
            <Btn onClick={() => { setForm({ ...EMPTY_FORM, from_entity_id: defaultEntityId }); setPILines([]); setModalOpen(true) }}>+ New PI</Btn>
          </div>
        }
      />

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search PI no, entity…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit' }} />
        <select value={statusFilter} onChange={e => setStatus(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {PI_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
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
          <span style={{ fontSize: '13px', color: '#8a2f2f' }}>{selected.size} PI{selected.size > 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn size='sm' variant='ghost' onClick={() => setSelected(new Set())}>Clear</Btn>
            <Btn size='sm' variant='danger' onClick={() => setConfirmBulkDelete(true)} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : 'Delete Selected'}</Btn>
          </div>
        </div>
      )}

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={p => navigate(`/pi/${p.id}`)}
              emptyState={<EmptyState icon='📄' title='No PIs yet' action={<Btn onClick={() => setModalOpen(true)}>+ New PI</Btn>} />} />
        }
      </Card>

      <ConfirmModal open={confirmBulkDelete} onClose={() => setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Proforma Invoices' message={`Delete ${selected.size} selected PI(s)? This cannot be undone.`} danger />

      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Proforma Invoices' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('pi')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>pi_date,from_entity,to_entity,is_interstate,product,description,hsn_code,qty,unit,rate,gst_rate,valid_upto,notes,pi_no</code><br /><br />
            Multiple rows with the same <strong>pi_date + from_entity + to_entity</strong> are grouped into one PI automatically. <code>pi_no</code> is optional — leave it blank to auto-generate, or supply your own (checked against existing PIs and other rows in this file to avoid duplicates). <strong>product</strong> is required — match an existing product name exactly, or a new product is auto-created from this row's hsn_code/gst_rate/rate/unit. Lines without a resolvable product are rejected (stock tracking depends on this link).
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
          </FormRow>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.created} PIs created.</strong>
              {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>


      {/* Copy from previous leg PI */}
      <Modal open={copyModal} onClose={()=>setCopyModal(false)} title='Copy Lines from Previous Leg PI' width={640}>
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{background:'#fffbf0',border:`1px solid #e6c040`,borderRadius:'6px',padding:'10px 14px',fontSize:'12px',color:C.textMid}}>
            Lines are copied with the margin you specify. HSN rates are re-evaluated from the current master.
          </div>
          <FormRow label='Source PI'>
            <Select value={copyPiId} onChange={e=>setCopyPiId(e.target.value)}>
              <option value=''>Select a PI to copy from</option>
              {prevPIs.map(p=><option key={p.id} value={p.id}>{p.pi_no||p.id.slice(0,8)} — {p.from_entity?.short_name||p.from_entity?.name} → {p.to_entity?.short_name||p.to_entity?.name} · {fmtDate(p.pi_date)} · {formatINR(p.total_amount)}</option>)}
            </Select>
          </FormRow>
          <FormRow label='Margin %' hint='Positive or negative. Use 0 to copy at same rate.'>
            <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
              <Input type='text' inputMode='decimal' value={copyMarginPct} onChange={e=>setCopyMarginPct(e.target.value)} style={{width:'100px'}}/>
              <span style={{fontSize:'13px',color:C.textSoft}}>%</span>
            </div>
          </FormRow>
          <div style={{display:'flex',justifyContent:'flex-end',gap:'10px',paddingTop:'8px',borderTop:`1px solid ${C.border}`}}>
            <Btn variant='ghost' onClick={()=>setCopyModal(false)}>Cancel</Btn>
            <Btn onClick={handleCopyLines} disabled={!copyPiId}>Copy & Apply Margin</Btn>
          </div>
        </div>
      </Modal>

      {/* New PI Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Proforma Invoice' width={900}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SectionDivider label='Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
            <FormRow label='PI Date' required>
              <Input type='date' value={form.pi_date} onChange={e => setF('pi_date', e.target.value)} />
            </FormRow>
            <FormRow label='PI Number' hint='Leave blank to auto-generate'>
              <Input value={form.pi_no} onChange={e => setF('pi_no', e.target.value)} placeholder='Auto-generated if blank' />
            </FormRow>
            <FormRow label='Valid Upto'>
              <Input type='date' value={form.valid_upto} onChange={e => setF('valid_upto', e.target.value)} />
            </FormRow>
            <FormRow label='Status'>
              <Select value={form.status} onChange={e => setF('status', e.target.value)}>
                {PI_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </FormRow>
            <FormRow label='From Entity' required hint={fromEntityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.from_entity_id} onChange={e => setF('from_entity_id', e.target.value)} disabled={fromEntityFrozen}>
                <option value=''>Select entity</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='To Entity' required>
              <Select value={form.to_entity_id} onChange={e => setF('to_entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Tax Type' hint='Auto-detected from entity state codes'>
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
              <Select value={form.order_leg_id} onChange={e => setF('order_leg_id', e.target.value)} disabled={!form.order_id || !legs.length}>
                <option value=''>Select leg</option>
                {legs.map(l => <option key={l.id} value={l.id}>Leg {l.leg_no}: {l.from_entity?.short_name || l.from_entity?.name} → {l.to_entity?.short_name || l.to_entity?.name}</option>)}
              </Select>
            </FormRow>
          </div>

          <SectionDivider label='Line Items' />
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:'-4px'}}>
            <Btn size='sm' variant='ghost' onClick={openCopyModal}>📋 Copy from previous leg PI…</Btn>
          </div>
          <LineItemsEditor lines={piLines} setLines={setPILines} interstate={form.is_interstate} hsnMap={hsnMap} showMargin={true} stockMap={stockMap} products={products}/>

          <SectionDivider label='Billing & Shipping (optional)' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Bill From' hint='Billing address of sender (if different from entity address)'>
              <Input value={form.bill_from} onChange={e => setF('bill_from', e.target.value)} placeholder='e.g. VVGTL, Panvel' />
            </FormRow>
            <FormRow label='Bill To' hint='Billing address of receiver'>
              <Input value={form.bill_to} onChange={e => setF('bill_to', e.target.value)} placeholder='e.g. Transworld Commercial Enterprises' />
            </FormRow>
            <FormRow label='Ship From'>
              <Input value={form.ship_from} onChange={e => setF('ship_from', e.target.value)} placeholder='Dispatch location' />
            </FormRow>
            <FormRow label='Ship To'>
              <Input value={form.ship_to} onChange={e => setF('ship_to', e.target.value)} placeholder='e.g. DHL Panvel (C/o Transworld)' />
            </FormRow>
          </div>
          <FormRow label='Notes'>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={() => handleSave(false)} disabled={saving}>{saving ? 'Saving…' : 'Create PI'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!stockWarning} onClose={() => setStockWarning(null)}
        onConfirm={() => { setStockWarning(null); handleSave(true) }}
        title='Planned Quantity Exceeds Stock' message={stockWarning || ''} danger />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── PI Detail ────────────────────────────────────────────────────────────────
function PIDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const canDelete = profile?.role === 'master'
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pi, setPI]         = useState(null)
  const [lines, setLines]   = useState([])
  const [editLines, setEditLines] = useState([])
  const [editing, setEditing]     = useState(false)
  const [editForm, setEditForm]   = useState({})
  const [hsnMap, setHsnMap]       = useState(new Map())
  const [orders, setOrders]       = useState([])
  const [legs, setLegs]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: ls }, { data: hsnRows }, { data: os }] = await Promise.all([
      supabase.from('proforma_invoices').select('*, from_entity:from_entity_id(name,short_name,gstin,state_code,address,city), to_entity:to_entity_id(name,short_name,gstin,state_code,address,city), orders(name), order_legs(leg_no)').eq('id',id).single(),
      supabase.from('proforma_invoice_lines').select('*').eq('pi_id',id).order('line_no'),
      supabase.from('hsn_master').select('*').eq('is_active',true),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
    ])
    setPI(p); setLines(ls||[]); setHsnMap(buildHSNMap(hsnRows||[])); setOrders(os||[]); setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function loadLegs(orderId) {
    if (!orderId) { setLegs([]); return }
    const { data } = await supabase.from('order_legs')
      .select('id, leg_no, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name)')
      .eq('order_id', orderId).order('leg_no')
    setLegs(data || [])
  }

  // CHANGED: a past bug (failed line-delete not checked before re-insert on
  // save — see handleSaveEdit below) let a handful of old PIs accumulate
  // thousands of duplicate line rows, and editing one froze the tab by
  // mounting every line's inputs at once. LineItemsEditor now virtualizes
  // rows above its own threshold, so large *legitimate* PIs (a full-catalog
  // transfer can genuinely have 1000+ distinct products) no longer need to
  // be blocked. This ceiling is now just a last-resort circuit breaker for
  // truly pathological counts a virtualized grid still shouldn't be asked
  // to hold in memory/state at once.
  const MAX_EDITABLE_LINES = 5000
  function startEdit() {
    if (lines.length > MAX_EDITABLE_LINES) {
      return setToast({message:`This PI has ${lines.length} line items, above the ${MAX_EDITABLE_LINES} safety limit. If this isn't expected, it's likely duplicated by a past bug — run supabase/maintenance/dedupe_line_items.sql to clean it up.`,type:'error'})
    }
    setEditForm({pi_no:pi.pi_no||'',pi_date:pi.pi_date||'',valid_upto:pi.valid_upto||'',status:pi.status||'draft',notes:pi.notes||'',is_interstate:pi.is_interstate,bill_from:pi.bill_from||'',bill_to:pi.bill_to||'',ship_from:pi.ship_from||'',ship_to:pi.ship_to||'',order_id:pi.order_id||'',order_leg_id:pi.order_leg_id||''})
    setEditLines(lines.map(l=>({...l,_id:l.id,_hsn_resolved_rate:null,_hsn_override:false,_hsn_manually_set:false,_cost_rate:null,_margin_pct:''})))
    if (pi.order_id) loadLegs(pi.order_id)
    setEditing(true)
  }

  async function handleSaveEdit() {
    // CHANGED: PI number is now editable — required, and checked for
    // duplicates against every other PI (excluding this one) before saving.
    const piNo = (editForm.pi_no || '').trim()
    if (!piNo) return setToast({message:'PI number cannot be blank',type:'error'})
    // CHANGED: block edits that leave a line without a product_id — same
    // rule as PI creation, since these lines feed the same stock calc.
    const missing = findLinesMissingProductId(editLines)
    if (missing.length > 0) return setToast({message:`Line ${missing.map(l=>l._lineNo).join(', ')}: select a product before saving — stock tracking needs it.`,type:'error'})
    setSaving(true)
    if (piNo.toLowerCase() !== (pi.pi_no||'').toLowerCase()) {
      const { data: dup } = await supabase.from('proforma_invoices').select('id').ilike('pi_no', piNo).neq('id', id).limit(1)
      if (dup?.length) { setSaving(false); return setToast({message:`PI number "${piNo}" is already in use`,type:'error'}) }
    }
    const computedLines = editLines.map(l => computeLine(l, editForm.is_interstate))
    const totals = computeTotals(computedLines)
    // order_id/order_leg_id are uuid columns — an empty string (cleared in the
    // dropdown) must be sent as null, not '', or the update fails.
    const { error: piErr } = await supabase.from('proforma_invoices').update({...editForm,pi_no:piNo,order_id:editForm.order_id||null,order_leg_id:editForm.order_leg_id||null,...totals,updated_at:new Date()}).eq('id',id)
    if (piErr) { setSaving(false); return setToast({message:piErr.message,type:'error'}) }
    // CHANGED: this delete's result was never checked. If it silently failed
    // (RLS/timeout) while the insert below still ran, every re-save stacked
    // another full copy of the lines on top of the old ones — that's how one
    // PI ended up with 1000+ duplicate line rows. Abort on a failed delete so
    // we never insert on top of lines that weren't actually cleared.
    const { error: delErr } = await supabase.from('proforma_invoice_lines').delete().eq('pi_id',id)
    if (delErr) { setSaving(false); return setToast({message:`Could not clear old line items: ${delErr.message}. PI header was updated but lines were left unchanged to avoid duplicates.`,type:'error'}) }
    const linesPayload = computedLines.map((l,i)=>toPILinePayload(l,id,i+1))
    if (linesPayload.length) {
      const { error: lErr } = await supabase.from('proforma_invoice_lines').insert(linesPayload)
      if (lErr) { setSaving(false); return setToast({message:lErr.message,type:'error'}) }
    }
    setSaving(false); setEditing(false)
    setToast({message:'PI updated',type:'success'}); load()
  }

  function handleExportLines() {
    if (!pi||!lines.length) return
    downloadCSV(`${pi.pi_no||'pi'}_lines_${today()}.csv`,['line_no','description','hsn_code','qty','unit','rate','gst_rate','taxable_amount','cgst_amount','sgst_amount','igst_amount','total_amount'],lines)
  }

  async function updateStatus(status) {
    await supabase.from('proforma_invoices').update({status,updated_at:new Date()}).eq('id',id)
    setToast({message:`PI marked as ${status}`,type:'success'}); load()
  }

  async function handleDelete() {
    setDeleting(true)
    const { error } = await supabase.from('proforma_invoices').update({ is_deleted: true }).eq('id', id)
    setDeleting(false); setConfirmDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    navigate('/pi')
  }

  if (loading) return <div style={{padding:'48px',textAlign:'center',color:C.textMuted}}>Loading…</div>
  if (!pi)     return <div style={{padding:'48px',textAlign:'center',color:C.danger}}>PI not found.</div>

  const canConvert = ['accepted','sent','draft'].includes(pi.status) && !editing
  const isLocked   = ['converted','cancelled'].includes(pi.status)

  return (
    <div>
      <button onClick={()=>navigate('/pi')} style={{background:'none',border:'none',color:C.textMuted,fontSize:'13px',cursor:'pointer',padding:0,fontFamily:'inherit',marginBottom:'4px'}}>← Proforma Invoices</button>

      <PageHeader
        title={pi.pi_no||`PI — ${fmtDate(pi.pi_date)}`}
        subtitle={`${pi.from_entity?.name} → ${pi.to_entity?.name} · ${fmtDate(pi.pi_date)}`}
        action={
          <div style={{display:'flex',gap:'8px',flexWrap:'wrap',alignItems:'center'}}>
            <Btn size='sm' variant='ghost' onClick={handleExportLines}>↓ CSV</Btn>
            {!editing&&!isLocked&&<Btn size='sm' variant='ghost' onClick={startEdit}>✏ Edit</Btn>}
            {editing&&<Btn size='sm' variant='ghost' onClick={()=>setEditing(false)}>Discard</Btn>}
            {editing&&<Btn size='sm' onClick={handleSaveEdit} disabled={saving}>{saving?'Saving…':'Save Changes'}</Btn>}
            {!editing&&pi.status==='draft'&&<Btn size='sm' variant='ghost' onClick={()=>updateStatus('sent')}>Mark Sent</Btn>}
            {!editing&&pi.status==='sent'&&<Btn size='sm' variant='ghost' onClick={()=>updateStatus('accepted')}>Mark Accepted</Btn>}
            {canConvert&&<Btn size='sm' onClick={()=>navigate(`/invoices/new?from_pi=${id}`)}>Convert to Invoice</Btn>}
            {!editing&&!isLocked&&<Btn size='sm' variant='ghost' onClick={()=>setConfirmCancel(true)} style={{color:C.danger}}>Cancel PI</Btn>}
            {!editing&&canDelete&&<Btn size='sm' variant='danger' onClick={()=>setConfirmDelete(true)} disabled={deleting}>{deleting?'Deleting…':'Delete'}</Btn>}
            <Badge status={pi.status}/>
          </div>
        }
      />
      {editing&&<div style={{background:'#fffbf0',border:`1px solid #e6c040`,borderRadius:'6px',padding:'8px 14px',fontSize:'12px',color:'#7a5000',marginBottom:'16px'}}>✏ Editing mode — click "Save Changes" to confirm</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>From</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{pi.from_entity?.name}</div>
          {pi.from_entity?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '2px' }}>GSTIN: {pi.from_entity.gstin}</div>}
          {pi.from_entity?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{pi.from_entity.city}</div>}
        </Card>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>To</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{pi.to_entity?.name}</div>
          {pi.to_entity?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace', marginTop: '2px' }}>GSTIN: {pi.to_entity.gstin}</div>}
          {pi.to_entity?.city  && <div style={{ fontSize: '12px', color: C.textSoft }}>{pi.to_entity.city}</div>}
        </Card>
      </div>

      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap', fontSize: '13px' }}>
        <div><span style={{ color: C.textMuted }}>Date:</span> <strong>{fmtDate(pi.pi_date)}</strong></div>
        {pi.valid_upto && <div><span style={{ color: C.textMuted }}>Valid until:</span> <strong>{fmtDate(pi.valid_upto)}</strong></div>}
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={pi.is_interstate ? 'export' : 'domestic'} label={pi.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /></div>
        {pi.orders?.name && <div><span style={{ color: C.textMuted }}>Order:</span> <strong>{pi.orders.name}{pi.order_legs?.leg_no ? ` — Leg ${pi.order_legs.leg_no}` : ''}</strong></div>}
      </div>

      {editing&&(
        <Card style={{marginBottom:'16px',padding:'16px'}}>
          <SectionDivider label='Edit Details'/>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'12px',marginTop:'12px'}}>
            <FormRow label='PI Date' required><Input type='date' value={editForm.pi_date} onChange={e=>setEditForm(f=>({...f,pi_date:e.target.value}))}/></FormRow>
            <FormRow label='PI Number' required><Input value={editForm.pi_no} onChange={e=>setEditForm(f=>({...f,pi_no:e.target.value}))}/></FormRow>
            <FormRow label='Valid Upto'><Input type='date' value={editForm.valid_upto} onChange={e=>setEditForm(f=>({...f,valid_upto:e.target.value}))}/></FormRow>
            <FormRow label='Status'><Select value={editForm.status} onChange={e=>setEditForm(f=>({...f,status:e.target.value}))}>{PI_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}</Select></FormRow>
            <FormRow label='Tax Type'><Select value={editForm.is_interstate?'1':'0'} onChange={e=>setEditForm(f=>({...f,is_interstate:e.target.value==='1'}))}><option value='0'>Local — CGST+SGST</option><option value='1'>Interstate — IGST</option></Select></FormRow>
            <FormRow label='Order'>
              <Select value={editForm.order_id} onChange={e=>{setEditForm(f=>({...f,order_id:e.target.value,order_leg_id:''}));loadLegs(e.target.value)}}>
                <option value=''>No order</option>
                {orders.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Order Leg'>
              <Select value={editForm.order_leg_id} onChange={e=>setEditForm(f=>({...f,order_leg_id:e.target.value}))} disabled={!editForm.order_id||!legs.length}>
                <option value=''>Select leg</option>
                {legs.map(l=><option key={l.id} value={l.id}>Leg {l.leg_no}: {l.from_entity?.short_name||l.from_entity?.name} → {l.to_entity?.short_name||l.to_entity?.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Bill From'><Input value={editForm.bill_from} onChange={e=>setEditForm(f=>({...f,bill_from:e.target.value}))}/></FormRow>
            <FormRow label='Bill To'><Input value={editForm.bill_to} onChange={e=>setEditForm(f=>({...f,bill_to:e.target.value}))}/></FormRow>
          </div>
          <div style={{marginTop:'8px'}}><FormRow label='Notes'><Textarea value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))} rows={2}/></FormRow></div>
        </Card>
      )}
      <Card style={{marginBottom:'16px'}}>
        <LineItemsEditor
          lines={editing?editLines:lines.map(l=>({...l,_id:l.id}))}
          setLines={editing?setEditLines:()=>{}}
          interstate={editing?editForm.is_interstate:pi.is_interstate}
          hsnMap={hsnMap}
          readOnly={!editing}
          showMargin={true}
        />
      </Card>

      {pi.notes && (
        <div style={{ fontSize: '13px', color: C.textSoft, marginTop: '8px' }}>
          <strong>Notes:</strong> {pi.notes}
        </div>
      )}

      <div style={{ marginTop: '20px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments
          sourceType='proforma_invoices'
          sourceId={pi.id}
          entityId={pi.from_entity_id} // CHANGED: required for documents.entity_id NOT NULL
          entityName={pi.from_entity?.name || 'General'}
        />
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel PI' message='Cancel this proforma invoice? This action cannot be undone.' danger />
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={handleDelete}
        title='Delete PI' message={`Delete ${pi.pi_no || 'this PI'}? This cannot be undone.`} danger />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function PI() {
  return (
    <Routes>
      <Route index       element={<PIList />} />
      <Route path=':id'  element={<PIDetail />} />
    </Routes>
  )
}
