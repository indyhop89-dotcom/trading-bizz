import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { downloadTemplate } from '../../utils/csvTemplate'

const UNITS = ['Nos', 'Kg', 'Pcs', 'Box', 'Mtr', 'Ltr', 'Set']
const TABS  = ['Opening Stock', 'Stock Position', 'Products']

// ─── helpers ──────────────────────────────────────────────────────────────────
function shortfallBadge(planned) {
  if (planned < 0) return <span style={{ fontSize: '11px', fontWeight: 700, background: '#f0e8e8', color: '#8a2020', padding: '2px 8px', borderRadius: '4px' }}>⚠ Shortfall</span>
  if (planned === 0) return <span style={{ fontSize: '11px', fontWeight: 700, background: '#fff3cc', color: '#7a5000', padding: '2px 8px', borderRadius: '4px' }}>Zero</span>
  return <span style={{ fontSize: '11px', fontWeight: 700, background: '#e8f3ec', color: '#1a5c30', padding: '2px 8px', borderRadius: '4px' }}>OK</span>
}

// ─── Opening Stock Tab ────────────────────────────────────────────────────────
const EMPTY_OPENING = {
  entity_id: '', product_id: '', financial_year_id: '',
  qty: '', rate: '', hsn_code: '', gst_rate: '',
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

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: rs }, { data: es }, { data: ps }, { data: fyData }] = await Promise.all([
      supabase.from('stock_opening_balance')
        .select('*, entity:entity_id(name,short_name), product:product_id(name,hsn_code,unit), fy:financial_year_id(name)')
        .order('created_at', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('products').select('id,name,hsn_code,gst_rate,unit,default_rate').eq('is_active', true).order('name'),
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
        if (p) { u.hsn_code = p.hsn_code || ''; u.gst_rate = p.gst_rate != null ? String(p.gst_rate) : ''; u.rate = p.default_rate != null ? String(p.default_rate) : '' }
      }
      return u
    })
  }

  function openNew()   { setEditing(null); setForm(EMPTY_OPENING); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({ entity_id: r.entity_id||'', product_id: r.product_id||'', financial_year_id: r.financial_year_id||'', qty: r.qty!=null?String(r.qty):'', rate: r.rate!=null?String(r.rate):'', hsn_code: r.hsn_code||'', gst_rate: r.gst_rate!=null?String(r.gst_rate):'', as_of_date: r.as_of_date||today(), notes: r.notes||'' })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.entity_id || !form.product_id || !form.financial_year_id)
      return setToast({ message: 'Entity, Product and FY are required', type: 'error' })
    setSaving(true)
    const payload = { entity_id: form.entity_id, product_id: form.product_id, financial_year_id: form.financial_year_id, qty: toNum(form.qty), rate: toNum(form.rate), hsn_code: form.hsn_code||null, gst_rate: toNum(form.gst_rate)||null, as_of_date: form.as_of_date, notes: form.notes||null }
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

  // CSV: entity_short_name,product_name,fy_name,qty,rate,as_of_date
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'CSV needs header + data rows', type: 'error' }) }
    const header = lines[0].split(',').map(h => h.trim().toLowerCase())
    let added = 0, errors = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const entity = entities.find(e => e.short_name?.toLowerCase() === row.entity?.toLowerCase() || e.name?.toLowerCase() === row.entity?.toLowerCase())
      const product = products.find(p => p.name?.toLowerCase() === row.product?.toLowerCase())
      const fy     = fys.find(f => f.name?.toLowerCase() === row.fy?.toLowerCase())
      if (!entity)  { errors.push(`Row ${i+1}: entity "${row.entity}" not found`); continue }
      if (!product) { errors.push(`Row ${i+1}: product "${row.product}" not found`); continue }
      if (!fy)      { errors.push(`Row ${i+1}: FY "${row.fy}" not found`); continue }
      const { error } = await supabase.from('stock_opening_balance').upsert({
        entity_id: entity.id, product_id: product.id, financial_year_id: fy.id,
        qty: toNum(row.qty), rate: toNum(row.rate),
        as_of_date: row.as_of_date || today(),
      }, { onConflict: 'entity_id,product_id,financial_year_id' })
      if (error) errors.push(`Row ${i+1}: ${error.message}`)
      else added++
    }
    setCsvSaving(false)
    setCsvResult({ added, errors })
    load()
  }

  const filtered = rows.filter(r => !entityFilter || r.entity_id === entityFilter)

  const columns = [
    { label: 'Entity',   render: r => <span style={{ fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name}</span> },
    { label: 'Product',  render: r => <div><div style={{ fontWeight: 600 }}>{r.product?.name}</div><div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>{r.hsn_code || r.product?.hsn_code}</div></div> },
    { label: 'FY',       render: r => <span style={{ fontSize: '12px', color: C.textSoft }}>{r.fy?.name}</span> },
    { label: 'Qty',      right: true, render: r => <span style={{ fontWeight: 600 }}>{Number(r.qty).toLocaleString('en-IN')} {r.product?.unit}</span> },
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
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>entity,product,fy,qty,rate,as_of_date</code><br />
            <strong>Example:</strong><br />
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>Siddi,T-Shirt Basic,FY 2025-26,1000,250,2025-04-01</code><br />
            Entity = short name or full name. FY = exact name from Settings.
          </div>
          <FormRow label='Paste CSV'>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={8}
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          </FormRow>
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.added} rows added.</strong>
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
  const [entityFilter, setEntityFilter] = useState('')
  const [fyFilter, setFyFilter]         = useState('')
  const [loading, setLoading]   = useState(false)

  useEffect(() => {
    Promise.all([
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('financial_years').select('*').order('start_date', { ascending: false }),
    ]).then(([{ data: es }, { data: fyData }]) => {
      setEntities(es || [])
      setFys(fyData || [])
      if (fyData?.length) setFyFilter(fyData[0].id)
    })
  }, [])

  const loadPosition = useCallback(async () => {
    if (!fyFilter) return
    setLoading(true)

    // Get opening stock
    let q = supabase.from('stock_opening_balance')
      .select('*, entity:entity_id(name,short_name), product:product_id(name,hsn_code,unit)')
      .eq('financial_year_id', fyFilter)
    if (entityFilter) q = q.eq('entity_id', entityFilter)
    const { data: opening } = await q

    // Get PIs — incoming and outgoing per entity+product
    // We need proforma_invoice_lines joined with proforma_invoices
    // Planned stock = opening + incoming PI qty - outgoing PI qty
    const { data: piLines } = await supabase
      .from('proforma_invoice_lines')
      .select('qty, product_id, pi:pi_id(from_entity_id, to_entity_id, status)')
      .not('pi', 'is', null)
      .neq('pi.status', 'cancelled')

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

    // Compute planned qty
    const rows = Object.values(map).map(r => ({
      ...r,
      planned_qty: r.opening_qty + r.incoming - r.outgoing,
    }))

    setPosition(rows)
    setLoading(false)
  }, [entityFilter, fyFilter])

  useEffect(() => { loadPosition() }, [loadPosition])

  const shortfallCount = position.filter(r => r.planned_qty < 0).length
  const totalValue     = position.reduce((s, r) => s + toNum(r.opening_qty) * toNum(r.rate), 0)

  const columns = [
    { label: 'Entity',   render: r => <span style={{ fontWeight: 600 }}>{r.entity?.short_name || r.entity?.name}</span> },
    { label: 'Product',  render: r => <div><div style={{ fontWeight: 600 }}>{r.product?.name}</div><div style={{ fontSize: '11px', color: C.textMuted, fontFamily: 'monospace' }}>{r.product?.hsn_code}</div></div> },
    { label: 'Unit',     render: r => <span style={{ fontSize: '12px' }}>{r.product?.unit}</span> },
    { label: 'Opening',  right: true, render: r => <span>{Number(r.opening_qty).toLocaleString('en-IN')}</span> },
    { label: '+ Incoming PI', right: true, render: r => <span style={{ color: C.success }}>+{Number(r.incoming).toLocaleString('en-IN')}</span> },
    { label: '− Outgoing PI', right: true, render: r => <span style={{ color: C.danger }}>−{Number(r.outgoing).toLocaleString('en-IN')}</span> },
    { label: 'Planned',  right: true, render: r => (
      <span style={{ fontWeight: 700, color: r.planned_qty < 0 ? C.danger : r.planned_qty === 0 ? C.warning : C.success }}>
        {Number(r.planned_qty).toLocaleString('en-IN')}
      </span>
    )},
    { label: 'Status',   render: r => shortfallBadge(r.planned_qty) },
  ]

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Shortfalls'    value={shortfallCount} color={shortfallCount > 0 ? C.danger : C.success} />
        <StatCard label='Products'      value={position.length} />
        <StatCard label='Opening Value' value={formatINR(totalValue)} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={fyFilter} onChange={e => setFyFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          {fys.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value=''>All entities</option>
          {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
        </select>
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Calculating stock position…</div>
          : <Table columns={columns} rows={position}
              emptyState={<EmptyState icon='📦' title='No stock data' message='Add opening stock first, then create PIs to see planned position.' />}
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
    setForm({ name: r.name||'', description: r.description||'', hsn_code: r.hsn_code||'', gst_rate: r.gst_rate!=null?String(r.gst_rate):'18', unit: r.unit||'Nos', default_rate: r.default_rate!=null?String(r.default_rate):'', is_active: r.is_active!==false })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim() || !form.hsn_code.trim())
      return setToast({ message: 'Name and HSN Code are required', type: 'error' })
    setSaving(true)
    const payload = { name: form.name.trim(), description: form.description||null, hsn_code: form.hsn_code.trim(), gst_rate: toNum(form.gst_rate), unit: form.unit, default_rate: toNum(form.default_rate)||null, is_active: form.is_active, updated_at: new Date() }
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

  // CSV: name,hsn_code,gst_rate,unit,default_rate,description
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data', type: 'error' }) }
    const header = lines[0].split(',').map(h => h.trim().toLowerCase())
    let added = 0, errors = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      if (!row.name || !row.hsn_code) { errors.push(`Row ${i+1}: name and hsn_code required`); continue }
      const { error } = await supabase.from('products').upsert({
        name: row.name, hsn_code: row.hsn_code, gst_rate: toNum(row.gst_rate)||18,
        unit: row.unit||'Nos', default_rate: toNum(row.default_rate)||null,
        description: row.description||null, is_active: true, updated_at: new Date(),
      }, { onConflict: 'name' })
      if (error) errors.push(`Row ${i+1}: ${error.message}`)
      else added++
    }
    setCsvSaving(false)
    setCsvResult({ added, errors })
    load()
  }

  const filtered = products.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.hsn_code.includes(search))

  const columns = [
    { label: 'Name',      render: p => <div><div style={{ fontWeight: 600 }}>{p.name}</div>{p.description && <div style={{ fontSize: '11px', color: C.textMuted }}>{p.description}</div>}</div> },
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
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>name,hsn_code,gst_rate,unit,default_rate,description</code><br />
            Upserts on <code>name</code> — existing products will be updated.
          </div>
          <FormRow label='Paste CSV'>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={8}
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          </FormRow>
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
      <PageHeader title='Stock' subtitle='Products, opening stock and planned position' />
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
