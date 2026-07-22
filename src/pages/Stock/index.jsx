import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, StatCard, CsvFileDrop,
} from '../../components/UI/index'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { downloadTemplate, downloadCSV, detectDelimiter, parseCSVLine } from '../../utils/csvTemplate'
// CHANGED: reuse the existing, tested actual-stock logic (already powers
// LineItemsEditor's stockMap) instead of duplicating it here.
import { fetchActualStockPosition, fetchEntityAvailableStock } from '../../utils/stock'
import { ProductPicker } from '../../components/LineItemsEditor'
import { cleanProductName, productMatchKey, findNearMatchProduct, findMergeSuggestionGroups } from '../../utils/products'
// CHANGED: needed to know the current user's role/id for entity-access scoping
import { useAuth } from '../../hooks/useAuth'
import { fetchAllPages } from '../../utils/query'
import { hasFullAccess } from '../../utils/roles'

const UNITS = ['Nos', 'Kg', 'Pcs', 'Box', 'Mtr', 'Ltr', 'Set']
const TABS  = ['Opening Stock', 'Stock Position', 'Adjustments', 'Products']
const ADJUSTMENT_REASONS = [
  { value: 'shortfall', label: 'Shortfall (found less than expected)' },
  { value: 'damage',    label: 'Damage / write-off' },
  { value: 'found',     label: 'Found stock (found more than expected)' },
  { value: 'recount',   label: 'Physical recount correction' },
  // CHANGED: distinct from the correction reasons above — this tool tracks
  // transactions, not a full ERP's physical inventory lifecycle. Once a
  // batch of stock is done being tracked here (sold outside the tool,
  // disposed of, given away), this reason removes it from Actual Stock
  // without mislabeling it as a miscount. Always a decrease — enforced by a
  // DB check constraint too (033_stock_offload_reason.sql). Doesn't touch
  // P&L: Reports' P&L/Profitability tabs are computed purely from
  // invoice/expense data and never read stock_adjustments at all.
  { value: 'offloaded', label: 'Offloaded (moved out of system, not sold via this tool)' },
  { value: 'other',     label: 'Other' },
]
// CHANGED: parseCSVLine moved to utils/csvTemplate.js so PI/PO/Invoices CSV
// upload can reuse the same quote-aware parsing — it was previously private
// to this file only.

// ─── helpers ──────────────────────────────────────────────────────────────────
function shortfallBadge(planned) {
  if (planned < 0) return <span style={{ fontSize: '11px', fontWeight: 700, background: '#f0e8e8', color: '#8a2020', padding: '2px 8px', borderRadius: '4px' }}>⚠ Shortfall</span>
  if (planned === 0) return <span style={{ fontSize: '11px', fontWeight: 700, background: '#fff3cc', color: '#7a5000', padding: '2px 8px', borderRadius: '4px' }}>Zero</span>
  return <span style={{ fontSize: '11px', fontWeight: 700, background: '#e8f3ec', color: '#1a5c30', padding: '2px 8px', borderRadius: '4px' }}>OK</span>
}

// CHANGED: separate indicator from the Planned/PI shortfall badge above —
// this one fires when actual (invoice-based) stock has gone negative, i.e.
// an entity has billed out more than it actually had on hand.
function billedBeyondStockBadge() {
  return <span style={{ fontSize: '11px', fontWeight: 700, background: '#fbe4e4', color: '#a31414', padding: '2px 8px', borderRadius: '4px' }}>🔴 Billed beyond stock</span>
}

// ─── Opening Stock Tab ────────────────────────────────────────────────────────
const EMPTY_OPENING = {
  entity_id: '', product_id: '', financial_year_id: '',
  qty: '', unit: '', rate: '', hsn_code: '', gst_rate: '',
  as_of_date: today(), notes: '',
}

