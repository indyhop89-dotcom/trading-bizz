import { useState, useEffect, useCallback, Fragment } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard, CsvFileDrop,
} from '../../components/UI/index'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { downloadTemplate, downloadCSV, detectDelimiter, parseCSVLine } from '../../utils/csvTemplate'
// CHANGED: reuse the existing, tested actual-stock logic (already powers
// LineItemsEditor's stockMap) instead of duplicating it here.
import { fetchStockMovementData, buildActualStockMap } from '../../utils/stock'
import { cleanProductName, productMatchKey } from '../../utils/products'
// CHANGED: needed to know the current user's role/id for entity-access scoping
import { useAuth } from '../../hooks/useAuth'
import { fetchAllPages } from '../../utils/query'

const UNITS = ['Nos', 'Kg', 'Pcs', 'Box', 'Mtr', 'Ltr', 'Set']
const TABS  = ['Opening Stock', 'Stock Position', 'Products']
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
    for (const p of parsed) {
      const k = rowMatchKey(p.row)
      if (productMap.has(k) || missingRowKeys.has(k)) continue
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

    setCsvResult({ totalDataRows, added, skipped: skippedItems.length, productsCreated, errors, addedItems, skippedItems, createdProductNames })
    setCsvProgress('')
    await load()
    setCsvSaving(false)
  }

  const filtered = rows.filter(r => !entityFilter || r.entity_id === entityFilter)

  const totalValue = filtered.reduce((s, r) => s + toNum(r.qty) * toNum(r.rate), 0)
  const qtyByUnit = filtered.reduce((m, r) => {
    const u = r.unit || r.product?.unit || 'Nos'
    m[u] = (m[u] || 0) + toNum(r.qty)
    return m
  }, {})
  const qtySummary = Object.entries(qtyByUnit).map(([u, q]) => `${q.toLocaleString('en-IN')} ${u}`).join(' • ') || '0'
  const distinctProducts = new Set(filtered.map(r => r.product_id)).size

  const columns = [
    { label: 'S.No.',    render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Entity',   render: r => <span style={{ fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name}</span> },
    { label: 'Product',  render: r => <div><div style={{ fontWeight: 600 }}>{r.product?.name}</div><div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>{r.hsn_code || r.product?.hsn_code}</div></div> },
    { label: 'FY',       render: r => <span style={{ fontSize: '12px', color: C.textSoft }}>{r.fy?.name}</span> },
    { label: 'Qty',      right: true, render: r => <span style={{ fontWeight: 600 }}>{Number(r.qty).toLocaleString('en-IN')} {r.unit || r.product?.unit}</span> },
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
              <Select value={form.product_id} onChange={e => setF('product_id', e.target.value)}>
                <option value=''>Select product</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
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
  // CHANGED: category filter + group-by-category summary toggle
  const [categoryFilter, setCategoryFilter] = useState('')
  const [groupByCategory, setGroupByCategory] = useState(false)
  // CHANGED: click-to-filter from the Shortfalls / Billed Beyond Stock StatCards
  const [statusFilter, setStatusFilter] = useState(null) // null | 'shortfall' | 'billed_beyond'
  // CHANGED: tracks invoice lines with no product_id (known CSV-upload data
  // gap) so we can warn about them instead of showing blank garbage rows
  const [dataIssues, setDataIssues] = useState({ unresolvedLines: 0, unresolvedQty: 0 })
  const [expandedCategories, setExpandedCategories] = useState(() => new Set())
  function toggleCategory(cat) {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat); else next.add(cat)
      return next
    })
  }

  // CHANGED: current user's role/id decide which entities they may even see
  const { profile } = useAuth()
  const isMaster = profile?.role === 'master'

  useEffect(() => {
    if (!profile) return // wait until we know the role before deciding what to fetch
    async function loadFilters() {
      const [{ data: fyData }, { data: ps }] = await Promise.all([
        supabase.from('financial_years').select('*').order('start_date', { ascending: false }),
        // CHANGED: product lookup for actual-stock-only rows (see below)
        supabase.from('products').select('id,name,hsn_code,unit,category'),
      ])
      setFys(fyData || [])
      setProducts(ps || [])
      if (fyData?.length) setFyFilter(fyData[0].id)

      if (profile.role === 'master') {
        // Master sees every entity, "All entities" included — unchanged behaviour.
        const { data: es } = await supabase.from('entities')
          .select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name')
        setEntities(es || [])
        setEntityFilter('')
      } else {
        // CHANGED: everyone else only sees entities they've been explicitly
        // granted via user_entity_access. No "All entities" option for them —
        // the dropdown is built purely from their grants, and if they only
        // have one grant, it's frozen to that entity (see select below).
        const { data: grants } = await supabase
          .from('user_entity_access')
          .select('entity:entity_id(id,name,short_name)')
          .eq('user_id', profile.id)
        const granted = (grants || []).map(g => g.entity).filter(Boolean)
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        setEntities(granted)
        setEntityFilter(granted[0]?.id || '')
      }
    }
    loadFilters()
  }, [profile])

  const loadPosition = useCallback(async () => {
    if (!fyFilter) return
    setLoading(true)

    // Get opening stock
    let q = supabase.from('stock_opening_balance')
      .select('*, entity:entity_id(name,short_name), product:product_id(name,hsn_code,unit,category)')
      .eq('financial_year_id', fyFilter)
    if (entityFilter) q = q.eq('entity_id', entityFilter)
    const { data: opening } = await q

    // Get PIs — incoming and outgoing per entity+product
    // We need proforma_invoice_lines joined with proforma_invoices
    // Planned stock = opening + incoming PI qty - outgoing PI qty
    // NOTE: this Planned/PI logic is untouched — it's correct as-is.
    const { data: piLines } = await supabase
      .from('proforma_invoice_lines')
      .select('qty, product_id, pi:pi_id(from_entity_id, to_entity_id, status)')
      .not('pi', 'is', null)
      .neq('pi.status', 'cancelled')

    // CHANGED: Actual Stock — the real, invoice-based position per entity.
    // This is deliberately NOT scoped to fyFilter: opening stock is entered
    // incrementally whenever new stock is purchased (not reset each FY), so
    // actual stock must be a running total across all-time opening entries +
    // all-time invoice movements. Reuses the same tested logic that already
    // feeds LineItemsEditor's available-stock check.
    const actualMap = buildActualStockMap(await fetchStockMovementData())

    // Build position map: key = entity_id + product_id
    const map = {}
    for (const ob of (opening || [])) {
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
        map[key] = {
          entity_id:   row.entity_id,
          entity:      entityById[row.entity_id] || null,
          product_id:  row.product_id,
          product:     productById[row.product_id] || null,
          opening_qty: 0,
          incoming:    0,
          outgoing:    0,
          rate:        0,
        }
      }
    }
    setDataIssues({ unresolvedLines, unresolvedQty })

    // Compute planned qty (PI-based, unchanged) and actual qty (invoice-based)
    const rows = Object.values(map).map(r => {
      const key        = `${r.entity_id}__${r.product_id}`
      const actual_qty = actualMap[key] ? actualMap[key].actual_qty : r.opening_qty
      return {
        ...r,
        planned_qty: r.opening_qty + r.incoming - r.outgoing,
        actual_qty,
        billed_beyond_stock: actual_qty < 0,
      }
    })
    // CHANGED: hide rows with nothing to show — no opening, no PI movement, no
    // actual stock. These carry no information and just pad the table.
    .filter(r => !(r.opening_qty === 0 && r.incoming === 0 && r.outgoing === 0 && r.actual_qty === 0))

    setPosition(rows)
    setLoading(false)
  }, [entityFilter, fyFilter, entities, products])

  useEffect(() => { loadPosition() }, [loadPosition])

  // CHANGED: category filter applied client-side (product.category comes
  // through the join, not filterable server-side without a second query)
  const categories = [...new Set(position.map(r => r.product?.category).filter(Boolean))].sort()
  const categoryOnlyFiltered = categoryFilter
    ? position.filter(r => r.product?.category === categoryFilter)
    : position

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

  // CHANGED: category → totals + line items, for the group-by-category table
  const categoryGroupMap = {}
  for (const r of filteredPosition) {
    const cat = r.product?.category || 'Uncategorised'
    if (!categoryGroupMap[cat]) categoryGroupMap[cat] = { qty: 0, value: 0, items: [] }
    categoryGroupMap[cat].qty   += toNum(r.planned_qty)
    categoryGroupMap[cat].value += toNum(r.opening_qty) * toNum(r.rate)
    categoryGroupMap[cat].items.push(r)
  }
  const categoryRows = Object.entries(categoryGroupMap)
    .map(([cat, g]) => ({ cat, qty: g.qty, value: g.value, items: g.items }))
    .sort((a, b) => b.qty - a.qty)

  const totalValue     = filteredPosition.reduce((s, r) => s + toNum(r.opening_qty) * toNum(r.rate), 0)

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
    { label: 'Actual Stock', right: true, render: r => (
      <span style={{ fontWeight: 800, fontSize: '14px', color: r.actual_qty < 0 ? C.danger : C.text }}>
        {Number(r.actual_qty).toLocaleString('en-IN')}
      </span>
    )},
    { label: 'Opening',  right: true, render: r => <span style={{ color: C.textMuted }}>{Number(r.opening_qty).toLocaleString('en-IN')}</span> },
    { label: '+ Incoming PI', right: true, render: r => <span style={{ color: C.success }}>+{Number(r.incoming).toLocaleString('en-IN')}</span> },
    { label: '− Outgoing PI', right: true, render: r => <span style={{ color: C.danger }}>−{Number(r.outgoing).toLocaleString('en-IN')}</span> },
    { label: 'Planned',  right: true, render: r => (
      <span style={{ fontWeight: 700, color: r.planned_qty < 0 ? C.danger : r.planned_qty === 0 ? C.warning : C.success }}>
        {Number(r.planned_qty).toLocaleString('en-IN')}
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
    downloadCSV(`stock_position_${new Date().toISOString().split('T')[0]}.csv`,
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
          ⚠ {dataIssues.unresolvedLines} invoice line{dataIssues.unresolvedLines === 1 ? '' : 's'} (~{Number(dataIssues.unresolvedQty).toLocaleString('en-IN')} units) have no product linked and are excluded from the table below — likely from CSV-uploaded PIs/Invoices missing a product reference. This is a data issue, not a display bug; the actual stock numbers shown for real products are correct.
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
        {/* CHANGED: group-by-category summary toggle */}
        <Btn size='sm' variant={groupByCategory ? 'primary' : 'ghost'} onClick={() => setGroupByCategory(g => !g)}>
          {groupByCategory ? '✓ ' : ''}Group by category
        </Btn>
        <Btn size='sm' variant='ghost' onClick={handleExportCSV}>↓ Export CSV</Btn>
      </div>

      {/* CHANGED: category totals table — click a category row to expand its line items */}
      {groupByCategory && (
        <Card style={{ marginBottom: '16px', padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  {['', 'Category', 'Products', 'Total Qty', 'Opening Value'].map((h, i) => (
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
                {categoryRows.map(({ cat, qty, value, items }) => {
                  const open = expandedCategories.has(cat)
                  return (
                    <Fragment key={cat}>
                      <tr onClick={() => toggleCategory(cat)} style={{ cursor: 'pointer', background: C.surface }}>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, color: C.textMuted, width: '24px' }}>{open ? '▾' : '▸'}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{cat}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', color: C.textMid }}>{items.length}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontWeight: 700 }}>{qty.toLocaleString('en-IN')}</td>
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, textAlign: 'right' }}>{formatINR(value)}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} style={{ padding: 0, borderBottom: `1px solid ${C.border}`, background: C.bg }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                              <thead>
                                <tr>
                                  {['Entity', 'Product', 'HSN', 'Unit', 'Opening Qty', 'Rate', 'Value'].map((h, i) => (
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
                                    <td style={{ padding: '7px 12px 7px 32px' }}>{it.entity?.short_name || it.entity?.name}</td>
                                    <td style={{ padding: '7px 12px' }}>{it.product?.name}</td>
                                    <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.textMuted }}>{it.product?.hsn_code}</td>
                                    <td style={{ padding: '7px 12px' }}>{it.product?.unit}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right' }}>{Number(it.opening_qty).toLocaleString('en-IN')}</td>
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
      {tab === 'Products'       && <Products />}
    </div>
  )
}
