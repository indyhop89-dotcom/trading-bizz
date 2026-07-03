import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, CsvFileDrop,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today, currentFYLabel, parseFlexibleDate } from '../../utils/dates'
import { buildHSNMap } from '../../utils/hsn'
import DocumentAttachments from '../../components/DocumentAttachments'
import { downloadTemplate, downloadCSV, detectDelimiter } from '../../utils/csvTemplate'

const PO_STATUSES = ['open', 'partial', 'completed', 'cancelled']

const EMPTY_FORM = {
  po_date: today(), delivery_date: '', status: 'open',
  buyer_entity_id: '', seller_entity_id: '',
  order_id: '', order_leg_id: '', pi_id: '',
  is_interstate: false, notes: '',
  bill_from: '', bill_to: '', ship_from: '', ship_to: '',
  po_no: '', // CHANGED: optional manual PO number — blank auto-generates via next_po_no()
}


// Resolve current FY — next_po_no takes (ent_id, fy_id)
async function resolveFY() {
  const label = currentFYLabel()
  const { data } = await supabase.from('financial_years').select('id,name,code').order('start_date',{ascending:false}).limit(5)
  return (data||[]).find(f=>f.name===label)||data?.[0]
}

// ─── PO List ──────────────────────────────────────────────────────────────────
function POList() {
  const navigate = useNavigate()
  const [pos, setPOs]       = useState([])
  const [entities, setEntities] = useState([])
  const [orders, setOrders] = useState([])
  const [pis, setPIs]       = useState([])
  const [hsnMap, setHsnMap] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]     = useState(EMPTY_FORM)
  const [legs, setLegs]     = useState([])
  const [poLines, setPOLines] = useState([])
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
    const [{ data: ps }, { data: es }, { data: os }, { data: piData }, { data: hsnRows }] = await Promise.all([
      supabase.from('purchase_orders')
        .select('*, buyer:buyer_entity_id(name,short_name), seller:seller_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).order('po_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('proforma_invoices').select('id,pi_no,from_entity_id,to_entity_id').eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('hsn_master').select('*').eq('is_active', true),
    ])
    setPOs(ps || [])
    setEntities(es || [])
    setOrders(os || [])
    setPIs(piData || [])
    setHsnMap(buildHSNMap(hsnRows || []))
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
      if (k === 'pi_id' && v) {
        const pi = pis.find(p => p.id === v)
        if (pi) {
          if (!updated.seller_entity_id) updated.seller_entity_id = pi.from_entity_id
          if (!updated.buyer_entity_id)  updated.buyer_entity_id  = pi.to_entity_id
        }
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

  async function handleSave() {
    if (!form.buyer_entity_id || !form.seller_entity_id) return setToast({ message: 'Buyer and Seller are required', type: 'error' })
    const totals = computeTotals(poLines.map(l => computeLine(l, form.is_interstate)))
    setSaving(true)
    const fy = await resolveFY()
    if (!fy) { setSaving(false); return setToast({ message: 'No financial year found', type: 'error' }) }
    // CHANGED: use the manually-entered PO number if supplied, else auto-generate.
    let poNo = (form.po_no || '').trim()
    if (poNo) {
      const dup = pos.find(p => p.po_no?.toLowerCase() === poNo.toLowerCase())
      if (dup) { setSaving(false); return setToast({ message: `PO number "${poNo}" is already in use`, type: 'error' }) }
    } else {
      const { data: generated, error: noErr } = await supabase.rpc('next_po_no', { ent_id: form.buyer_entity_id, fy_id: fy.id })
      if (noErr) { setSaving(false); return setToast({ message: 'Could not generate PO number: '+noErr.message, type: 'error' }) }
      poNo = generated
    }
    const payload = { ...form, ...totals, po_no: poNo, financial_year_id: fy.id }
    if (!payload.order_id)     delete payload.order_id
    if (!payload.order_leg_id) delete payload.order_leg_id
    if (!payload.pi_id)        delete payload.pi_id
    if (!payload.delivery_date) delete payload.delivery_date

    const { data: po, error } = await supabase.from('purchase_orders').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }

    if (poLines.length > 0) {
      const linesPayload = poLines.map((l, i) => ({
        ...computeLine(l, form.is_interstate),
        po_id: po.id, line_no: i + 1,
        _id: undefined,
      }))
      await supabase.from('purchase_order_lines').insert(linesPayload)
    }

    setSaving(false)
    setToast({ message: 'PO created', type: 'success' })
    setModalOpen(false)
    setPOLines([])
    navigate(`/po/${po.id}`)
  }

  // ── CSV handler ───────────────────────────────────────────────────────────────
  // Format: po_date,buyer_entity,seller_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,delivery_date,notes,po_no
  // CHANGED: po_no is optional — blank = auto-generated via next_po_no(); if
  // supplied, used as-is after a duplicate check (existing POs + this file).
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    const header = lines[0].split(delim).map(h => h.trim().toLowerCase())
    let created = 0, errors = []
    const usedPoNos = new Set(pos.map(p => p.po_no?.toLowerCase()).filter(Boolean))
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim).map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.po_date}__${row.buyer_entity}__${row.seller_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }
    for (const [key, group] of Object.entries(groups)) {
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

      // CHANGED: po_no and financial_year_id are NOT NULL with no DB default —
      // financial_year_id is always resolved; po_no is taken from the CSV if
      // supplied, otherwise generated via next_po_no() (same as manual create).
      const fy = await resolveFY()
      if (!fy) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: no financial year found`); continue }
      let poNo = (meta.po_no || '').trim()
      if (poNo) {
        if (usedPoNos.has(poNo.toLowerCase())) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: PO number "${poNo}" is already in use`); continue }
      } else {
        const { data: generated, error: noErr } = await supabase.rpc('next_po_no', { ent_id: buyerE.id, fy_id: fy.id })
        if (noErr) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: could not generate PO number — ${noErr.message}`); continue }
        poNo = generated
      }
      usedPoNos.add(poNo.toLowerCase())

      const interstate = meta.is_interstate === 'true' || (buyerE.state_code && sellerE.state_code && buyerE.state_code !== sellerE.state_code)
      const poLines = gLines.map((r, i) => {
        const rate = toNum(r.rate); const qty = toNum(r.qty); const taxable = Math.round(qty * rate)
        const gstRate = toNum(r.gst_rate) || 18; const half = gstRate / 2
        const igst = interstate ? Math.round(taxable * gstRate / 100) : 0
        const cgst = !interstate ? Math.round(taxable * half / 100) : 0
        return { line_no: i+1, description: r.description, hsn_code: r.hsn_code, qty, unit: r.unit||'Nos', rate, gst_rate: gstRate, taxable_amount: taxable, cgst_rate: half, cgst_amount: cgst, sgst_rate: half, sgst_amount: cgst, igst_rate: interstate?gstRate:0, igst_amount: igst, total_amount: taxable+igst+cgst+cgst }
      })
      const totals = poLines.reduce((acc, l) => ({ taxable_amount: acc.taxable_amount+l.taxable_amount, cgst_amount: acc.cgst_amount+l.cgst_amount, sgst_amount: acc.sgst_amount+l.sgst_amount, igst_amount: acc.igst_amount+l.igst_amount, total_amount: acc.total_amount+l.total_amount }), { taxable_amount:0,cgst_amount:0,sgst_amount:0,igst_amount:0,total_amount:0 })
      const { data: po, error: poErr } = await supabase.from('purchase_orders').insert({ po_date: poDate, buyer_entity_id: buyerE.id, seller_entity_id: sellerE.id, is_interstate: interstate, delivery_date: deliveryDate, notes: meta.notes||null, status: 'open', po_no: poNo, financial_year_id: fy.id, ...totals }).select().single()
      if (poErr) { errors.push(`PO ${meta.po_date}: ${poErr.message}`); continue }
      await supabase.from('purchase_order_lines').insert(poLines.map(l => ({ ...l, po_id: po.id })))
      created++
    }
    setCsvSaving(false); setCsvResult({ created, errors }); load()
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
    return ms && mst
  })

  const columns = [
    { label: 'S.No.',   render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    { label: 'PO No',   render: p => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{p.po_no || '—'}</span> },
    { label: 'Buyer',   render: p => <span style={{ fontSize: '12px' }}>{p.buyer?.short_name || p.buyer?.name}</span> },
    { label: 'Seller',  render: p => <span style={{ fontSize: '12px' }}>{p.seller?.short_name || p.seller?.name}</span> },
    { label: 'Date',    render: p => <span style={{ fontSize: '12px' }}>{fmtDate(p.po_date)}</span> },
    { label: 'Delivery',render: p => <span style={{ fontSize: '12px', color: C.textSoft }}>{p.delivery_date ? fmtDate(p.delivery_date) : '—'}</span> },
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
            <Btn onClick={() => { setForm(EMPTY_FORM); setPOLines([]); setModalOpen(true) }}>+ New PO</Btn>
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

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={p => navigate(`/po/${p.id}`)}
              emptyState={<EmptyState icon='📋' title='No purchase orders' action={<Btn onClick={() => setModalOpen(true)}>+ New PO</Btn>} />} />
        }
      </Card>

      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Purchase Orders' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('po')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>po_date,buyer_entity,seller_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,delivery_date,notes,po_no</code><br /><br />
            Multiple rows with same <strong>po_date + buyer + seller</strong> are grouped into one PO. <code>po_no</code> is optional — leave it blank to auto-generate, or supply your own (checked against existing POs and other rows in this file).
          </div>
          <FormRow label='Upload or Paste CSV'>
            <CsvFileDrop onText={setCsvText} />
          </FormRow>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              <strong>{csvResult.created} POs created.</strong>
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
          <div style={{background:'#e8f3ec',border:'1px solid #b8dfca',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',color:'#1a5c30'}}>📅 Will be created under <strong>{currentFYLabel()}</strong></div>
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
              <Select value={form.pi_id} onChange={e => setF('pi_id', e.target.value)}>
                <option value=''>No PI linked</option>
                {pis.map(p => <option key={p.id} value={p.id}>{p.pi_no || p.id.slice(0, 8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Buyer Entity' required>
              <Select value={form.buyer_entity_id} onChange={e => setF('buyer_entity_id', e.target.value)}>
                <option value=''>Select buyer</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
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
              <Select value={form.order_leg_id} onChange={e => setF('order_leg_id', e.target.value)} disabled={!form.order_id}>
                <option value=''>Select leg</option>
                {legs.map(l => <option key={l.id} value={l.id}>Leg {l.leg_no}: {l.from_entity?.short_name || l.from_entity?.name} → {l.to_entity?.short_name || l.to_entity?.name}</option>)}
              </Select>
            </FormRow>
          </div>
          <SectionDivider label='Line Items' />
          <LineItemsEditor lines={poLines} setLines={setPOLines} interstate={form.is_interstate} hsnMap={hsnMap} />
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
  const [po, setPO]     = useState(null)
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: ls }] = await Promise.all([
      supabase.from('purchase_orders')
        .select('*, buyer:buyer_entity_id(name,short_name,gstin,city), seller:seller_entity_id(name,short_name,gstin,city), orders(name)')
        .eq('id', id).single(),
      supabase.from('purchase_order_lines').select('*').eq('po_id', id).order('line_no'),
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
            {po.status === 'open' && <Btn size='sm' variant='ghost' onClick={() => updateStatus('completed')}>Mark Completed</Btn>}
            {!['cancelled','completed'].includes(po.status) && <Btn size='sm' variant='ghost' onClick={() => setConfirmCancel(true)} style={{ color: C.danger }}>Cancel</Btn>}
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