function OpeningStock() {
  const [rows, setRows]         = useState([])
  const [entities, setEntities] = useState([])
  const [products, setProducts] = useState([])
  const [fys, setFys]           = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_OPENING)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [entityFilter, setEntityFilter]   = useState('')
  const [toast, setToast]       = useState(null)
  // CSV
  const [csvModal, setCsvModal] = useState(false)
  const [csvText, setCsvText]   = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [csvProgress, setCsvProgress] = useState('')

  // CHANGED: stock_opening_balance and products can both exceed PostgREST's
  // default 1000-row response cap now that the catalog has grown past that —
  // a plain .select() silently truncates instead of erroring, which is what
  // made the Stock page's totals undercount actual value/qty. Page through
  // with fetchAllPages so every row is loaded regardless of table size.
  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: rs }, { data: es }, { data: ps }, { data: fyData }] = await Promise.all([
      fetchAllPages(() => supabase.from('stock_opening_balance')
        .select('*, entity:entity_id(name,short_name), product:product_id(name,hsn_code,unit), fy:financial_year_id(name)')
        .order('created_at', { ascending: false })),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate').eq('is_active', true).order('name')),
      supabase.from('financial_years').select('*').order('start_date', { ascending: false }),
    ])
    setRows(rs || [])
    setEntities(es || [])
    setProducts(ps || [])
    setFys(fyData || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'product_id' && v) {
        const p = products.find(p => p.id === v)
        if (p) { u.hsn_code = p.hsn_code || ''; u.gst_rate = p.gst_rate != null ? String(p.gst_rate) : ''; u.rate = p.default_rate != null ? String(p.default_rate) : ''; u.unit = p.unit || '' }
      }
      return u
    })
  }

  function openNew()   { setEditing(null); setForm(EMPTY_OPENING); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({ entity_id: r.entity_id||'', product_id: r.product_id||'', financial_year_id: r.financial_year_id||'', qty: r.qty!=null?String(r.qty):'', unit: r.unit||r.product?.unit||'', rate: r.rate!=null?String(r.rate):'', hsn_code: r.hsn_code||'', gst_rate: r.gst_rate!=null?String(r.gst_rate):'', as_of_date: r.as_of_date||today(), notes: r.notes||'' })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.entity_id || !form.product_id || !form.financial_year_id)
      return setToast({ message: 'Entity, Product and FY are required', type: 'error' })
    setSaving(true)
    const payload = { entity_id: form.entity_id, product_id: form.product_id, financial_year_id: form.financial_year_id, qty: toNum(form.qty), unit: form.unit||null, rate: toNum(form.rate), hsn_code: form.hsn_code||null, gst_rate: toNum(form.gst_rate)||null, as_of_date: form.as_of_date, notes: form.notes||null }
    let error
    if (editing) {
      const res = await supabase.from('stock_opening_balance').update(payload).eq('id', editing.id)
      error = res.error
    } else {
      const res = await supabase.from('stock_opening_balance').insert(payload)
      error = res.error
    }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'Updated' : 'Added', type: 'success' })
    setModalOpen(false); load()
  }

  async function handleDelete() {
    await supabase.from('stock_opening_balance').delete().eq('id', confirmDelete.id)
    setConfirmDelete(null); load()
  }

  // CSV: entity,product,fy,qty,unit,rate,hsn_code,gst_rate,as_of_date,category
  // CHANGED: category is optional — only used when auto-creating a new product;
  // it does not update the category of a product that already exists.
  // Products not found by exact name are auto-created from the row's hsn_code/gst_rate/unit/rate.
  // CHANGED: rows are now UPSERTED on (entity_id, product_id, financial_year_id) —
  // re-uploading updates the qty/rate/etc. of an existing opening-stock row
  // instead of failing with a duplicate-key error. (The old code tried to skip
  // existing rows by comparing against the currently-loaded list, but that list
  // is capped at Supabase's default 1000 rows, so anything past 1000 slipped
  // through and hit the DB unique constraint.) This makes "re-upload to fix the
  // numbers" work reliably. Duplicate keys WITHIN one file are combined too
  // (quantities summed), since a single upsert can't touch the same key twice
  // and source files legitimately list the same product's stock across
  // multiple lots/batches on separate rows.
  // Runs in batches (not one row at a time) so large files (1000+ rows) don't take minutes,
  // and every row is accounted for in the result.
  async function handleCSV() {
    setCsvSaving(true)
    setCsvProgress('Parsing file…')
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); setCsvProgress(''); return setToast({ message: 'CSV needs header + data rows', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    const header = parseCSVLine(lines[0], delim).map(h => h.toLowerCase())
    const norm = s => (s || '').trim().replace(/\s+/g, ' ')
    const totalDataRows = lines.length - 1

    // Phase 1 — parse + validate every row against entities/fys (no DB calls yet)
    const parsed = []
    const errors = []
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i], delim)
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const rowNum = i + 1
      const entity = entities.find(e => e.short_name?.toLowerCase() === row.entity?.toLowerCase() || e.name?.toLowerCase() === row.entity?.toLowerCase())
      const productName = norm(row.product)
      const fy = fys.find(f => f.name?.toLowerCase() === row.fy?.toLowerCase())
      if (!entity)      { errors.push(`Row ${rowNum}: entity "${row.entity}" not found`); continue }
      if (!productName) { errors.push(`Row ${rowNum}: product name is required`); continue }
      if (!fy)          { errors.push(`Row ${rowNum}: FY "${row.fy}" not found — fill in the fy column`); continue }
      parsed.push({ rowNum, row, entity, productName, fy })
    }

    // Phase 2 — bulk-create any missing products in one request
    setCsvProgress('Checking products…')
    // CHANGED: match on name + HSN + rate + GST together, not name alone.
    // A single source file can have several genuinely different products
    // sharing one generic name (e.g. "Embroidered Cotton Cushion Cover" at 7
    // different rates = 7 different designs) — matching by name only would
    // silently merge them and lose real stock quantity. Only collapse to the
    // same product when ALL FOUR fields match (per product-owner decision);
    // the normalized name key alone still catches the trailing-')' junk cases.
    //
    // CHANGED: uses a precomputed Map (key -> product) instead of an
    // array .find() re-run per row. With ~1000 products x ~1100 rows, a
    // linear scan recomputing productMatchKey for every candidate on every
    // row means millions of string/regex operations — slow enough on a large
    // file that the upload looked hung. A Map lookup is O(1) per row.
    const productMap = new Map()
    for (const p of products) {
      productMap.set(productMatchKey({ name: p.name, hsn_code: p.hsn_code, rate: p.default_rate, gst_rate: p.gst_rate }), p)
    }
    const rowMatchKey = row => productMatchKey({ name: row.product, hsn_code: row.hsn_code, rate: row.rate, gst_rate: row.gst_rate })
    const findProduct = row => productMap.get(rowMatchKey(row))
    const missingRowKeys = new Set()
    const missingRows = []
    const nearMatchNotes = []
    for (const p of parsed) {
      const k = rowMatchKey(p.row)
      if (productMap.has(k) || missingRowKeys.has(k)) continue
      // CHANGED: before treating this as a genuinely new product, check for
      // an existing one with the same name+HSN+GST at a near-identical rate
      // (see findNearMatchProduct) — reuse it instead of creating a phantom
      // duplicate that silently starts at zero stock.
      const near = findNearMatchProduct(products, { name: p.productName, hsn_code: p.row.hsn_code, rate: p.row.rate, gst_rate: p.row.gst_rate })
      if (near) {
        productMap.set(k, near)
        nearMatchNotes.push(`${p.productName} @ ₹${p.row.rate} → matched to existing "${near.name}" @ ₹${near.default_rate} (rate close enough, not creating a duplicate)`)
        continue
      }
      missingRowKeys.add(k)
      missingRows.push(p)
    }
    let productsCreated = 0
    const createdProductNames = []
    if (missingRows.length > 0) {
      const payloads = missingRows.map(p => ({ name: cleanProductName(p.productName), hsn_code: p.row.hsn_code || null, gst_rate: toNum(p.row.gst_rate) || 18, unit: p.row.unit || 'Nos', default_rate: toNum(p.row.rate) || null, category: p.row.category || null, is_active: true }))
      const { data: newProducts, error: pErr } = await supabase.from('products').insert(payloads).select()
      if (pErr) {
        errors.push(`Could not auto-create ${missingRows.length} new product(s) — ${pErr.message}`)
      } else {
        for (const p of (newProducts || [])) {
          productMap.set(productMatchKey({ name: p.name, hsn_code: p.hsn_code, rate: p.default_rate, gst_rate: p.gst_rate }), p)
        }
        productsCreated = (newProducts || []).length
        createdProductNames.push(...(newProducts || []).map(p => p.name))
      }
    }

    // Phase 3 — resolve each row's product; SUM quantities for duplicate
    // entity+product+fy keys within the file since one upsert can't touch the
    // same key twice. Source files legitimately list the same product more
    // than once (separate stock lots/batches received at the same rate) and
    // those quantities are meant to add up, not overwrite one another — a
    // product's rate/HSN/GST are already part of what makes it "the same
    // product" (see productMatchKey), so colliding rows always share those
    // values and only qty needs combining.
    // Note: two rows with the same product NAME but different HSN/rate/GST
    // resolve to different products here, so they land in different
    // entity+product+fy keys and do NOT collapse into each other.
    setCsvProgress('Preparing rows…')
    const byKey = new Map()
    const skippedItems = []
    for (const p of parsed) {
      const product = findProduct(p.row)
      if (!product) { errors.push(`Row ${p.rowNum}: product "${p.productName}" could not be created`); continue }
      const label = `${p.row.entity} — ${p.productName} — ${p.row.fy}`
      const key = `${p.entity.id}__${product.id}__${p.fy.id}`
      const qty = toNum(p.row.qty)
      if (byKey.has(key)) {
        byKey.get(key).qty += qty
        skippedItems.push(`${label} — listed more than once in this file; quantities combined`)
      } else {
        byKey.set(key, {
          entity_id: p.entity.id, product_id: product.id, financial_year_id: p.fy.id,
          qty, unit: p.row.unit || product.unit || null, rate: toNum(p.row.rate),
          hsn_code: p.row.hsn_code || product.hsn_code || null,
          gst_rate: p.row.gst_rate ? toNum(p.row.gst_rate) : (product.gst_rate != null ? product.gst_rate : null),
          as_of_date: p.row.as_of_date || today(),
          _label: label,
        })
      }
    }
    const toUpsert = [...byKey.values()]

    // Phase 4 — UPSERT in batches on the (entity, product, fy) unique key so an
    // existing row is updated rather than throwing a duplicate-key error. If a
    // batch fails, retry row-by-row to attribute the error to the specific row.
    let added = 0
    const addedItems = []
    const CONFLICT = 'entity_id,product_id,financial_year_id'
    const CHUNK = 200
    for (let c = 0; c < toUpsert.length; c += CHUNK) {
      const chunk = toUpsert.slice(c, c + CHUNK)
      setCsvProgress(`Uploading rows ${c + 1}–${Math.min(c + CHUNK, toUpsert.length)} of ${toUpsert.length}…`)
      const payload = chunk.map(({ _label, ...rest }) => rest)
      const { error } = await supabase.from('stock_opening_balance').upsert(payload, { onConflict: CONFLICT })
      if (!error) {
        added += chunk.length
        addedItems.push(...chunk.map(r => r._label))
      } else {
        for (const r of chunk) {
          const { _label, ...rest } = r
          const { error: rowErr } = await supabase.from('stock_opening_balance').upsert(rest, { onConflict: CONFLICT })
          if (rowErr) errors.push(`${_label}: ${rowErr.message}`)
          else { added++; addedItems.push(_label) }
        }
      }
    }

    setCsvResult({ totalDataRows, added, skipped: skippedItems.length, productsCreated, errors, addedItems, skippedItems, createdProductNames, nearMatchNotes })
    setCsvProgress('')
    await load()
    setCsvSaving(false)
  }

  const filtered = rows.filter(r => !entityFilter || r.entity_id === entityFilter)

  // CHANGED: download of the (filtered) opening-stock rows. Columns lead with
  // the exact upload format (entity,product,fy,qty,unit,rate,hsn_code,
  // gst_rate,as_of_date,category) so an export can be corrected in Excel and
  // re-uploaded as-is; value/notes ride along at the end and are ignored by
  // the uploader.
  function handleExportCSV() {
    downloadCSV(`opening_stock_${today()}.csv`,
      ['entity','product','fy','qty','unit','rate','hsn_code','gst_rate','as_of_date','category','value','notes'],
      filtered.map(r => ({
        entity: r.entity?.short_name || r.entity?.name || '',
        product: r.product?.name || '',
        fy: r.fy?.name || '',
        qty: toNum(r.qty),
        unit: r.unit || r.product?.unit || '',
        rate: toNum(r.rate),
        hsn_code: r.hsn_code || r.product?.hsn_code || '',
        gst_rate: r.gst_rate ?? '',
        as_of_date: r.as_of_date || '',
        category: '',
        value: toNum(r.qty) * toNum(r.rate),
        notes: r.notes || '',
      })))
  }

  const totalValue = filtered.reduce((s, r) => s + toNum(r.qty) * toNum(r.rate), 0)
  const qtyByUnit = filtered.reduce((m, r) => {
    const u = r.unit || r.product?.unit || 'Nos'
    m[u] = (m[u] || 0) + toNum(r.qty)
    return m
  }, {})
  const qtySummary = Object.entries(qtyByUnit).map(([u, q]) => `${q.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${u}`).join(' • ') || '0'
  const distinctProducts = new Set(filtered.map(r => r.product_id)).size

  const columns = [
    { label: 'S.No.',    render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Entity',   render: r => <span style={{ fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name}</span> },
    { label: 'Product',  render: r => <div><div style={{ fontWeight: 600 }}>{r.product?.name}</div><div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>{r.hsn_code || r.product?.hsn_code}</div></div> },
    { label: 'FY',       render: r => <span style={{ fontSize: '12px', color: C.textSoft }}>{r.fy?.name}</span> },
    { label: 'Qty',      right: true, render: r => <span style={{ fontWeight: 600 }}>{Number(r.qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })} {r.unit || r.product?.unit}</span> },
    { label: 'Rate',     right: true, render: r => formatINR(r.rate) },
    { label: 'Value',    right: true, render: r => <span style={{ fontWeight: 600 }}>{formatINR(toNum(r.qty) * toNum(r.rate))}</span> },
    { label: 'As of',    render: r => fmtDate(r.as_of_date) },
    { label: 'Actions',  render: r => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Delete</Btn>
      </div>
    )},
  ]

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '16px' }}>
        <StatCard label='Total Value' value={formatINR(totalValue)} color={C.accent} />
        <StatCard label='Total Qty'   value={qtySummary} />
        <StatCard label='Products'    value={distinctProducts} />
        <StatCard label='Rows'        value={filtered.length} />
      </div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value=''>All entities</option>
          {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
        <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
        <Btn onClick={openNew}>+ Add Opening Stock</Btn>
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered}
              emptyState={<EmptyState icon='📦' title='No opening stock' message='Add opening stock for each entity and product.' action={<Btn onClick={openNew}>+ Add Opening Stock</Btn>} />}
            />
        }
      </Card>

      {/* Add/Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Opening Stock' : 'Add Opening Stock'} width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Entity' required>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Financial Year' required>
              <Select value={form.financial_year_id} onChange={e => setF('financial_year_id', e.target.value)}>
                <option value=''>Select FY</option>
                {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Product' required>
              {/* CHANGED: searchable picker — a plain dropdown over thousands of products was unusable */}
              <ProductPicker products={products} value={form.product_id} onSelect={id => setF('product_id', id)} />
            </FormRow>
            <FormRow label='As of Date' required>
              <Input type='date' value={form.as_of_date} onChange={e => setF('as_of_date', e.target.value)} />
            </FormRow>
            <FormRow label='Qty' required>
              <Input type='number' value={form.qty} onChange={e => setF('qty', e.target.value)} placeholder='0.000' />
            </FormRow>
            <FormRow label='Unit'>
              <Select value={form.unit} onChange={e => setF('unit', e.target.value)}>
                <option value=''>Use product default</option>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Rate per Unit (₹)'>
              <Input type='number' value={form.rate} onChange={e => setF('rate', e.target.value)} placeholder='0' />
            </FormRow>
            <FormRow label='HSN Code'>
              <Input value={form.hsn_code} onChange={e => setF('hsn_code', e.target.value)} />
            </FormRow>
            <FormRow label='GST Rate %'>
              <Input type='number' value={form.gst_rate} onChange={e => setF('gst_rate', e.target.value)} />
            </FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          {toNum(form.qty) > 0 && toNum(form.rate) > 0 && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 14px', fontSize: '13px', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: C.textSoft }}>Stock Value</span>
              <strong>{formatINR(toNum(form.qty) * toNum(form.rate))}</strong>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add'}</Btn>
          </div>
        </div>
      </Modal>

      {/* CSV modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Opening Stock' width={580}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('opening_stock')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>entity,product,fy,qty,unit,rate,hsn_code,gst_rate,as_of_date,category</code><br />
            <strong>Example:</strong><br />
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>Siddi,T-Shirt Basic,FY 2025-26,1000,Nos,250,6109,12,2025-04-01</code><br />
            Entity = short name or full name. FY = exact name from Settings (required — no default). If <code>product</code> doesn't match an existing product by exact name, a new product is auto-created using this row's unit / hsn_code / gst_rate / rate. unit / hsn_code / gst_rate are optional for existing products — blank falls back to the product's current defaults. Re-uploading the same file skips rows that already exist (same entity + product + FY) — only new rows are added; to change a value on an existing row, edit it directly in the table. If a product name contains a comma, wrap that field in double quotes, e.g. <code>"Steel Tea, Coffee &amp; Sugar Container Set, 3 Pieces"</code>.
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
          </FormRow>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={8}
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          {csvSaving && csvProgress && (
            <div style={{ fontSize: '12px', color: C.textSoft, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '12px', height: '12px', border: `2px solid ${C.border}`, borderTopColor: C.accent, borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
              {csvProgress}
            </div>
          )}
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>
                {csvResult.totalDataRows} rows in file — {csvResult.added} added/updated,
                {` `}{csvResult.skipped} combined into an earlier row (same product listed twice), {csvResult.errors.length} error{csvResult.errors.length === 1 ? '' : 's'}.
                {csvResult.productsCreated > 0 ? ` ${csvResult.productsCreated} new product${csvResult.productsCreated === 1 ? '' : 's'} auto-created.` : ''}
              </strong>
              {csvResult.added + csvResult.skipped + csvResult.errors.length !== csvResult.totalDataRows && (
                <div style={{ color: C.danger, marginTop: '4px' }}>⚠ {csvResult.totalDataRows - (csvResult.added + csvResult.skipped + csvResult.errors.length)} row(s) unaccounted for — please report this.</div>
              )}
              {csvResult.addedItems?.length > 0 && (
                <details style={{ marginTop: '6px' }}>
                  <summary style={{ cursor: 'pointer', color: C.textSoft }}>Show {csvResult.addedItems.length} added row{csvResult.addedItems.length === 1 ? '' : 's'}</summary>
                  <div style={{ maxHeight: '140px', overflowY: 'auto', marginTop: '4px' }}>
                    {csvResult.addedItems.map((t, i) => <div key={i} style={{ color: C.textMid, fontFamily: 'monospace', fontSize: '11px' }}>{t}</div>)}
                  </div>
                </details>
              )}
              {csvResult.skippedItems?.length > 0 && (
                <details style={{ marginTop: '6px' }}>
                  <summary style={{ cursor: 'pointer', color: C.textSoft }}>Show {csvResult.skippedItems.length} combined row{csvResult.skippedItems.length === 1 ? '' : 's'}</summary>
                  <div style={{ maxHeight: '140px', overflowY: 'auto', marginTop: '4px' }}>
                    {csvResult.skippedItems.map((t, i) => <div key={i} style={{ color: C.textMid, fontFamily: 'monospace', fontSize: '11px' }}>{t}</div>)}
                  </div>
                </details>
              )}
              {csvResult.createdProductNames?.length > 0 && (
                <details style={{ marginTop: '6px' }}>
                  <summary style={{ cursor: 'pointer', color: C.textSoft }}>Show {csvResult.createdProductNames.length} auto-created product{csvResult.createdProductNames.length === 1 ? '' : 's'}</summary>
                  <div style={{ maxHeight: '140px', overflowY: 'auto', marginTop: '4px' }}>
                    {csvResult.createdProductNames.map((t, i) => <div key={i} style={{ color: C.textMid, fontFamily: 'monospace', fontSize: '11px' }}>{t}</div>)}
                  </div>
                </details>
              )}
              {csvResult.nearMatchNotes?.length > 0 && (
                <details style={{ marginTop: '6px' }}>
                  <summary style={{ cursor: 'pointer', color: C.textSoft }}>Show {csvResult.nearMatchNotes.length} row{csvResult.nearMatchNotes.length === 1 ? '' : 's'} matched to an existing product at a near-identical rate (no duplicate created)</summary>
                  <div style={{ maxHeight: '140px', overflowY: 'auto', marginTop: '4px' }}>
                    {csvResult.nearMatchNotes.map((t, i) => <div key={i} style={{ color: C.textMid, fontFamily: 'monospace', fontSize: '11px' }}>{t}</div>)}
                  </div>
                </details>
              )}
              {csvResult.errors.length > 0 && (
                <details style={{ marginTop: '6px' }} open>
                  <summary style={{ cursor: 'pointer', color: '#7a5000' }}>Show {csvResult.errors.length} error{csvResult.errors.length === 1 ? '' : 's'}</summary>
                  <div style={{ maxHeight: '160px', overflowY: 'auto', marginTop: '4px' }}>
                    {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
                  </div>
                </details>
              )}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? (csvProgress || 'Uploading…') : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete' message={`Delete opening stock for ${confirmDelete?.product?.name}?`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Adjustments Tab ────────────────────────────────────────────────────────
// Manual corrections for stock that PI/PO/Invoice flows can't explain —
// shortfalls found on a physical count, damaged goods written off, stock
// found that wasn't on the books, etc. Each row is a signed qty_delta folded
// straight into buildActualStockMap() (see utils/stock.js) alongside opening
// balance and invoice movements — same "record the event, recompute live"
// philosophy the E-way-Bill-driven stock movement already uses, rather than
// maintaining a separately-updated running total that could drift.
const EMPTY_ADJUSTMENT = {
  entity_id: '', product_id: '', direction: 'decrease', qty: '',
  reason: 'shortfall', notes: '', adjustment_date: today(),
}

function StockAdjustments() {
  const { profile } = useAuth()

  // CHANGED: "Merge Duplicates" lives as a sub-view here rather than its own
  // top-level Stock tab — it's a specific kind of stock adjustment (folding
  // one product's stock into another), not a separate module.
  const [subTab, setSubTab] = useState('list') // 'list' | 'merge'

  const [rows, setRows]         = useState([])
  const [entities, setEntities] = useState([])
  const [products, setProducts] = useState([])
  const [entityFilter, setEntityFilter] = useState('')
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_ADJUSTMENT)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]       = useState(null)
  // CHANGED: live "current stock" preview in the modal so whoever is raising
  // the adjustment can see what they're correcting against before saving.
  const [currentStock, setCurrentStock] = useState(null)
  // CSV
  const [csvModal, setCsvModal]   = useState(false)
  const [csvText, setCsvText]     = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: rs }, { data: ps }] = await Promise.all([
      fetchAllPages(() => supabase.from('stock_adjustments')
        .select('*, entity:entity_id(name,short_name), product:product_id(name,hsn_code,unit), creator:created_by(full_name)')
        .order('adjustment_date', { ascending: false })
        .order('created_at', { ascending: false })),
      fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,unit').eq('is_active', true).order('name')),
    ])
    setRows(rs || [])
    setProducts(ps || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Entity list scoped the same way as Stock Position — master sees every
  // active entity, everyone else only what they've been granted.
  useEffect(() => {
    if (!profile) return
    async function loadEntities() {
      if (hasFullAccess(profile)) {
        const { data: es } = await supabase.from('entities')
          .select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name')
        setEntities(es || [])
      } else {
        // CHANGED: union of direct entity grants AND every entity in a
        // granted group (see useEntityAccess.js for the same pattern) — a
        // user with only group-wise access previously saw an empty
        // dropdown here.
        const [{ data: grants }, { data: groupGrants }] = await Promise.all([
          supabase.from('user_entity_access').select('entity:entity_id(id,name,short_name)').eq('user_id', profile.id),
          supabase.from('user_group_access').select('group_id').eq('user_id', profile.id),
        ])
        const directEntities = (grants || []).map(g => g.entity).filter(Boolean)
        const groupIds = (groupGrants || []).map(g => g.group_id)
        let groupEntities = []
        if (groupIds.length) {
          const { data } = await supabase.from('entities')
            .select('id,name,short_name').in('group_id', groupIds).eq('is_active', true).eq('is_deleted', false)
          groupEntities = data || []
        }
        const byId = new Map()
        for (const e of [...directEntities, ...groupEntities]) byId.set(e.id, e)
        setEntities([...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
      }
    }
    loadEntities()
  }, [profile])

  useEffect(() => {
    let cancelled = false
    async function loadCurrentStock() {
      if (!form.entity_id || !form.product_id) { setCurrentStock(null); return }
      const map = await fetchEntityAvailableStock(form.entity_id)
      if (!cancelled) setCurrentStock(map[form.product_id] ?? 0)
    }
    loadCurrentStock()
    return () => { cancelled = true }
  }, [form.entity_id, form.product_id])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function openNew()  { setEditing(null); setForm(EMPTY_ADJUSTMENT); setModalOpen(true) }
  // CHANGED: "offloaded" was previously only reachable by opening the
  // generic Add Adjustment modal and finding it in the Reason dropdown —
  // easy to miss. A dedicated entry point makes the single most common use
  // of this feature (bulk-removing stock that's done being tracked here)
  // directly discoverable from the toolbar.
  function openNewOffload() { setEditing(null); setForm({ ...EMPTY_ADJUSTMENT, direction: 'decrease', reason: 'offloaded' }); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({
      entity_id: r.entity_id, product_id: r.product_id,
      direction: toNum(r.qty_delta) < 0 ? 'decrease' : 'increase',
      qty: String(Math.abs(toNum(r.qty_delta))),
      reason: r.reason, notes: r.notes || '', adjustment_date: r.adjustment_date || today(),
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.entity_id || !form.product_id) return setToast({ message: 'Entity and Product are required', type: 'error' })
    const qty = toNum(form.qty)
    if (qty <= 0) return setToast({ message: 'Quantity must be greater than zero', type: 'error' })
    setSaving(true)
    const qty_delta = form.direction === 'decrease' ? -qty : qty
    const payload = {
      entity_id: form.entity_id, product_id: form.product_id, qty_delta,
      reason: form.reason, notes: form.notes || null, adjustment_date: form.adjustment_date,
    }
    const res = editing
      ? await supabase.from('stock_adjustments').update(payload).eq('id', editing.id)
      : await supabase.from('stock_adjustments').insert({ ...payload, created_by: profile?.id || null })
    setSaving(false)
    if (res.error) return setToast({ message: res.error.message, type: 'error' })
    setToast({ message: editing ? 'Adjustment updated' : 'Adjustment recorded', type: 'success' })
    setModalOpen(false)
    load()
  }

  async function handleDelete() {
    await supabase.from('stock_adjustments').delete().eq('id', confirmDelete.id)
    setConfirmDelete(null)
    load()
  }

  // CSV: entity,product,qty,reason,adjustment_date,notes — see TEMPLATES.stock_adjustments.
  // Unlike Opening Stock/Products upload, product must already exist (a typo'd
  // product name here should be an error, not silently create a new phantom
  // product) and rows are plain inserts, not upserts — each row is a distinct
  // correction event, so re-uploading the same file intentionally creates
  // duplicate adjustment rows rather than overwriting a prior one.
  // CHANGED: optional `product_id` column — name alone isn't a safe key once
  // duplicate-named products exist at different rates (Stock > Adjustments >
  // Merge Duplicates), since a plain name lookup can silently match the wrong
  // one of several same-named products. If a row supplies product_id, it's
  // used directly (validated against the loaded product list) instead of the
  // name search; the product column is still required for readability/audit.
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'CSV needs header + data rows', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    const header = parseCSVLine(lines[0], delim).map(h => h.trim().toLowerCase())
    const validReasons = ADJUSTMENT_REASONS.map(r => r.value)
    const productsById = new Map(products.map(p => [p.id, p]))
    const payloads = []
    const errors = []
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i], delim)
      const row  = {}
      header.forEach((h, j) => { row[h] = (cols[j] || '').trim() })
      const rowNum = i + 1
      const entity = entities.find(e => e.short_name?.toLowerCase() === row.entity?.toLowerCase() || e.name?.toLowerCase() === row.entity?.toLowerCase())
      const product = row.product_id
        ? productsById.get(row.product_id)
        : products.find(p => p.name?.toLowerCase() === row.product?.toLowerCase())
      if (row.product_id && !product) { errors.push(`Row ${rowNum}: product_id "${row.product_id}" not found`); continue }
      const qty = toNum(row.qty)
      const reason = (row.reason || '').toLowerCase()
      if (!entity)  { errors.push(`Row ${rowNum}: entity "${row.entity}" not found or not accessible to you`); continue }
      if (!product) { errors.push(`Row ${rowNum}: product "${row.product}" not found — add it under Stock > Products first`); continue }
      if (!qty)     { errors.push(`Row ${rowNum}: qty must be a non-zero number`); continue }
      if (!validReasons.includes(reason)) { errors.push(`Row ${rowNum}: reason must be one of ${validReasons.join(', ')}`); continue }
      // Offloading can only remove stock (matches the DB check constraint) —
      // catch it here with a clear message rather than a raw insert error.
      if (reason === 'offloaded' && qty > 0) { errors.push(`Row ${rowNum}: "offloaded" qty must be negative (it can only remove stock, e.g. -5)`); continue }
      payloads.push({
        entity_id: entity.id, product_id: product.id, qty_delta: qty, reason,
        adjustment_date: row.adjustment_date || today(), notes: row.notes || null,
        created_by: profile?.id || null,
      })
    }
    let added = 0
    if (payloads.length > 0) {
      const { error } = await supabase.from('stock_adjustments').insert(payloads)
      if (error) errors.push(`Insert failed: ${error.message}`)
      else added = payloads.length
    }
    setCsvResult({ added, errors })
    await load()
    setCsvSaving(false)
  }

  const filtered = rows.filter(r => !entityFilter || r.entity_id === entityFilter)

  // CHANGED: download of the (filtered) adjustment history — columns lead
  // with the upload format (entity,product,qty,reason,adjustment_date,notes)
  // so an export doubles as a template; extra columns ride along at the end.
  function handleExportAdjustmentsCSV() {
    downloadCSV(`stock_adjustments_${today()}.csv`,
      ['entity','product','qty','reason','adjustment_date','notes','product_id','recorded_by'],
      filtered.map(r => ({
        entity: r.entity?.short_name || r.entity?.name || '',
        product: r.product?.name || '',
        qty: toNum(r.qty_delta),
        reason: r.reason || '',
        adjustment_date: r.adjustment_date || '',
        notes: r.notes || '',
        product_id: r.product_id || '',
        recorded_by: r.creator?.full_name || '',
      })))
  }

  function reasonLabel(reason) {
    return ADJUSTMENT_REASONS.find(r => r.value === reason)?.label.split(' (')[0] || reason
  }

  const columns = [
    { label: 'S.No.',   render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Date',    render: r => fmtDate(r.adjustment_date) },
    { label: 'Entity',  render: r => <span style={{ fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name}</span> },
    { label: 'Product', render: r => <div><div style={{ fontWeight: 600 }}>{r.product?.name}</div><div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>{r.product?.hsn_code}</div></div> },
    { label: 'Qty Δ',   right: true, render: r => (
      <span style={{ fontWeight: 700, color: toNum(r.qty_delta) < 0 ? C.danger : C.success }}>
        {toNum(r.qty_delta) > 0 ? '+' : ''}{Number(r.qty_delta).toLocaleString('en-IN', { maximumFractionDigits: 2 })} {r.product?.unit}
      </span>
    )},
    { label: 'Reason',  render: r => <Badge status={toNum(r.qty_delta) < 0 ? 'pending' : 'active'} label={reasonLabel(r.reason)} /> },
    { label: 'Notes',   render: r => <span style={{ fontSize: '12px', color: C.textMid }}>{r.notes || '—'}</span> },
    { label: 'Recorded by', render: r => <span style={{ fontSize: '12px', color: C.textSoft }}>{r.creator?.full_name || '—'}</span> },
    { label: 'Actions', render: r => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Delete</Btn>
      </div>
    )},
  ]

  return (
    <div>
      {/* CHANGED: sub-tabs — "Merge Duplicates" is a specific flavour of stock
          adjustment (folding one product's stock into another), not a
          separate Stock module tab. */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {[{ key: 'list', label: 'Adjustments' }, { key: 'merge', label: 'Merge Duplicates' }].map(t => (
          <button key={t.key} onClick={() => setSubTab(t.key)} style={{
            padding: '6px 14px', border: `1.5px solid ${C.border}`, cursor: 'pointer', fontFamily: 'inherit',
            fontWeight: subTab === t.key ? 700 : 500, fontSize: '12px', borderRadius: '6px',
            color: subTab === t.key ? '#fff' : C.textSoft,
            background: subTab === t.key ? C.accent : C.surface,
          }}>{t.label}</button>
        ))}
      </div>

      {subTab === 'merge' && <MergeDuplicates />}

      {subTab === 'list' && <>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value=''>All entities</option>
          {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' onClick={handleExportAdjustmentsCSV}>↓ Export CSV</Btn>
        <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
        <Btn variant='ghost' onClick={openNewOffload}>⤓ Offload Stock</Btn>
        <Btn onClick={openNew}>+ Add Adjustment</Btn>
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered}
              emptyState={<EmptyState icon='⚖️' title='No adjustments' message='Record a correction when a physical count finds a shortfall or damage, or offload stock that is done being tracked here.' action={<Btn onClick={openNew}>+ Add Adjustment</Btn>} />}
            />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Adjustment' : 'Add Stock Adjustment'} width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Entity' required>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Product' required>
              {/* CHANGED: searchable picker — a plain dropdown over thousands of products was unusable */}
              <ProductPicker products={products} value={form.product_id} onSelect={id => setF('product_id', id)} />
            </FormRow>
          </div>

          {currentStock !== null && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 14px', fontSize: '13px', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: C.textSoft }}>Current stock on hand</span>
              <strong style={{ color: currentStock < 0 ? C.danger : C.text }}>{currentStock.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Direction' required>
              {/* CHANGED: offloading can only ever remove stock (enforced by
                  a DB check constraint too) — locked to Decrease and
                  disabled rather than left selectable and rejected on save. */}
              <Select value={form.direction} onChange={e => setF('direction', e.target.value)} disabled={form.reason === 'offloaded'}>
                <option value='decrease'>{form.reason === 'offloaded' ? 'Decrease (offloaded)' : 'Decrease (shortfall / damage)'}</option>
                {form.reason !== 'offloaded' && <option value='increase'>Increase (found stock)</option>}
              </Select>
            </FormRow>
            <FormRow label='Quantity' required>
              <Input type='number' value={form.qty} onChange={e => setF('qty', e.target.value)} placeholder='0.000' />
            </FormRow>
          </div>

          {currentStock !== null && form.qty && (
            <div style={{ fontSize: '12px', color: C.textMuted }}>
              New stock after this adjustment: <strong style={{ color: C.text }}>
                {(currentStock + (form.direction === 'decrease' ? -toNum(form.qty) : toNum(form.qty))).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </strong>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Reason' required>
              <Select value={form.reason} onChange={e => {
                const reason = e.target.value
                setForm(f => ({ ...f, reason, direction: reason === 'offloaded' ? 'decrease' : f.direction }))
              }}>
                {ADJUSTMENT_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Adjustment Date' required>
              <Input type='date' value={form.adjustment_date} onChange={e => setF('adjustment_date', e.target.value)} />
            </FormRow>
          </div>
          <FormRow label='Notes' hint='e.g. which count/audit this came from'>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Record Adjustment'}</Btn>
          </div>
        </div>
      </Modal>

      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Stock Adjustments' width={580}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('stock_adjustments')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>entity,product,qty,reason,adjustment_date,notes</code><br />
            <strong>Example:</strong><br />
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>Siddi,T-Shirt Basic Round Neck,-5,shortfall,2025-04-30,Physical count came up short</code><br />
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>Siddi,T-Shirt Basic Round Neck,-40,offloaded,2025-04-30,Sold outside the tool — batch closed out</code><br />
            Entity = short name or full name. Product must match an existing product exactly — it will NOT be auto-created (add it under Products first if missing). Qty is signed: negative = decrease (shortfall/damage/offloaded), positive = increase (found stock). Reason = one of <code>shortfall</code>, <code>damage</code>, <code>found</code>, <code>recount</code>, <code>offloaded</code>, <code>other</code> — use <code>offloaded</code> to bulk-remove stock that's done being tracked here (must be negative). Each row is inserted as its own adjustment — re-uploading the same file adds duplicates rather than overwriting. Offloading (like every adjustment reason) only changes Actual Stock — it never affects the P&amp;L report, which is computed purely from invoice/expense transactions.
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
          </FormRow>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={8}
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.added} adjustment{csvResult.added === 1 ? '' : 's'} recorded, {csvResult.errors.length} error{csvResult.errors.length === 1 ? '' : 's'}.</strong>
              {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Adjustment' message={`Delete this adjustment for ${confirmDelete?.product?.name}? This will change the product's actual stock figure.`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </>}
    </div>
  )
}

// ─── Stock Position Tab ───────────────────────────────────────────────────────
function StockPosition() {
  const [position, setPosition] = useState([])
  const [entities, setEntities] = useState([])
  const [fys, setFys]           = useState([])
  // CHANGED: needed to label entity+product combos that only exist because of
  // invoice activity (no opening_stock row this FY) with product name/HSN/unit.
  const [products, setProducts] = useState([])
  const [entityFilter, setEntityFilter] = useState('')
  const [fyFilter, setFyFilter]         = useState('')
  const [loading, setLoading]   = useState(false)
  // CHANGED: category filter + group-by summary. 'none' | 'category' | 'entity'
  // — a report-style subtotal view (qty + value per group, expandable to the
  // underlying line items, plus a grand total) so a multi-entity "All
  // entities" list isn't just one long undifferentiated table.
  const [categoryFilter, setCategoryFilter] = useState('')
  const [groupBy, setGroupBy] = useState('none')
  // CHANGED: sold-out products (actual stock exactly 0 — everything on hand
  // has moved out, nothing wrong) clutter the table once a business has been
  // running a while. Hidden by default; doesn't touch negative-stock rows,
  // which stay visible since those indicate a real shortfall to investigate.
  const [hideSoldOut, setHideSoldOut] = useState(true)
  // CHANGED: click-to-filter from the Shortfalls / Billed Beyond Stock StatCards
  const [statusFilter, setStatusFilter] = useState(null) // null | 'shortfall' | 'billed_beyond'
  // CHANGED: point-in-time view — blank shows live stock (as of now); a date
  // recomputes every Actual Stock number as of that day (opening rows dated
  // on/before it, invoice movements whose E-way Bill/invoice date is on/
  // before it, adjustments dated on/before it — see filterStockDataAsOf).
  const [asOfDate, setAsOfDate] = useState('')
  // CHANGED: tracks invoice lines with no product_id (known CSV-upload data
  // gap) so we can warn about them instead of showing blank garbage rows
  const [dataIssues, setDataIssues] = useState({ unresolvedLines: 0, unresolvedQty: 0 })
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  function toggleGroup(key) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // CHANGED: current user's role/id decide which entities they may even see
  const { profile } = useAuth()
  const isMaster = hasFullAccess(profile)
  // CHANGED: guards against a stale in-flight load overwriting a newer one —
  // this page's load takes tens of seconds (30k+ invoice lines paged 1000 at
  // a time), so changing any filter mid-load used to race: whichever run
  // finished LAST won, even if it was computed with the old filters. Each
  // run takes a ticket; only the newest ticket may write results.
  const loadSeqRef = useRef(0)

  useEffect(() => {
    if (!profile) return // wait until we know the role before deciding what to fetch
    async function loadFilters() {
      // CHANGED: products can exceed PostgREST's default 1000-row response
      // cap — a plain .select() silently truncated the list past that many
      // products, so any entity+product combo whose product_id fell outside
      // the first page resolved to `undefined` here and rendered as a blank
      // Product/Category/Unit row below despite having real Actual Stock.
      // Page through with fetchAllPages so every product resolves.
      const [{ data: fyData }, { data: ps }] = await Promise.all([
        supabase.from('financial_years').select('*').order('start_date', { ascending: false }),
        fetchAllPages(() => supabase.from('products').select('id,name,hsn_code,unit,category,default_rate').order('id')),
      ])
      setFys(fyData || [])
      setProducts(ps || [])
      if (fyData?.length) setFyFilter(fyData[0].id)

      if (hasFullAccess(profile)) {
        // Master/admin see every entity, "All entities" included — unchanged behaviour.
        const { data: es } = await supabase.from('entities')
          .select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name')
        setEntities(es || [])
        setEntityFilter('')
      } else {
        // CHANGED: everyone else only sees the union of entities they've
        // been explicitly granted via user_entity_access AND every entity
        // in a group they've been granted via user_group_access. No "All
        // entities" option for them — the dropdown is built purely from
        // their grants, and if that union is exactly one entity, it's
        // frozen to that entity (see select below).
        const [{ data: grants }, { data: groupGrants }] = await Promise.all([
          supabase.from('user_entity_access').select('entity:entity_id(id,name,short_name)').eq('user_id', profile.id),
          supabase.from('user_group_access').select('group_id').eq('user_id', profile.id),
        ])
        const directEntities = (grants || []).map(g => g.entity).filter(Boolean)
        const groupIds = (groupGrants || []).map(g => g.group_id)
        let groupEntities = []
        if (groupIds.length) {
          const { data } = await supabase.from('entities')
            .select('id,name,short_name').in('group_id', groupIds).eq('is_active', true).eq('is_deleted', false)
          groupEntities = data || []
        }
        const byId = new Map()
        for (const e of [...directEntities, ...groupEntities]) byId.set(e.id, e)
        const granted = [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        setEntities(granted)
        setEntityFilter(granted[0]?.id || '')
      }
    }
    loadFilters()
  }, [profile])

  const loadPosition = useCallback(async () => {
    if (!fyFilter) return
    const seq = ++loadSeqRef.current
    setLoading(true)

    // Get opening stock
    // CHANGED: stock_opening_balance can exceed PostgREST's default 1000-row
    // cap once entities/products are numerous (a plain .select() silently
    // truncates rather than erroring) — page through with fetchAllPages so
    // the Opening/Planned columns don't silently drop rows past row 1000,
    // same fix already applied to the Opening Stock tab's own load().
    const { data: opening } = await fetchAllPages(() => {
      let q = supabase.from('stock_opening_balance')
        .select('*, entity:entity_id(name,short_name), product:product_id(name,hsn_code,unit,category)')
        .eq('financial_year_id', fyFilter)
        .order('id')
      if (entityFilter) q = q.eq('entity_id', entityFilter)
      return q
    })

    // Get PIs — incoming and outgoing per entity+product
    // We need proforma_invoice_lines joined with proforma_invoices
    // Planned stock = opening + incoming PI qty - outgoing PI qty
    // CHANGED: same 1000-row cap risk as opening stock above — page through.
    const { data: piLinesRaw } = await fetchAllPages(() => supabase
      .from('proforma_invoice_lines')
      .select('qty, product_id, pi:pi_id(from_entity_id, to_entity_id, status, is_deleted, pi_date)')
      .not('pi', 'is', null)
      .neq('pi.status', 'cancelled')
      .order('id'))
    // CHANGED: the query above can't filter on a joined column's is_deleted
    // directly (PostgREST .neq only applies to the joined row shape, not a
    // second condition on it) — a soft-deleted PI kept counting toward
    // Planned stock forever since only `status` was checked. Filter it out
    // client-side same as fetchStockMovementData() already does for invoices.
    // CHANGED: the as-of date applies to Planned too — only PIs dated on or
    // before it count toward the point-in-time position.
    const piLines = (piLinesRaw || []).filter(l => l.pi && !l.pi.is_deleted && (!asOfDate || !l.pi.pi_date || l.pi.pi_date <= asOfDate))

    // CHANGED: Actual Stock — the real, invoice-based position per entity.
    // This is deliberately NOT scoped to fyFilter: opening stock is entered
    // incrementally whenever new stock is purchased (not reset each FY), so
    // actual stock must be a running total across all-time opening entries +
    // all-time invoice movements. Reuses the same tested logic that already
    // feeds LineItemsEditor's available-stock check.
    // CHANGED: when an as-of date is set, restrict every movement source to
    // what had happened by that day — the whole page becomes "stock status
    // as of <date>" instead of "right now". fetchActualStockPosition() hits
    // the server-side aggregation RPC (migration 041) when available — one
    // round trip instead of paging through every raw invoice line.
    const actualMap = await fetchActualStockPosition(asOfDate)

    // Build position map: key = entity_id + product_id
    const map = {}
    for (const ob of (opening || [])) {
      if (asOfDate && ob.as_of_date && ob.as_of_date > asOfDate) continue
      const key = `${ob.entity_id}__${ob.product_id}`
      map[key] = {
        entity_id:   ob.entity_id,
        entity:      ob.entity,
        product_id:  ob.product_id,
        product:     ob.product,
        opening_qty: toNum(ob.qty),
        incoming:    0,
        outgoing:    0,
        rate:        ob.rate,
      }
    }

    // Add PI movements
    for (const line of (piLines || [])) {
      if (!line.pi) continue
      const qty       = toNum(line.qty)
      const productId = line.product_id
      const fromKey   = `${line.pi.from_entity_id}__${productId}`
      const toKey     = `${line.pi.to_entity_id}__${productId}`
      if (map[fromKey]) map[fromKey].outgoing += qty
      if (map[toKey])   map[toKey].incoming   += qty
    }

    // CHANGED: surface entity+product combos that have real invoice activity
    // (via actualMap) but no opening_stock row in the selected FY — e.g. a
    // pure buyer entity. Without this they'd hold real stock but be invisible
    // on this page.
    // CHANGED: skip any combo where product_id is null — these come from
    // invoice/PI lines with no product link (a known CSV-upload data gap,
    // not a real product) and would otherwise show up as blank, meaningless
    // rows. Counted separately below so the problem stays visible instead of
    // silently vanishing.
    const entityById  = Object.fromEntries(entities.map(e => [e.id, e]))
    const productById = Object.fromEntries(products.map(p => [p.id, p]))
    let unresolvedLines = 0, unresolvedQty = 0
    for (const row of Object.values(actualMap)) {
      if (!row.product_id) {
        unresolvedLines++
        unresolvedQty += Math.abs(toNum(row.invoiced_in) - toNum(row.invoiced_out))
        continue
      }
      if (entityFilter && row.entity_id !== entityFilter) continue
      const key = `${row.entity_id}__${row.product_id}`
      if (!map[key]) {
        // CHANGED: these rows have real actual stock but no opening-balance
        // row for the CURRENTLY SELECTED FY (e.g. the opening entry was made
        // under a prior FY) — rate defaulted to 0 here, which silently
        // zeroed out Actual Value for every such row despite a genuinely
        // nonzero Actual Stock. Fall back to the product's own default_rate
        // so valuation reflects the real stock instead of vanishing.
        map[key] = {
          entity_id:   row.entity_id,
          entity:      entityById[row.entity_id] || null,
          product_id:  row.product_id,
          product:     productById[row.product_id] || null,
          opening_qty: 0,
          incoming:    0,
          outgoing:    0,
          rate:        toNum(productById[row.product_id]?.default_rate),
        }
      }
    }
    if (seq !== loadSeqRef.current) return // superseded by a newer load — discard
    setDataIssues({ unresolvedLines, unresolvedQty })

    // Compute planned qty (PI-based, unchanged) and actual qty (invoice-based)
    // CHANGED: carry the actual_qty breakdown (invoiced_in/out, adjustments)
    // through too, not just the final number — "Billed Beyond Stock" alone
    // gives no way to tell WHY a row went negative (real oversell vs. a
    // stock-movement source this app isn't counting), so the Actual Stock
    // column below shows the components for any row that's negative.
    const rows = Object.values(map).map(r => {
      const key = `${r.entity_id}__${r.product_id}`
      const am  = actualMap[key]
      const actual_qty = am ? am.actual_qty : r.opening_qty
      return {
        ...r,
        planned_qty: r.opening_qty + r.incoming - r.outgoing,
        actual_qty,
        actual_invoiced_in:  am ? am.invoiced_in  : 0,
        actual_invoiced_out: am ? am.invoiced_out : 0,
        actual_adjustment:   am ? am.adjustment_qty : 0,
        billed_beyond_stock: actual_qty < 0,
      }
    })
    // CHANGED: hide rows with nothing to show — no opening, no PI movement, no
    // actual stock. These carry no information and just pad the table.
    .filter(r => !(r.opening_qty === 0 && r.incoming === 0 && r.outgoing === 0 && r.actual_qty === 0))

    setPosition(rows)
    setLoading(false)
  }, [entityFilter, fyFilter, entities, products, asOfDate])

  useEffect(() => { loadPosition() }, [loadPosition])

  // CHANGED: category filter applied client-side (product.category comes
  // through the join, not filterable server-side without a second query)
  const categories = [...new Set(position.map(r => r.product?.category).filter(Boolean))].sort()
  const categoryOnlyFiltered = position
    .filter(r => !categoryFilter || r.product?.category === categoryFilter)
    .filter(r => !hideSoldOut || r.actual_qty !== 0)

  // CHANGED: counts always reflect the category filter only, never the status
  // toggle itself — otherwise clicking "Shortfalls" would make its own count
  // collapse to match whatever's left after filtering.
  const shortfallCount = categoryOnlyFiltered.filter(r => r.planned_qty < 0).length
  const billedBeyondCount = categoryOnlyFiltered.filter(r => r.billed_beyond_stock).length

  // CHANGED: clicking a StatCard filters the table down to just those rows;
  // clicking the same one again clears it.
  const filteredPosition = (statusFilter === 'shortfall'
    ? categoryOnlyFiltered.filter(r => r.planned_qty < 0)
    : statusFilter === 'billed_beyond'
    ? categoryOnlyFiltered.filter(r => r.billed_beyond_stock)
    : categoryOnlyFiltered
  ).map((r, i) => ({ ...r, sno: i + 1 }))

  // CHANGED: group → totals (planned qty, opening value, actual value) + line
  // items, for the report-style group-by view — shared builder so Category
  // and Entity grouping are the same code path instead of two copies.
  function buildGroupedRows(rows, keyFn) {
    const map = {}
    for (const r of rows) {
      const key = keyFn(r) || 'Uncategorised'
      if (!map[key]) map[key] = { key, qty: 0, value: 0, actualValue: 0, items: [] }
      map[key].qty         += toNum(r.actual_qty)
      map[key].value       += toNum(r.opening_qty) * toNum(r.rate)
      map[key].actualValue += toNum(r.actual_qty) * toNum(r.rate)
      map[key].items.push(r)
    }
    return Object.values(map).sort((a, b) => b.value - a.value)
  }
  const groupedRows = groupBy === 'category'
    ? buildGroupedRows(filteredPosition, r => r.product?.category)
    : groupBy === 'entity'
    ? buildGroupedRows(filteredPosition, r => r.entity?.short_name || r.entity?.name)
    : []
  const groupLabel = groupBy === 'entity' ? 'Entity' : 'Category'
  const grandTotal = groupedRows.reduce((s, g) => ({
    products: s.products + g.items.length, qty: s.qty + g.qty, value: s.value + g.value, actualValue: s.actualValue + g.actualValue,
  }), { products: 0, qty: 0, value: 0, actualValue: 0 })

  const totalValue       = filteredPosition.reduce((s, r) => s + toNum(r.opening_qty) * toNum(r.rate), 0)
  // CHANGED: Actual Stock is the headline number on this page now (see the
  // Actual Stock column below) — surface its value alongside Opening Value
  // rather than only showing the opening-based figure.
  const totalActualValue = filteredPosition.reduce((s, r) => s + toNum(r.actual_qty) * toNum(r.rate), 0)
  // CHANGED: qty subtotal broken out per unit (Mtrs/Nos/etc.) since summing
  // raw qty across mixed units is meaningless — same pattern already used on
  // the Opening Stock tab's StatCard summary. Sums actual_qty (this page's
  // headline metric, see Actual Stock column) rather than planned_qty — a
  // row can carry real Actual Stock with planned_qty still at 0 (no PI
  // movement / no opening row this FY), which made this read "0 Nos" even
  // when the table plainly showed nonzero Actual Stock on every row.
  const qtyByUnit = filteredPosition.reduce((m, r) => {
    const u = r.product?.unit || 'Nos'
    m[u] = (m[u] || 0) + toNum(r.actual_qty)
    return m
  }, {})
  const qtySummary = Object.entries(qtyByUnit).map(([u, q]) => `${q.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${u}`).join(' • ') || '0'

  const columns = [
    // CHANGED: running row number for reference while editing/cross-checking
    { label: 'S.No.',    render: r => <span style={{ color: C.textMuted }}>{r.sno}</span> },
    { label: 'Entity',   render: r => <span style={{ fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name}</span> },
    { label: 'Category', render: r => <span style={{ fontSize: '12px', color: C.textMid }}>{r.product?.category || '—'}</span> },
    { label: 'Product',  render: r => <div><div style={{ fontWeight: 600 }}>{r.product?.name}</div><div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>{r.product?.hsn_code}</div></div> },
    { label: 'Unit',     render: r => <span style={{ fontSize: '12px' }}>{r.product?.unit}</span> },
    // CHANGED: Actual Stock is now the headline number — real, invoice-based
    // stock the entity actually holds right now (opening + all invoiced in −
    // all invoiced out, all-time). Placed right after Unit so it reads first.
    // CHANGED: negative rows show the breakdown that produced the number
    // (opening + invoiced-in − invoiced-out ± adjustments) right underneath
    // — "Billed Beyond Stock" alone gave no way to tell whether this is a
    // real oversell or a stock movement this app isn't counting (e.g. a
    // purchase recorded through a source this page doesn't see).
    { label: 'Actual Stock', right: true, render: r => (
      <div>
        <span style={{ fontWeight: 800, fontSize: '14px', color: r.actual_qty < 0 ? C.danger : C.text }}>
          {Number(r.actual_qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
        </span>
        {r.actual_qty < 0 && (
          <div style={{ fontSize: '10px', color: C.textMuted, whiteSpace: 'nowrap', marginTop: '2px' }}>
            Open {Number(r.opening_qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })} + In {Number(r.actual_invoiced_in).toLocaleString('en-IN', { maximumFractionDigits: 2 })} − Out {Number(r.actual_invoiced_out).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            {r.actual_adjustment !== 0 ? ` ${r.actual_adjustment > 0 ? '+' : '−'} Adj ${Math.abs(r.actual_adjustment).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : ''}
          </div>
        )}
      </div>
    )},
    { label: 'Opening',  right: true, render: r => <span style={{ color: C.textMuted }}>{Number(r.opening_qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span> },
    { label: '+ Incoming PI', right: true, render: r => <span style={{ color: C.success }}>+{Number(r.incoming).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span> },
    { label: '− Outgoing PI', right: true, render: r => <span style={{ color: C.danger }}>−{Number(r.outgoing).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span> },
    { label: 'Planned',  right: true, render: r => (
      <span style={{ fontWeight: 700, color: r.planned_qty < 0 ? C.danger : r.planned_qty === 0 ? C.warning : C.success }}>
        {Number(r.planned_qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
      </span>
    )},
    // CHANGED: two independent indicators — Planned/PI shortfall (unchanged)
    // and the new Actual/billed-beyond-stock flag, stacked when both apply.
    { label: 'Status',   render: r => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
        {shortfallBadge(r.planned_qty)}
        {r.billed_beyond_stock && billedBeyondStockBadge()}
      </div>
    )},
  ]

  function handleExportCSV() {
    // CHANGED: export the currently filtered rows (respects entity/category
    // filters already applied on screen), category column added.
    // CHANGED: actual_qty and billed_beyond_stock columns added.
    // Filename carries the as-of date when one is set, so exports from
    // different points in time don't overwrite each other.
    downloadCSV(`stock_position_${asOfDate ? 'as_of_' + asOfDate : new Date().toISOString().split('T')[0]}.csv`,
      ['sno','entity','category','product','hsn_code','unit','actual_qty','billed_beyond_stock','opening_qty','incoming_pi_qty','outgoing_pi_qty','planned_qty','status'],
      filteredPosition.map(r=>({sno:r.sno,entity:r.entity?.name||'',category:r.product?.category||'',product:r.product?.name||'',hsn_code:r.product?.hsn_code||'',unit:r.product?.unit||'',actual_qty:r.actual_qty||0,billed_beyond_stock:r.billed_beyond_stock?'Yes':'No',opening_qty:r.opening_qty||0,incoming_pi_qty:r.incoming||0,outgoing_pi_qty:r.outgoing||0,planned_qty:r.planned_qty||0,status:r.planned_qty<0?'Shortfall':r.planned_qty===0?'Zero':'OK'}))
    )
  }

  return (
    <div>
      {/* CHANGED: data-quality warning — invoice/PI lines with no product
          link (CSV-upload gap) are excluded from the table below rather than
          shown as blank garbage rows, but surfaced here so the problem isn't
          silently lost. */}
      {dataIssues.unresolvedLines > 0 && (
        <div style={{ background: '#fff3cc', border: '1px solid #e6c040', borderRadius: '6px', padding: '10px 14px', fontSize: '12px', color: '#7a5000', marginBottom: '16px' }}>
          ⚠ {dataIssues.unresolvedLines} invoice line{dataIssues.unresolvedLines === 1 ? '' : 's'} (~{Number(dataIssues.unresolvedQty).toLocaleString('en-IN', { maximumFractionDigits: 2 })} units) have no product linked and are excluded from the table below — likely from CSV-uploaded PIs/Invoices missing a product reference. This is a data issue, not a display bug; the actual stock numbers shown for real products are correct.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        {/* CHANGED: clicking toggles a table filter; clicking the same card again clears it */}
        <StatCard label='Shortfalls'    value={shortfallCount} color={shortfallCount > 0 ? C.danger : C.success}
          onClick={() => setStatusFilter(f => f === 'shortfall' ? null : 'shortfall')}
          sub={statusFilter === 'shortfall' ? '● Filtering — click to clear' : 'Click to filter'} />
        {/* CHANGED: billed-beyond-stock count — entities that have invoiced out more than they actually had */}
        <StatCard label='Billed Beyond Stock' value={billedBeyondCount} color={billedBeyondCount > 0 ? C.danger : C.success}
          onClick={() => setStatusFilter(f => f === 'billed_beyond' ? null : 'billed_beyond')}
          sub={statusFilter === 'billed_beyond' ? '● Filtering — click to clear' : 'Click to filter'} />
        <StatCard label='Products'      value={filteredPosition.length} />
        <StatCard label='Opening Value' value={formatINR(totalValue)} />
        {/* CHANGED: Actual Value + Qty subtotal — report-style totals for the
            currently filtered line items, always visible (not just when
            grouped below). */}
        <StatCard label='Actual Value'  value={formatINR(totalActualValue)} />
        <StatCard label='Total Qty'     value={qtySummary} />
      </div>
      {/* CHANGED: explicit clear-filter affordance when a status filter is active */}
      {statusFilter && (
        <div style={{ marginBottom: '12px' }}>
          <Btn size='sm' variant='ghost' onClick={() => setStatusFilter(null)}>
            ✕ Clear "{statusFilter === 'shortfall' ? 'Shortfalls' : 'Billed Beyond Stock'}" filter
          </Btn>
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={fyFilter} onChange={e => setFyFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {/* CHANGED: entity dropdown is now access-scoped — master gets "All
            entities" + full list; anyone else only sees their granted
            entities, and is frozen to it if they only have one. */}
        <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)}
          disabled={!isMaster && entities.length <= 1}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: (!isMaster && entities.length <= 1) ? C.bg : C.surface, fontSize: '13px', outline: 'none', cursor: (!isMaster && entities.length <= 1) ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
          {isMaster && <option value=''>All entities</option>}
          {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
        </select>
        {!isMaster && entities.length <= 1 && (
          <span style={{ fontSize: '11px', color: C.textMuted }}>🔒 Locked to your assigned entity</span>
        )}
        {/* CHANGED: category filter */}
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value=''>All categories</option>
          {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
        </select>
        {/* CHANGED: group-by summary — report-style subtotals (qty + value)
            per category or entity, expandable to line items, with a grand
            total. Mutually exclusive; click the active one again to clear. */}
        <Btn size='sm' variant={groupBy === 'category' ? 'primary' : 'ghost'} onClick={() => setGroupBy(g => g === 'category' ? 'none' : 'category')}>
          {groupBy === 'category' ? '✓ ' : ''}Group by category
        </Btn>
        <Btn size='sm' variant={groupBy === 'entity' ? 'primary' : 'ghost'} onClick={() => setGroupBy(g => g === 'entity' ? 'none' : 'entity')}>
          {groupBy === 'entity' ? '✓ ' : ''}Group by entity
        </Btn>
        {/* CHANGED: sold-out products (0 actual stock) hidden by default to
            cut clutter — toggle back on for a full audit view. */}
        <Btn size='sm' variant={hideSoldOut ? 'ghost' : 'primary'} onClick={() => setHideSoldOut(h => !h)}>
          {hideSoldOut ? 'Show sold-out products' : '✓ Showing sold-out products'}
        </Btn>
        {/* CHANGED: point-in-time view — pick a date to see stock status as of
            that day; blank = live (now). */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: C.textSoft }}>
          Stock as of
          <input type='date' value={asOfDate} onChange={e => setAsOfDate(e.target.value)}
            style={{ padding: '6px 10px', border: `1.5px solid ${asOfDate ? C.accent : C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }} />
        </label>
        {asOfDate && <Btn size='sm' variant='ghost' onClick={() => setAsOfDate('')}>✕ Back to live</Btn>}
        <Btn size='sm' variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
      </div>
      {asOfDate && (
        <div style={{ background: '#e8f3fd', border: '1px solid #b8d8f8', borderRadius: '6px', padding: '8px 12px', fontSize: '12px', color: '#1a4a7a', marginBottom: '12px' }}>
          📅 Showing stock status as of <strong>{fmtDate(asOfDate)}</strong> — only movements dated on or before this day are counted. Clear the date to return to the live position.
        </div>
      )}

      {/* CHANGED: report-style group-by table — click a group row to expand
          its line items, with a grand total row at the bottom. Works for
          either Category or Entity grouping (groupLabel/groupedRows switch
          together above). */}
      {groupBy !== 'none' && (
        <Card style={{ marginBottom: '16px', padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  {['', groupLabel, 'Products', 'Total Qty', 'Opening Value', 'Actual Value'].map((h, i) => (
                    <th key={i} style={{
                      padding: '8px 12px', textAlign: i >= 2 ? 'right' : 'left',
                      fontSize: '11px', fontWeight: 700, color: '#9a8a6a',
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      background: C.bg, borderBottom: `1px solid ${C.border}`, borderTop: `1px solid ${C.border}`,
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupedRows.map(({ key, qty, value, actualValue, items }) => {
                  const open = expandedGroups.has(key)
                  return (
                    <Fragment key={key}>
                      <tr onClick={() => toggleGroup(key)} style={{ cursor: 'pointer', background: C.surface }}>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, color: C.textMuted, width: '24px' }}>{open ? '▾' : '▸'}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{key}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', color: C.textMid }}>{items.length}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontWeight: 700 }}>{qty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right' }}>{formatINR(value)}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right' }}>{formatINR(actualValue)}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={6} style={{ padding: 0, borderBottom: `1px solid ${C.border}`, background: C.bg }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                              <thead>
                                <tr>
                                  {[groupBy === 'entity' ? 'Category' : 'Entity', 'Product', 'HSN', 'Unit', 'Opening Qty', 'Actual Qty', 'Rate', 'Value'].map((h, i) => (
                                    <th key={i} style={{
                                      padding: '6px 12px 6px 32px', textAlign: i >= 4 ? 'right' : 'left',
                                      fontSize: '10px', fontWeight: 700, color: C.textMuted,
                                      textTransform: 'uppercase', letterSpacing: '0.04em',
                                      borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
                                    }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {items.map(it => (
                                  <tr key={`${it.entity_id}__${it.product_id}`}>
                                    <td style={{ padding: '7px 12px 7px 32px' }}>{groupBy === 'entity' ? (it.product?.category || '—') : (it.entity?.short_name || it.entity?.name)}</td>
                                    <td style={{ padding: '7px 12px' }}>{it.product?.name}</td>
                                    <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.textMuted }}>{it.product?.hsn_code}</td>
                                    <td style={{ padding: '7px 12px' }}>{it.product?.unit}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right' }}>{Number(it.opening_qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right' }}>{Number(it.actual_qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right' }}>{formatINR(it.rate)}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>{formatINR(toNum(it.opening_qty) * toNum(it.rate))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} style={{ padding: '10px 12px', fontWeight: 800, borderTop: `2px solid ${C.border}` }}>Grand Total</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, borderTop: `2px solid ${C.border}` }}>{grandTotal.products}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, borderTop: `2px solid ${C.border}` }}>{grandTotal.qty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, borderTop: `2px solid ${C.border}` }}>{formatINR(grandTotal.value)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, borderTop: `2px solid ${C.border}` }}>{formatINR(grandTotal.actualValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Calculating stock position…</div>
          : <Table columns={columns} rows={filteredPosition}
              emptyState={<EmptyState icon='📦' title={statusFilter ? 'No matching rows' : 'No stock data'} message={statusFilter ? 'Nothing matches this filter right now — try clearing it.' : 'Add opening stock first, then create PIs to see planned position.'} />}
            />
        }
      </Card>
    </div>
  )
}

// ─── Merge Duplicates Tab ───────────────────────────────────────────────────
// Surfaces product groups that share a name (junk-stripped) and HSN code but
// differ in rate — the exact signature the dedupe_products.sql /
// dedupe_rate_markup_products.sql / merge_idle_rounding_duplicates.sql
// maintenance scripts were hand-run against in the past (see supabase/
// maintenance/). This turns that one-off SQL review into a standing, repeatable
// tool: suggest a keeper (the product actually carrying stock/usage), let a
// master review/override it, then merge via the merge_products() RPC (see
// migration 022_merge_products.sql) which atomically repoints every
// referencing table and folds opening-stock quantities before deleting the
// duplicate — the same repoint-then-delete shape as the maintenance scripts,
// just parameterized and callable from the UI instead of hand-run once.
function MergeDuplicates() {
  const { profile } = useAuth()
  const canMerge = hasFullAccess(profile)

  const [products, setProducts] = useState([])
  const [totals, setTotals]     = useState({}) // product_id -> { opening, actual }
  const [loading, setLoading]   = useState(true)
  const [keeperOverride, setKeeperOverride] = useState({}) // group.key -> product_id
  const [confirmGroup, setConfirmGroup] = useState(null)
  const [merging, setMerging]   = useState(false)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ps }, actualMap] = await Promise.all([
      fetchAllPages(() => supabase.from('products')
        .select('id,name,hsn_code,gst_rate,unit,default_rate,is_active,created_at')
        .eq('is_active', true).order('name')),
      fetchActualStockPosition(),
    ])
    setProducts(ps || [])
    const t = {}
    for (const row of Object.values(actualMap)) {
      if (!row.product_id) continue
      if (!t[row.product_id]) t[row.product_id] = { opening: 0, actual: 0 }
      t[row.product_id].opening += row.opening_qty
      t[row.product_id].actual  += row.actual_qty
    }
    setTotals(t)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // CHANGED: suggested keeper = the product actually holding the most real
  // (actual) stock, tie-broken by opening qty then oldest record — the same
  // "prefer the one already in use" instinct as dedupe_products.sql's
  // has_opening ranking, just using the richer actual-stock signal already
  // available here instead of a boolean.
  const groups = findMergeSuggestionGroups(products).map(g => {
    const enriched = g.products
      .map(p => ({ ...p, _opening: totals[p.id]?.opening || 0, _actual: totals[p.id]?.actual || 0 }))
      .sort((a, b) => b._actual - a._actual || b._opening - a._opening || new Date(a.created_at) - new Date(b.created_at))
    return { ...g, products: enriched, suggestedKeeperId: enriched[0]?.id }
  })

  function keeperFor(g) { return keeperOverride[g.key] || g.suggestedKeeperId }

  function handleDownloadSuggestions() {
    const rows = []
    for (const g of groups) {
      const keeperId = keeperFor(g)
      for (const p of g.products) {
        rows.push({
          group: g.name, hsn_code: g.hsn_code, product_id: p.id, product_name: p.name,
          rate: p.default_rate ?? '', gst_rate: p.gst_rate ?? '', unit: p.unit || '',
          total_opening_qty: p._opening, total_actual_qty: p._actual,
          suggestion: p.id === keeperId ? 'KEEP' : 'MERGE INTO KEEPER',
        })
      }
    }
    downloadCSV(`merge_stock_suggestions_${today()}.csv`,
      ['group', 'hsn_code', 'product_id', 'product_name', 'rate', 'gst_rate', 'unit', 'total_opening_qty', 'total_actual_qty', 'suggestion'],
      rows)
  }

  async function handleMerge(g) {
    if (!g || merging) return
    const keeperId = keeperFor(g)
    const dupIds = g.products.map(p => p.id).filter(id => id !== keeperId)
    setMerging(true)
    const errors = []
    for (const dupId of dupIds) {
      const { error } = await supabase.rpc('merge_products', { p_keeper_id: keeperId, p_dup_id: dupId })
      if (error) errors.push(error.message)
    }
    setMerging(false)
    setConfirmGroup(null)
    if (errors.length) setToast({ message: `${g.name}: ${errors.join(' • ')}`, type: 'error' })
    else setToast({ message: `Merged ${dupIds.length} duplicate${dupIds.length === 1 ? '' : 's'} into "${g.products.find(p => p.id === keeperId)?.name}"`, type: 'success' })
    load()
  }

  const totalDuplicateProducts = groups.reduce((s, g) => s + g.products.length - 1, 0)

  return (
    <div>
      {!canMerge && (
        <div style={{ background: '#fff3cc', border: '1px solid #e6c040', borderRadius: '6px', padding: '10px 14px', fontSize: '12px', color: '#7a5000', marginBottom: '16px' }}>
          🔒 Only master users can perform a merge. You can still review and download the suggestions below.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '16px' }}>
        <StatCard label='Groups Found' value={groups.length} color={groups.length > 0 ? C.accent : undefined} />
        <StatCard label='Duplicate Products' value={totalDuplicateProducts} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <Btn variant='ghost' onClick={handleDownloadSuggestions} disabled={groups.length === 0}>↓ Download All Suggestions (CSV)</Btn>
      </div>

      {loading ? (
        <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Scanning products…</div>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState icon='✅' title='No merge suggestions' message='No active products currently share a name and HSN code at different rates.' />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {groups.map(g => {
            const keeperId = keeperFor(g)
            return (
              <Card key={g.key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{g.name}</div>
                    <div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>HSN {g.hsn_code} • {g.products.length} product records at different rates</div>
                  </div>
                  {canMerge && (
                    <Btn size='sm' onClick={() => setConfirmGroup(g)} disabled={merging}>Merge {g.products.length - 1} into keeper</Btn>
                  )}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr>
                        {['', 'Rate', 'GST %', 'Unit', 'Opening Qty', 'Actual Stock', ''].map((h, i) => (
                          <th key={i} style={{ padding: '6px 10px', textAlign: (i >= 1 && i <= 4) ? 'right' : 'left', fontSize: '10px', fontWeight: 700, color: '#9a8a6a', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {g.products.map(p => (
                        <tr key={p.id} style={{ background: p.id === keeperId ? '#e8f3ec' : 'transparent' }}>
                          <td style={{ padding: '7px 10px' }}>
                            <input type='radio' name={`keeper-${g.key}`} checked={p.id === keeperId}
                              onChange={() => setKeeperOverride(o => ({ ...o, [g.key]: p.id }))}
                              disabled={!canMerge} />
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatINR(p.default_rate)}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' }}>{p.gst_rate}%</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' }}>{p.unit}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' }}>{Number(p._opening).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: p.id === keeperId ? 700 : 400 }}>{Number(p._actual).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                          <td style={{ padding: '7px 10px' }}>{p.id === keeperId && <Badge status='active' label='Suggested keeper' />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <ConfirmModal open={!!confirmGroup} onClose={() => !merging && setConfirmGroup(null)} onConfirm={() => handleMerge(confirmGroup)}
        title='Merge Duplicate Products'
        message={confirmGroup ? `Merge ${confirmGroup.products.length - 1} product record(s) into "${confirmGroup.products.find(p => p.id === keeperFor(confirmGroup))?.name}"? Every PI/PO/Invoice/adjustment line referencing them will be repointed to the keeper, matching opening-stock quantities will be added together, and the duplicate product records will be permanently deleted. This cannot be undone.` : ''}
        danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Products Tab ─────────────────────────────────────────────────────────────
const EMPTY_PRODUCT = {
  name: '', description: '', hsn_code: '', gst_rate: '18',
  unit: 'Nos', default_rate: '', is_active: true,
  category: '', // CHANGED: product category
}

function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_PRODUCT)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]       = useState(null)
  // CSV
  const [csvModal, setCsvModal] = useState(false)
  const [csvText, setCsvText]   = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('products').select('*').order('name')
    setProducts(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function openNew()   { setEditing(null); setForm(EMPTY_PRODUCT); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({ name: r.name||'', description: r.description||'', hsn_code: r.hsn_code||'', gst_rate: r.gst_rate!=null?String(r.gst_rate):'18', unit: r.unit||'Nos', default_rate: r.default_rate!=null?String(r.default_rate):'', is_active: r.is_active!==false, category: r.category||'' })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim() || !form.hsn_code.trim())
      return setToast({ message: 'Name and HSN Code are required', type: 'error' })
    setSaving(true)
    const payload = { name: cleanProductName(form.name), description: form.description||null, hsn_code: form.hsn_code.trim(), gst_rate: toNum(form.gst_rate), unit: form.unit, default_rate: toNum(form.default_rate)||null, is_active: form.is_active, category: form.category||null, updated_at: new Date() }
    let error
    if (editing) {
      const res = await supabase.from('products').update(payload).eq('id', editing.id)
      error = res.error
    } else {
      const res = await supabase.from('products').insert(payload)
      error = res.error
    }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'Updated' : 'Created', type: 'success' })
    setModalOpen(false); load()
  }

  async function handleDelete() {
    await supabase.from('products').update({ is_active: false }).eq('id', confirmDelete.id)
    setConfirmDelete(null); load()
  }

  // CSV: name,hsn_code,gst_rate,unit,default_rate,description,category
  // CHANGED: category column added (optional — blank is fine)
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    const header = parseCSVLine(lines[0], delim).map(h => h.toLowerCase())
    let added = 0, errors = []
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i], delim)
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      if (!row.name || !row.hsn_code) { errors.push(`Row ${i+1}: name and hsn_code required`); continue }
      const { error } = await supabase.from('products').upsert({
        name: row.name, hsn_code: row.hsn_code, gst_rate: toNum(row.gst_rate)||18,
        unit: row.unit||'Nos', default_rate: toNum(row.default_rate)||null,
        description: row.description||null, category: row.category||null, is_active: true, updated_at: new Date(),
      }, { onConflict: 'name' })
      if (error) errors.push(`Row ${i+1}: ${error.message}`)
      else added++
    }
    setCsvResult({ added, errors })
    await load()
    setCsvSaving(false)
  }

  const filtered = products.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.hsn_code.includes(search))

  // CHANGED: download of the (filtered) product catalog — columns lead with
  // the upload format (name,hsn_code,gst_rate,unit,default_rate,description,
  // category) so an export can be corrected and re-uploaded; status rides
  // along at the end.
  function handleExportCSV() {
    downloadCSV(`products_${today()}.csv`,
      ['name','hsn_code','gst_rate','unit','default_rate','description','category','status'],
      filtered.map(p => ({
        name: p.name || '', hsn_code: p.hsn_code || '', gst_rate: p.gst_rate ?? '',
        unit: p.unit || '', default_rate: p.default_rate ?? '', description: p.description || '',
        category: p.category || '', status: p.is_active ? 'Active' : 'Inactive',
      })))
  }

  const columns = [
    { label: 'S.No.',     render: (p, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Name',      render: p => <div><div style={{ fontWeight: 600 }}>{p.name}</div>{p.description && <div style={{ fontSize: '11px', color: C.textMuted }}>{p.description}</div>}</div> },
    { label: 'Category',  render: p => <span style={{ fontSize: '12px', color: C.textMid }}>{p.category || '—'}</span> },
    { label: 'HSN',       render: p => <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{p.hsn_code}</span> },
    { label: 'GST %',     render: p => <span style={{ fontSize: '12px' }}>{p.gst_rate}%</span> },
    { label: 'Unit',      render: p => <span style={{ fontSize: '12px' }}>{p.unit}</span> },
    { label: 'Default Rate', right: true, render: p => p.default_rate ? formatINR(p.default_rate) : <span style={{ color: C.textMuted }}>—</span> },
    { label: 'Status',    render: p => <Badge status={p.is_active ? 'active' : 'cancelled'} label={p.is_active ? 'Active' : 'Inactive'} /> },
    { label: 'Actions',   render: p => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(p)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(p)} style={{ color: C.danger }}>Deactivate</Btn>
      </div>
    )},
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search products…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, fontFamily: 'inherit' }} />
        <Btn variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
        <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
        <Btn onClick={openNew}>+ New Product</Btn>
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered}
              emptyState={<EmptyState icon='📦' title='No products' action={<Btn onClick={openNew}>+ New Product</Btn>} />}
            />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Product' : 'New Product'} width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Name' required><Input value={form.name} onChange={e => setF('name', e.target.value)} /></FormRow>
          <FormRow label='Description'><Textarea value={form.description} onChange={e => setF('description', e.target.value)} rows={2} /></FormRow>
          <FormRow label='Category'><Input value={form.category} onChange={e => setF('category', e.target.value)} placeholder='e.g. Home Textiles, Cushions' /></FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='HSN Code' required><Input value={form.hsn_code} onChange={e => setF('hsn_code', e.target.value)} style={{ fontFamily: 'monospace' }} /></FormRow>
            <FormRow label='GST Rate %'><Input type='number' value={form.gst_rate} onChange={e => setF('gst_rate', e.target.value)} /></FormRow>
            <FormRow label='Unit'>
              <Select value={form.unit} onChange={e => setF('unit', e.target.value)}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Default Rate (₹)'><Input type='number' value={form.default_rate} onChange={e => setF('default_rate', e.target.value)} /></FormRow>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='prod_active' checked={form.is_active} onChange={e => setF('is_active', e.target.checked)} style={{ width: '14px', height: '14px' }} />
            <label htmlFor='prod_active' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>Active</label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>

      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Products' width={540}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('products')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>name,hsn_code,gst_rate,unit,default_rate,description,category</code><br />
            Upserts on <code>name</code> — existing products will be updated. If a name or description contains a comma, wrap that field in double quotes, e.g. <code>"Steel Tea, Coffee &amp; Sugar Container Set, 3 Pieces"</code>.
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
          </FormRow>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={8}
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.added} products upserted.</strong>
              {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Deactivate Product' message={`Deactivate "${confirmDelete?.name}"?`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Stock Shell ──────────────────────────────────────────────────────────────
export default function Stock() {
  const [tab, setTab] = useState('Stock Position')
  return (
    <div>
      <PageHeader title='Stock' subtitle='Actual stock, opening stock and planned position' />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `2px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontWeight: tab === t ? 700 : 500, fontSize: '13px',
            color: tab === t ? C.text : C.textSoft, background: 'transparent',
            borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: '-2px', transition: 'all 0.15s',
          }}>{t}</button>
        ))}
      </div>
      {tab === 'Stock Position' && <StockPosition />}
      {tab === 'Opening Stock'  && <OpeningStock />}
      {tab === 'Adjustments'    && <StockAdjustments />}
      {tab === 'Products'       && <Products />}
    </div>
  )
}
