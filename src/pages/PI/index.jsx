import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today, fyOptions } from '../../utils/dates'
import { buildHSNMap } from '../../utils/hsn'
import DocumentAttachments from '../../components/DocumentAttachments'
import { downloadTemplate } from '../../utils/csvTemplate'

const PI_STATUSES = ['draft', 'sent', 'accepted', 'converted', 'cancelled']

const EMPTY_FORM = {
  pi_date: today(), valid_upto: '', status: 'draft',
  from_entity_id: '', to_entity_id: '',
  order_id: '', order_leg_id: '',
  is_interstate: false, notes: '',
}

// ─── PI List ──────────────────────────────────────────────────────────────────
function PIList() {
  const navigate = useNavigate()
  const [pis, setPIs]           = useState([])
  const [entities, setEntities] = useState([])
  const [orders, setOrders]     = useState([])
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

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ps }, { data: es }, { data: os }, { data: hsnRows }] = await Promise.all([
      supabase.from('proforma_invoices')
        .select('*, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('hsn_master').select('*').eq('is_active', true),
    ])
    setPIs(ps || [])
    setEntities(es || [])
    setOrders(os || [])
    setHsnMap(buildHSNMap(hsnRows || []))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

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

  async function handleSave() {
    if (!form.from_entity_id || !form.to_entity_id) return setToast({ message: 'From and To entity are required', type: 'error' })
    const totals = computeTotals(piLines.map(l => computeLine(l, form.is_interstate)))
    setSaving(true)
    const payload = {
      ...form,
      ...totals,
      outstanding_amount: totals.total_amount,
    }
    if (!payload.order_id)      delete payload.order_id
    if (!payload.order_leg_id)  delete payload.order_leg_id
    if (!payload.valid_upto)    delete payload.valid_upto

    const { data: pi, error: piErr } = await supabase.from('proforma_invoices').insert(payload).select().single()
    if (piErr) { setSaving(false); return setToast({ message: piErr.message, type: 'error' }) }

    if (piLines.length > 0) {
      const linesPayload = piLines.map((l, i) => ({
        ...computeLine(l, form.is_interstate),
        pi_id: pi.id, line_no: i + 1,
        _id: undefined,
      }))
      const { error: lErr } = await supabase.from('proforma_invoice_lines').insert(linesPayload)
      if (lErr) { setSaving(false); return setToast({ message: lErr.message, type: 'error' }) }
    }

    setSaving(false)
    setToast({ message: 'PI created', type: 'success' })
    setModalOpen(false)
    setPILines([])
    navigate(`/pi/${pi.id}`)
  }

  const filtered = pis.filter(p => {
    const ms  = !search || (p.pi_no || '').toLowerCase().includes(search.toLowerCase()) ||
      p.from_entity?.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.to_entity?.name?.toLowerCase().includes(search.toLowerCase())
    const mst = statusFilter === 'all' || p.status === statusFilter
    const me  = !entityFilter || p.from_entity_id === entityFilter || p.to_entity_id === entityFilter
    return ms && mst && me
  })

  // ── CSV bulk upload ──────────────────────────────────────────────────────────
  // Format: pi_date,from_entity,to_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,valid_upto,notes
  // Multiple rows with same pi_date+from+to = grouped into one PI
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const header = lines[0].split(',').map(h => h.trim().toLowerCase())
    let created = 0, errors = []

    // Group rows by pi_date+from_entity+to_entity
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.pi_date}__${row.from_entity}__${row.to_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }

    for (const [key, group] of Object.entries(groups)) {
      const { meta, lines: gLines } = group
      const fromE = entities.find(e => e.short_name?.toLowerCase() === meta.from_entity?.toLowerCase() || e.name?.toLowerCase() === meta.from_entity?.toLowerCase())
      const toE   = entities.find(e => e.short_name?.toLowerCase() === meta.to_entity?.toLowerCase()   || e.name?.toLowerCase() === meta.to_entity?.toLowerCase())
      if (!fromE) { errors.push(`Row group ${meta.from_entity}: entity not found`); continue }
      if (!toE)   { errors.push(`Row group ${meta.to_entity}: entity not found`);   continue }

      const interstate = meta.is_interstate === 'true' || (fromE.state_code && toE.state_code && fromE.state_code !== toE.state_code)

      const piLines = gLines.map((r, i) => {
        const rate    = toNum(r.rate)
        const qty     = toNum(r.qty)
        const taxable = Math.round(qty * rate)
        const gstRate = toNum(r.gst_rate) || 18
        const half    = gstRate / 2
        const igst    = interstate ? Math.round(taxable * gstRate / 100) : 0
        const cgst    = !interstate ? Math.round(taxable * half / 100) : 0
        const sgst    = cgst
        return {
          line_no: i + 1, description: r.description, hsn_code: r.hsn_code,
          qty, unit: r.unit || 'Nos', rate, gst_rate: gstRate,
          taxable_amount: taxable,
          cgst_rate: half, cgst_amount: cgst,
          sgst_rate: half, sgst_amount: sgst,
          igst_rate: interstate ? gstRate : 0, igst_amount: igst,
          total_amount: taxable + igst + cgst + sgst,
        }
      })

      const totals = piLines.reduce((acc, l) => ({
        taxable_amount: acc.taxable_amount + l.taxable_amount,
        cgst_amount:    acc.cgst_amount    + l.cgst_amount,
        sgst_amount:    acc.sgst_amount    + l.sgst_amount,
        igst_amount:    acc.igst_amount    + l.igst_amount,
        total_amount:   acc.total_amount   + l.total_amount,
      }), { taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_amount: 0 })

      const { data: pi, error: piErr } = await supabase.from('proforma_invoices').insert({
        pi_date: meta.pi_date, from_entity_id: fromE.id, to_entity_id: toE.id,
        is_interstate: interstate, valid_upto: meta.valid_upto || null,
        notes: meta.notes || null, status: 'draft', ...totals,
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

  const columns = [
    { label: 'PI No', render: p => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{p.pi_no || '—'}</span> },
    { label: 'From → To', render: p => <span style={{ fontSize: '12px' }}>{p.from_entity?.short_name || p.from_entity?.name} → {p.to_entity?.short_name || p.to_entity?.name}</span> },
    { label: 'Date',   render: p => <span style={{ fontSize: '12px' }}>{fmtDate(p.pi_date)}</span> },
    { label: 'Order',  render: p => <span style={{ fontSize: '12px', color: C.textSoft }}>{p.orders?.name || '—'}</span> },
    { label: 'Tax',    render: p => <Badge status={p.is_interstate ? 'export' : 'domestic'} label={p.is_interstate ? 'IGST' : 'CGST+SGST'} /> },
    { label: 'Amount', right: true, render: p => <span style={{ fontWeight: 600 }}>{formatINR(p.total_amount)}</span> },
    { label: 'Status', render: p => <Badge status={p.status} /> },
  ]

  return (
    <div>
      <PageHeader
        title='Proforma Invoices'
        subtitle='Draft invoices raised before goods move'
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
            <Btn onClick={() => { setForm(EMPTY_FORM); setPILines([]); setModalOpen(true) }}>+ New PI</Btn>
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
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={p => navigate(`/pi/${p.id}`)}
              emptyState={<EmptyState icon='📄' title='No PIs yet' action={<Btn onClick={() => setModalOpen(true)}>+ New PI</Btn>} />} />
        }
      </Card>

      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Proforma Invoices' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('pi')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>pi_date,from_entity,to_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,valid_upto,notes</code><br /><br />
            Multiple rows with the same <strong>pi_date + from_entity + to_entity</strong> are grouped into one PI automatically.
          </div>
          <FormRow label='Paste CSV'>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          </FormRow>
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

      {/* New PI Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Proforma Invoice' width={900}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SectionDivider label='Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
            <FormRow label='PI Date' required>
              <Input type='date' value={form.pi_date} onChange={e => setF('pi_date', e.target.value)} />
            </FormRow>
            <FormRow label='Valid Upto'>
              <Input type='date' value={form.valid_upto} onChange={e => setF('valid_upto', e.target.value)} />
            </FormRow>
            <FormRow label='Status'>
              <Select value={form.status} onChange={e => setF('status', e.target.value)}>
                {PI_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </FormRow>
            <FormRow label='From Entity' required>
              <Select value={form.from_entity_id} onChange={e => setF('from_entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
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
                <option value='0'>Intrastate (CGST + SGST)</option>
                <option value='1'>Interstate (IGST)</option>
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
          <LineItemsEditor lines={piLines} setLines={setPILines} interstate={form.is_interstate} hsnMap={hsnMap} />

          <FormRow label='Notes'>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create PI'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── PI Detail ────────────────────────────────────────────────────────────────
function PIDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [pi, setPI]     = useState(null)
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: ls }] = await Promise.all([
      supabase.from('proforma_invoices')
        .select('*, from_entity:from_entity_id(name,short_name,gstin,state_code,address,city), to_entity:to_entity_id(name,short_name,gstin,state_code,address,city), orders(name), order_legs(leg_no)')
        .eq('id', id).single(),
      supabase.from('proforma_invoice_lines').select('*').eq('pi_id', id).order('line_no'),
    ])
    setPI(p)
    setLines(ls || [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function updateStatus(status) {
    await supabase.from('proforma_invoices').update({ status, updated_at: new Date() }).eq('id', id)
    setToast({ message: `PI marked as ${status}`, type: 'success' })
    load()
  }

  async function convertToInvoice() {
    // Navigate to create invoice with PI pre-filled
    navigate(`/invoices/new?from_pi=${id}`)
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!pi)     return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>PI not found.</div>

  const canConvert = ['accepted', 'sent', 'draft'].includes(pi.status)

  return (
    <div>
      <button onClick={() => navigate('/pi')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>← Proforma Invoices</button>

      <PageHeader
        title={pi.pi_no || `PI — ${fmtDate(pi.pi_date)}`}
        subtitle={`${pi.from_entity?.name} → ${pi.to_entity?.name} · ${fmtDate(pi.pi_date)}`}
        action={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {pi.status === 'draft'    && <Btn size='sm' variant='ghost' onClick={() => updateStatus('sent')}>Mark Sent</Btn>}
            {pi.status === 'sent'     && <Btn size='sm' variant='ghost' onClick={() => updateStatus('accepted')}>Mark Accepted</Btn>}
            {canConvert && pi.status !== 'cancelled' && <Btn size='sm' onClick={convertToInvoice}>Convert to Invoice</Btn>}
            {!['cancelled', 'converted'].includes(pi.status) && <Btn size='sm' variant='ghost' onClick={() => setConfirmCancel(true)} style={{ color: C.danger }}>Cancel PI</Btn>}
            <Badge status={pi.status} />
          </div>
        }
      />

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
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={pi.is_interstate ? 'export' : 'domestic'} label={pi.is_interstate ? 'IGST' : 'CGST+SGST'} /></div>
        {pi.orders?.name && <div><span style={{ color: C.textMuted }}>Order:</span> <strong>{pi.orders.name}</strong></div>}
      </div>

      <Card style={{ marginBottom: '16px' }}>
        <LineItemsEditor lines={lines.map(l => ({ ...l, _id: l.id }))} setLines={() => {}} interstate={pi.is_interstate} readOnly />
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
          entityName={pi.from_entity?.name || 'General'}
        />
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel PI' message='Cancel this proforma invoice? This action cannot be undone.' danger />

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
