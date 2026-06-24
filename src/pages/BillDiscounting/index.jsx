import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import { formatINR, toNum, roundRupees } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import DocumentAttachments from '../../components/DocumentAttachments'

const EMPTY_EVENT = {
  entity_id: '', invoice_id: '', bank_name: '',
  invoice_amount: '', discount_rate: '', discount_amount: '',
  net_proceeds: '', discounting_date: today(),
  maturity_date: '', status: 'active', notes: '',
}

const EMPTY_REPAYMENT = {
  repayment_date: today(), amount_rupees: '', interest_rupees: '0',
  payment_mode: 'bank_transfer', reference_no: '', notes: '',
}

// ─── Bill Discounting List ────────────────────────────────────────────────────
function BDList() {
  const navigate = useNavigate()
  const [events, setEvents]     = useState([])
  const [entities, setEntities] = useState([])
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]         = useState(EMPTY_EVENT)
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: evts }, { data: es }, { data: invs }] = await Promise.all([
      supabase.from('bill_discounting_events')
        .select('*, entity:entity_id(name,short_name), invoice:invoice_id(invoice_no)')
        .eq('is_deleted', false).order('discounting_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('invoices').select('id,invoice_no,total_amount,outstanding_amount').eq('is_deleted', false).eq('status', 'submitted').order('invoice_date', { ascending: false }),
    ])
    setEvents(evts || [])
    setEntities(es || [])
    setInvoices(invs || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) {
    setForm(f => {
      const updated = { ...f, [k]: v }
      // Auto-fill invoice amount when invoice selected
      if (k === 'invoice_id' && v) {
        const inv = invoices.find(i => i.id === v)
        if (inv) {
          updated.invoice_amount = inv.outstanding_amount
        }
      }
      // Auto-calculate net proceeds
      if (k === 'discount_amount' || k === 'invoice_amount') {
        const ia = toNum(k === 'invoice_amount' ? v : updated.invoice_amount)
        const da = toNum(k === 'discount_amount' ? v : updated.discount_amount)
        updated.net_proceeds = roundRupees(ia - da)
      }
      return updated
    })
  }

  async function handleSave() {
    if (!form.entity_id || !form.bank_name) return setToast({ message: 'Entity and bank are required', type: 'error' })
    setSaving(true)
    const payload = {
      entity_id:         form.entity_id,
      invoice_id:        form.invoice_id || null,
      bank_name:         form.bank_name,
      invoice_amount:    roundRupees(toNum(form.invoice_amount)),
      discount_rate:     Number(form.discount_rate) || null,
      discount_amount:   roundRupees(toNum(form.discount_amount)),
      net_proceeds:      roundRupees(toNum(form.net_proceeds)),
      outstanding_amount: roundRupees(toNum(form.net_proceeds)),
      discounting_date:  form.discounting_date,
      maturity_date:     form.maturity_date || null,
      status:            'active',
      notes:             form.notes || null,
    }
    const { data, error } = await supabase.from('bill_discounting_events').insert(payload).select().single()
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: 'Bill discounting event created', type: 'success' })
    setModalOpen(false)
    navigate(`/bill-discounting/${data.id}`)
  }

  const totalOutstanding = events.filter(e => e.status === 'active').reduce((s, e) => s + (e.outstanding_amount || 0), 0)
  const totalNetProceeds = events.reduce((s, e) => s + (e.net_proceeds || 0), 0)

  const columns = [
    { label: 'Date',     render: e => <span style={{ fontSize: '12px' }}>{fmtDate(e.discounting_date)}</span> },
    { label: 'Entity',   render: e => <span style={{ fontSize: '12px', fontWeight: 600 }}>{e.entity?.short_name || e.entity?.name}</span> },
    { label: 'Bank',     render: e => <span style={{ fontSize: '12px' }}>{e.bank_name}</span> },
    { label: 'Invoice',  render: e => <span style={{ fontSize: '11px', fontFamily: 'monospace', color: C.textSoft }}>{e.invoice?.invoice_no || '—'}</span> },
    { label: 'Net Proceeds', right: true, render: e => <span style={{ fontWeight: 600 }}>{formatINR(e.net_proceeds)}</span> },
    { label: 'Outstanding', right: true, render: e => <span style={{ fontWeight: 600, color: e.outstanding_amount > 0 ? C.warning : C.success }}>{formatINR(e.outstanding_amount)}</span> },
    { label: 'Maturity', render: e => {
      if (!e.maturity_date) return <span style={{ color: C.textMuted }}>—</span>
      const overdue = new Date(e.maturity_date) < new Date() && e.status === 'active'
      return <span style={{ fontSize: '12px', color: overdue ? C.danger : C.text, fontWeight: overdue ? 700 : 400 }}>{fmtDate(e.maturity_date)}{overdue ? ' ⚠️' : ''}</span>
    }},
    { label: 'Status',   render: e => <Badge status={e.status} /> },
  ]

  return (
    <div>
      <PageHeader title='Bill Discounting' subtitle='Invoice financing and repayments'
        action={<Btn onClick={() => { setForm(EMPTY_EVENT); setModalOpen(true) }}>+ New Event</Btn>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Total Net Proceeds' value={formatINR(totalNetProceeds)} />
        <StatCard label='Outstanding' value={formatINR(totalOutstanding)} color={totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Active Events' value={events.filter(e => e.status === 'active').length} />
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={events} onRowClick={e => navigate(`/bill-discounting/${e.id}`)}
              emptyState={<EmptyState icon='🏦' title='No bill discounting events' action={<Btn onClick={() => setModalOpen(true)}>+ New Event</Btn>} />} />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Bill Discounting Event' width={600}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Entity' required>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)}>
                <option value=''>Select entity</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Bank Name' required>
              <Input value={form.bank_name} onChange={e => setF('bank_name', e.target.value)} placeholder='e.g. HDFC Bank' />
            </FormRow>
            <FormRow label='Discounting Date' required>
              <Input type='date' value={form.discounting_date} onChange={e => setF('discounting_date', e.target.value)} />
            </FormRow>
            <FormRow label='Maturity Date'>
              <Input type='date' value={form.maturity_date} onChange={e => setF('maturity_date', e.target.value)} />
            </FormRow>
            <FormRow label='Linked Invoice'>
              <Select value={form.invoice_id} onChange={e => setF('invoice_id', e.target.value)}>
                <option value=''>No invoice linked</option>
                {invoices.map(i => <option key={i.id} value={i.id}>{i.invoice_no || i.id.slice(0, 8)} — {formatINR(i.outstanding_amount)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Invoice Amount (₹)'>
              <Input type='number' value={form.invoice_amount} onChange={e => setF('invoice_amount', e.target.value)} />
            </FormRow>
            <FormRow label='Discount Rate (% p.a.)'>
              <Input type='number' value={form.discount_rate} onChange={e => setF('discount_rate', e.target.value)} placeholder='e.g. 12' />
            </FormRow>
            <FormRow label='Discount Amount (₹)'>
              <Input type='number' value={form.discount_amount} onChange={e => setF('discount_amount', e.target.value)} />
            </FormRow>
          </div>
          {form.net_proceeds && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={{ color: C.textSoft }}>Net Proceeds</span>
              <span style={{ fontWeight: 700 }}>{formatINR(toNum(form.net_proceeds))}</span>
            </div>
          )}
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create Event'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Bill Discounting Detail ──────────────────────────────────────────────────
function BDDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [event, setEvent]         = useState(null)
  const [repayments, setRepayments] = useState([])
  const [loading, setLoading]     = useState(true)
  const [repayModal, setRepayModal] = useState(false)
  const [repayForm, setRepayForm] = useState(EMPTY_REPAYMENT)
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ev }, { data: reps }] = await Promise.all([
      supabase.from('bill_discounting_events')
        .select('*, entity:entity_id(name,short_name,bank_name,bank_account_no), invoice:invoice_id(invoice_no,total_amount)')
        .eq('id', id).single(),
      supabase.from('bill_discounting_repayments')
        .select('*').eq('event_id', id).order('repayment_date', { ascending: false }),
    ])
    setEvent(ev)
    setRepayments(reps || [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  function setRF(k, v) { setRepayForm(f => ({ ...f, [k]: v })) }

  async function handleRepayment() {
    const amount = roundRupees(toNum(repayForm.amount_rupees))
    if (!amount) return setToast({ message: 'Amount required', type: 'error' })
    setSaving(true)
    const interest = roundRupees(toNum(repayForm.interest_rupees))
    const { error } = await supabase.from('bill_discounting_repayments').insert({
      event_id:       id,
      repayment_date: repayForm.repayment_date,
      amount,
      interest_amount: interest,
      total_payment:  amount + interest,
      payment_mode:   repayForm.payment_mode,
      reference_no:   repayForm.reference_no || null,
      notes:          repayForm.notes || null,
    })
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    // Update outstanding
    const newOutstanding = Math.max(0, (event.outstanding_amount || 0) - amount)
    const newStatus = newOutstanding === 0 ? 'repaid' : 'active'
    await supabase.from('bill_discounting_events').update({ outstanding_amount: newOutstanding, status: newStatus }).eq('id', id)
    setSaving(false)
    setToast({ message: 'Repayment recorded', type: 'success' })
    setRepayModal(false)
    setRepayForm(EMPTY_REPAYMENT)
    load()
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!event)  return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>Event not found.</div>

  const repColumns = [
    { label: 'Date',      render: r => <span style={{ fontSize: '12px' }}>{fmtDate(r.repayment_date)}</span> },
    { label: 'Principal', right: true, render: r => formatINR(r.amount) },
    { label: 'Interest',  right: true, render: r => formatINR(r.interest_amount) },
    { label: 'Total',     right: true, render: r => <strong>{formatINR(r.total_payment)}</strong> },
    { label: 'Mode',      render: r => <span style={{ fontSize: '12px', textTransform: 'capitalize' }}>{r.payment_mode?.replace('_', ' ')}</span> },
    { label: 'Ref',       render: r => <span style={{ fontSize: '11px', fontFamily: 'monospace', color: C.textSoft }}>{r.reference_no || '—'}</span> },
  ]

  return (
    <div>
      <button onClick={() => navigate('/bill-discounting')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>
        ← Bill Discounting
      </button>
      <PageHeader
        title={`${event.entity?.short_name || event.entity?.name} — ${event.bank_name}`}
        subtitle={`Discounted on ${fmtDate(event.discounting_date)}${event.maturity_date ? ' · Matures ' + fmtDate(event.maturity_date) : ''}`}
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {event.status === 'active' && <Btn onClick={() => { setRepayForm(EMPTY_REPAYMENT); setRepayModal(true) }}>+ Repayment</Btn>}
            <Badge status={event.status} />
          </div>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px', marginBottom: '24px' }}>
        <StatCard label='Invoice Amount'  value={formatINR(event.invoice_amount)} />
        <StatCard label='Discount'        value={formatINR(event.discount_amount)} color={C.warning} />
        <StatCard label='Net Proceeds'    value={formatINR(event.net_proceeds)} />
        <StatCard label='Outstanding'     value={formatINR(event.outstanding_amount)} color={event.outstanding_amount > 0 ? C.danger : C.success} />
        {event.discount_rate && <StatCard label='Rate (p.a.)' value={`${event.discount_rate}%`} />}
      </div>

      {event.invoice && (
        <div style={{ marginBottom: '16px', fontSize: '13px', color: C.textSoft }}>
          <strong>Linked Invoice:</strong> {event.invoice.invoice_no} — {formatINR(event.invoice.total_amount)}
        </div>
      )}

      <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '12px' }}>Repayments ({repayments.length})</div>
      <Card>
        {repayments.length === 0
          ? <EmptyState icon='💰' title='No repayments yet' message={event.status === 'active' ? 'Record a repayment when funds are returned.' : undefined} action={event.status === 'active' ? <Btn onClick={() => setRepayModal(true)}>+ Repayment</Btn> : undefined} />
          : <Table columns={repColumns} rows={repayments} />
        }
      </Card>

      <div style={{ marginTop: '20px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments
          sourceType='bill_discounting_events'
          sourceId={event.id}
          entityName={event.entity?.name || 'General'}
        />
      </div>

      {/* Repayment Modal */}
      <Modal open={repayModal} onClose={() => setRepayModal(false)} title='Record Repayment' width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Date' required><Input type='date' value={repayForm.repayment_date} onChange={e => setRF('repayment_date', e.target.value)} /></FormRow>
            <FormRow label='Principal (₹)' required><Input type='number' value={repayForm.amount_rupees} onChange={e => setRF('amount_rupees', e.target.value)} /></FormRow>
            <FormRow label='Interest (₹)'><Input type='number' value={repayForm.interest_rupees} onChange={e => setRF('interest_rupees', e.target.value)} /></FormRow>
            <FormRow label='Payment Mode'>
              <Select value={repayForm.payment_mode} onChange={e => setRF('payment_mode', e.target.value)}>
                {['bank_transfer', 'cash', 'cheque', 'upi'].map(m => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Reference No'><Input value={repayForm.reference_no} onChange={e => setRF('reference_no', e.target.value)} /></FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={repayForm.notes} onChange={e => setRF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setRepayModal(false)}>Cancel</Btn>
            <Btn onClick={handleRepayment} disabled={saving}>{saving ? 'Saving…' : 'Record Repayment'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function BillDiscounting() {
  return (
    <Routes>
      <Route index       element={<BDList />} />
      <Route path=':id'  element={<BDDetail />} />
    </Routes>
  )
}
