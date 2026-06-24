import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { buildHSNMap } from '../../utils/hsn'
import DocumentAttachments from '../../components/DocumentAttachments'
import { downloadTemplate } from '../../utils/csvTemplate'

const INV_STATUSES = ['draft', 'submitted', 'partial', 'paid', 'cancelled']
const TDS_SECTIONS = ['194C', '194H', '194I', '194J', '194Q', '206C']

const EMPTY_FORM = {
  invoice_date: today(), due_date: '', invoice_type: 'sales', status: 'draft',
  seller_entity_id: '', buyer_entity_id: '',
  order_id: '', order_leg_id: '', pi_id: '', po_id: '',
  is_interstate: false,
  einvoice_irn: '', einvoice_ack_no: '', einvoice_ack_date: '',
  tds_amount: 0, tcs_amount: 0,
  notes: '',
}

// ─── Invoice List ─────────────────────────────────────────────────────────────
function InvoiceList() {
  const navigate = useNavigate()
  const [invoices, setInvoices] = useState([])
  const [entities, setEntities] = useState([])
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

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: invs }, { data: es }] = await Promise.all([
      supabase.from('invoices')
        .select('*, seller:seller_entity_id(name,short_name), buyer:buyer_entity_id(name,short_name)')
        .eq('is_deleted', false).neq('invoice_type', 'intercompany')
        .order('invoice_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
    ])
    setInvoices(invs || [])
    setEntities(es || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const header = lines[0].split(',').map(h => h.trim().toLowerCase())
    let created = 0, errors = []
    const groups = {}
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      const key = `${row.invoice_date}__${row.seller_entity}__${row.buyer_entity}`
      if (!groups[key]) groups[key] = { meta: row, lines: [] }
      groups[key].lines.push(row)
    }
    for (const [key, group] of Object.entries(groups)) {
      const { meta, lines: gLines } = group
      const sellerE = entities.find(e => e.short_name?.toLowerCase() === meta.seller_entity?.toLowerCase() || e.name?.toLowerCase() === meta.seller_entity?.toLowerCase())
      const buyerE  = entities.find(e => e.short_name?.toLowerCase() === meta.buyer_entity?.toLowerCase()  || e.name?.toLowerCase() === meta.buyer_entity?.toLowerCase())
      if (!sellerE) { errors.push(`Seller "${meta.seller_entity}" not found`); continue }
      if (!buyerE)  { errors.push(`Buyer "${meta.buyer_entity}" not found`); continue }
      const interstate = meta.is_interstate === 'true' || (sellerE.state_code && buyerE.state_code && sellerE.state_code !== buyerE.state_code)
      const invLines = gLines.map((r, i) => {
        const rate = toNum(r.rate); const qty = toNum(r.qty); const taxable = Math.round(qty * rate)
        const gstRate = toNum(r.gst_rate) || 18; const half = gstRate / 2
        const igst = interstate ? Math.round(taxable * gstRate / 100) : 0
        const cgst = !interstate ? Math.round(taxable * half / 100) : 0
        return { line_no: i+1, description: r.description, hsn_code: r.hsn_code, qty, unit: r.unit||'Nos', rate, gst_rate: gstRate, taxable_amount: taxable, cgst_rate: half, cgst_amount: cgst, sgst_rate: half, sgst_amount: cgst, igst_rate: interstate?gstRate:0, igst_amount: igst, total_amount: taxable+igst+cgst+cgst }
      })
      const totals = invLines.reduce((acc, l) => ({ taxable_amount: acc.taxable_amount+l.taxable_amount, cgst_amount: acc.cgst_amount+l.cgst_amount, sgst_amount: acc.sgst_amount+l.sgst_amount, igst_amount: acc.igst_amount+l.igst_amount, total_amount: acc.total_amount+l.total_amount }), { taxable_amount:0,cgst_amount:0,sgst_amount:0,igst_amount:0,total_amount:0 })
      const { data: inv, error: invErr } = await supabase.from('invoices').insert({ invoice_date: meta.invoice_date, invoice_type: meta.invoice_type||'sales', seller_entity_id: sellerE.id, buyer_entity_id: buyerE.id, is_interstate: interstate, due_date: meta.due_date||null, notes: meta.notes||null, status: 'draft', outstanding_amount: totals.total_amount, paid_amount: 0, ...totals }).select().single()
      if (invErr) { errors.push(`Invoice ${meta.invoice_date}: ${invErr.message}`); continue }
      await supabase.from('invoice_lines').insert(invLines.map(l => ({ ...l, invoice_id: inv.id })))
      created++
    }
    setCsvSaving(false); setCsvResult({ created, errors }); load()
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

  const columns = [
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
    { label: 'Amount',  right: true, render: i => <span style={{ fontWeight: 600 }}>{formatINR(i.total_amount)}</span> },
    { label: 'Outstanding', right: true, render: i => <span style={{ fontWeight: 600, color: i.outstanding_amount > 0 ? C.warning : C.success }}>{formatINR(i.outstanding_amount)}</span> },
    { label: 'Status',  render: i => <Badge status={i.status} /> },
  ]

  return (
    <div>
      <PageHeader
        title='Invoices'
        subtitle='Tax invoices — sales and purchases'
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
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
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={i => navigate(`/invoices/${i.id}`)}
              emptyState={<EmptyState icon='🧾' title='No invoices' action={<Btn onClick={() => navigate('/invoices/new')}>+ New Invoice</Btn>} />} />
        }
      </Card>

      {/* CSV Upload Modal */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload Invoices' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format — one row per line item:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('invoices')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>invoice_date,invoice_type,seller_entity,buyer_entity,is_interstate,description,hsn_code,qty,unit,rate,gst_rate,due_date,notes</code><br /><br />
            Multiple rows with same <strong>invoice_date + seller + buyer</strong> are grouped into one Invoice.
          </div>
          <FormRow label='Paste CSV'>
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

  const [entities, setEntities] = useState([])
  const [orders, setOrders]     = useState([])
  const [pis, setPIs]           = useState([])
  const [pos, setPOs]           = useState([])
  const [legs, setLegs]         = useState([])
  const [lines, setLines]       = useState([])
  const [hsnMap, setHsnMap]     = useState(new Map())
  const [form, setForm]         = useState({ ...EMPTY_FORM, pi_id: fromPiId || '' })
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  useEffect(() => {
    Promise.all([
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('proforma_invoices').select('id,pi_no,from_entity_id,to_entity_id,total_amount').eq('is_deleted', false).order('pi_date', { ascending: false }),
      supabase.from('purchase_orders').select('id,po_no,buyer_entity_id,seller_entity_id').eq('is_deleted', false).order('po_date', { ascending: false }),
      supabase.from('hsn_master').select('*').eq('is_active', true),
    ]).then(([{ data: es }, { data: os }, { data: piData }, { data: poData }, { data: hsnRows }]) => {
      setEntities(es || [])
      setOrders(os || [])
      setPIs(piData || [])
      setPOs(poData || [])
      setHsnMap(buildHSNMap(hsnRows || []))
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
    supabase.from('proforma_invoice_lines').select('*').eq('pi_id', fromPiId).order('line_no').then(({ data }) => {
      if (data) setLines(data.map(l => ({ ...l, _id: l.id })))
    })
  }, [fromPiId, pis])

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

  async function handleSave() {
    if (!form.seller_entity_id || !form.buyer_entity_id) return setToast({ message: 'Seller and Buyer are required', type: 'error' })
    if (lines.length === 0) return setToast({ message: 'At least one line item is required', type: 'error' })

    const computedLines = lines.map(l => computeLine(l, form.is_interstate))
    const totals = computeTotals(computedLines)
    setSaving(true)

    const payload = {
      ...form,
      ...totals,
      outstanding_amount: totals.total_amount,
      paid_amount: 0,
    }
    if (!payload.order_id)      delete payload.order_id
    if (!payload.order_leg_id)  delete payload.order_leg_id
    if (!payload.pi_id)         delete payload.pi_id
    if (!payload.po_id)         delete payload.po_id
    if (!payload.due_date)      delete payload.due_date
    if (!payload.einvoice_ack_date) delete payload.einvoice_ack_date
    if (!payload.tds_amount)    delete payload.tds_amount
    if (!payload.tcs_amount)    delete payload.tcs_amount

    const { data: inv, error } = await supabase.from('invoices').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }

    // Insert lines
    const linesPayload = computedLines.map((l, i) => ({
      ...l, invoice_id: inv.id, line_no: i + 1,
      _id: undefined,
    }))
    await supabase.from('invoice_lines').insert(linesPayload)

    // Mark PI as converted if applicable
    if (form.pi_id) {
      await supabase.from('proforma_invoices').update({ status: 'converted', converted_to_invoice_id: inv.id }).eq('id', form.pi_id)
    }

    setSaving(false)
    navigate(`/invoices/${inv.id}`)
  }

  return (
    <div>
      <button onClick={() => navigate('/invoices')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>← Invoices</button>
      <PageHeader title={fromPiId ? 'Convert PI to Invoice' : 'New Invoice'} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '100%' }}>
        <Card style={{ padding: '20px' }}>
          <SectionDivider label='Invoice Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '12px' }}>
            <FormRow label='Invoice Date' required>
              <Input type='date' value={form.invoice_date} onChange={e => setF('invoice_date', e.target.value)} />
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
            <FormRow label='Seller Entity' required>
              <Select value={form.seller_entity_id} onChange={e => setF('seller_entity_id', e.target.value)}>
                <option value=''>Select seller</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
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
                <option value='0'>Intrastate (CGST + SGST)</option>
                <option value='1'>Interstate (IGST)</option>
              </Select>
            </FormRow>
            <FormRow label='Linked PI'>
              <Select value={form.pi_id} onChange={e => setF('pi_id', e.target.value)}>
                <option value=''>No PI</option>
                {pis.map(p => <option key={p.id} value={p.id}>{p.pi_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Linked PO'>
              <Select value={form.po_id} onChange={e => setF('po_id', e.target.value)}>
                <option value=''>No PO</option>
                {pos.map(p => <option key={p.id} value={p.id}>{p.po_no || p.id.slice(0,8)}</option>)}
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
          <div style={{ marginTop: '12px' }}>
            <LineItemsEditor lines={lines} setLines={setLines} interstate={form.is_interstate} hsnMap={hsnMap} />
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
          <SectionDivider label='Notes' />
          <div style={{ marginTop: '12px' }}>
            <Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </div>
        </Card>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Btn variant='ghost' onClick={() => navigate('/invoices')}>Cancel</Btn>
          <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create Invoice'}</Btn>
        </div>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Invoice Detail ───────────────────────────────────────────────────────────
function InvoiceDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [inv, setInv]     = useState(null)
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: i }, { data: ls }] = await Promise.all([
      supabase.from('invoices')
        .select('*, seller:seller_entity_id(name,short_name,gstin,state_code,address,city), buyer:buyer_entity_id(name,short_name,gstin,state_code,address,city), orders(name)')
        .eq('id', id).single(),
      supabase.from('invoice_lines').select('*').eq('invoice_id', id).order('line_no'),
    ])
    setInv(i)
    setLines(ls || [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function updateStatus(status) {
    await supabase.from('invoices').update({ status, updated_at: new Date() }).eq('id', id)
    setToast({ message: `Invoice ${status}`, type: 'success' })
    load()
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!inv)    return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>Invoice not found.</div>

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
            <Badge status={inv.invoice_type} label={inv.invoice_type === 'sales' ? 'Sales Invoice' : 'Purchase Invoice'} />
            <Badge status={inv.status} />
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
          <strong style={{ color: new Date(inv.due_date) < new Date() && inv.status !== 'paid' ? C.danger : C.text }}>
            {fmtDate(inv.due_date)}
          </strong>
        </div>}
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={inv.is_interstate ? 'export' : 'domestic'} label={inv.is_interstate ? 'IGST' : 'CGST+SGST'} /></div>
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

      {inv.notes && <div style={{ marginTop: '12px', fontSize: '13px', color: C.textSoft }}><strong>Notes:</strong> {inv.notes}</div>}

      <div style={{ marginTop: '20px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments
          sourceType='invoices'
          sourceId={inv.id}
          entityName={inv.seller?.name || 'General'}
        />
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel Invoice' message='Cancel this invoice? All GL entries will be reversed.' danger />
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
