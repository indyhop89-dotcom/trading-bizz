import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import DocumentAttachments from '../../components/DocumentAttachments'
import { formatINR, toNum, roundRupees } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'

// ─── constants ────────────────────────────────────────────────────────────────
const CURRENCIES = ['INR', 'USD', 'AED', 'EUR', 'GBP', 'SGD', 'SAR']

const EXPENSE_CATEGORIES = [
  'Hangtags', 'Freight', 'Transport', 'Labour', 'Loading/Unloading',
  'Brokerage', 'Bank Charges', 'Duty/Tax', 'Insurance', 'Office',
  'Professional', 'Repair', 'Sampling', 'Packaging', 'Other',
]

const EXPENSE_STATUSES = ['Recorded', 'Advance Paid', 'Partial', 'Paid', 'Closed']

// ─── shared helpers ───────────────────────────────────────────────────────────
function calcBalance(amount, advance, adjustments) {
  return Math.max(0, toNum(amount) - toNum(advance) - toNum(adjustments))
}

function calcDaysLeft(dueDate, actualPaymentDate) {
  if (actualPaymentDate) return 0
  if (!dueDate) return null
  return Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24))
}

function autoStatus(advance, balance, actualPaymentDate) {
  if (actualPaymentDate) return 'Paid'
  if (toNum(advance) > 0 && toNum(balance) > 0) return 'Advance Paid'
  if (toNum(advance) > 0 && toNum(balance) === 0) return 'Paid'
  return 'Recorded'
}

function calcInvDaysLeft(dueDate, paid) {
  if (paid) return 0
  if (!dueDate) return null
  return Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24))
}

function invStatus(daysLeft, actualPaymentDate, advance, amount) {
  if (actualPaymentDate) return 'paid'
  const bal = toNum(amount) - toNum(advance)
  if (bal <= 0) return 'paid'
  if (daysLeft === null) return 'pending'
  if (daysLeft < 0)   return 'overdue'
  if (daysLeft <= 7)  return 'due_soon'
  return 'pending'
}

// ─── shared UI atoms ──────────────────────────────────────────────────────────
const INV_STATUS_STYLE = {
  paid:     { bg: '#e8f3ec', color: '#1a5c30', label: 'Paid' },
  overdue:  { bg: '#f0e8e8', color: '#8a2020', label: 'Overdue' },
  due_soon: { bg: '#fff3cc', color: '#7a5000', label: 'Due Soon' },
  pending:  { bg: '#f0ebe0', color: '#7a6a4a', label: 'Pending' },
}

const EXP_STATUS_STYLE = {
  Recorded:      { bg: '#f0ebe0', color: '#7a6a4a' },
  'Advance Paid':{ bg: '#e8f0f3', color: '#1a4a6a' },
  Partial:       { bg: '#fff3cc', color: '#7a5000' },
  Paid:          { bg: '#e8f3ec', color: '#1a5c30' },
  Closed:        { bg: '#ede8f3', color: '#3a1a6a' },
}

function StatusPill({ status, isExpense }) {
  const s = isExpense
    ? (EXP_STATUS_STYLE[status] || EXP_STATUS_STYLE.Recorded)
    : (INV_STATUS_STYLE[status] || INV_STATUS_STYLE.pending)
  return (
    <span style={{
      background: s.bg, color: s.color,
      fontSize: '11px', fontWeight: 700,
      padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap',
    }}>{isExpense ? status : (INV_STATUS_STYLE[status]?.label || status)}</span>
  )
}

function DaysLeft({ days, paid }) {
  if (paid || days === 0) return <span style={{ color: C.textMuted, fontSize: '12px' }}>—</span>
  if (days === null)      return <span style={{ color: C.textMuted, fontSize: '12px' }}>—</span>
  const color = days < 0 ? C.danger : days <= 7 ? '#c0820a' : C.success
  return <span style={{ fontSize: '12px', fontWeight: 700, color }}>{days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}</span>
}

function AmtCell({ amount, currency }) {
  if (!amount && amount !== 0) return <span style={{ color: C.textMuted }}>—</span>
  const sym = { INR: '₹', USD: '$', AED: 'AED ', EUR: '€', GBP: '£' }[currency] || currency + ' '
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{sym}{Math.round(Number(amount)).toLocaleString('en-IN')}</span>
}

function CurrBadge({ currency }) {
  return <span style={{ fontSize: '10px', fontWeight: 700, background: '#f0ebe0', color: C.textMid, padding: '1px 5px', borderRadius: '3px' }}>{currency}</span>
}

function BalancePreview({ amount, advance, adjustments, currency, usdRate }) {
  const bal = calcBalance(amount, advance, adjustments)
  const pendingUSD = usdRate && bal > 0 ? Math.round(bal / toNum(usdRate)) : null
  if (!toNum(amount)) return null
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', display: 'grid', gridTemplateColumns: `repeat(${pendingUSD != null ? 4 : 3}, 1fr)`, gap: '8px', fontSize: '13px' }}>
      {[
        { label: 'Amount',      val: `${currency} ${Math.round(toNum(amount)).toLocaleString('en-IN')}`,     color: C.text },
        { label: 'Advance',     val: `− ${Math.round(toNum(advance)).toLocaleString('en-IN')}`,              color: C.textSoft },
        { label: 'Balance Due', val: `${currency} ${Math.round(bal).toLocaleString('en-IN')}`,               color: bal > 0 ? C.danger : C.success },
        pendingUSD != null ? { label: 'Pending USD', val: `$${pendingUSD.toLocaleString('en-IN')}`, color: C.warning } : null,
      ].filter(Boolean).map(item => (
        <div key={item.label}>
          <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>{item.label}</div>
          <strong style={{ color: item.color }}>{item.val}</strong>
        </div>
      ))}
    </div>
  )
}

// ─── Invoice Payment Tracker ──────────────────────────────────────────────────
const EMPTY_INV = {
  invoice_id: '', entity_id: '', party_entity_id: '', party_name: '',
  invoice_no: '', invoice_date: '', currency: 'INR', amount: '',
  advance_amount: '', advance_date: '', adjustments: '0', adjustment_notes: '',
  due_date: '', actual_payment_date: '', exchange_rate: '1', notes: '',
}

function InvoicePaymentTracker() {
  const [rows, setRows]         = useState([])
  const [entities, setEntities] = useState([])
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen]   = useState(false)
  const [detailOpen, setDetailOpen] = useState(null) // row for detail panel
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_INV)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmPaid, setConfirmPaid]     = useState(null)
  const [statusFilter, setStatusFilter]   = useState('all')
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: rs }, { data: es }, { data: invs }] = await Promise.all([
      supabase.from('invoice_payments')
        .select('*, entity:entity_id(name,short_name), party:party_entity_id(name,short_name), invoice:invoice_id(invoice_no,total_amount,invoice_date)')
        .eq('is_deleted', false).order('created_at', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('invoices').select('id,invoice_no,total_amount,invoice_date,seller:seller_entity_id(name,short_name)').eq('is_deleted', false).neq('status','cancelled').order('invoice_date', { ascending: false }),
    ])
    setRows(rs || [])
    setEntities(es || [])
    setInvoices(invs || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'invoice_id' && v) {
        const inv = invoices.find(i => i.id === v)
        if (inv) { u.invoice_no = inv.invoice_no || ''; u.invoice_date = inv.invoice_date || ''; u.amount = inv.total_amount != null ? String(inv.total_amount) : '' }
      }
      return u
    })
  }

  function openNew()   { setEditing(null); setForm(EMPTY_INV); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({ invoice_id: r.invoice_id||'', entity_id: r.entity_id||'', party_entity_id: r.party_entity_id||'', party_name: r.party_name||'', invoice_no: r.invoice_no||'', invoice_date: r.invoice_date||'', currency: r.currency||'INR', amount: r.amount!=null?String(r.amount):'', advance_amount: r.advance_amount!=null?String(r.advance_amount):'', advance_date: r.advance_date||'', adjustments: r.adjustments!=null?String(r.adjustments):'0', adjustment_notes: r.adjustment_notes||'', due_date: r.due_date||'', actual_payment_date: r.actual_payment_date||'', exchange_rate: r.exchange_rate!=null?String(r.exchange_rate):'1', notes: r.notes||'' })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!toNum(form.amount)) return setToast({ message: 'Amount is required', type: 'error' })
    setSaving(true)
    const payload = { invoice_id: form.invoice_id||null, entity_id: form.entity_id||null, party_entity_id: form.party_entity_id||null, party_name: form.party_name||null, invoice_no: form.invoice_no||null, invoice_date: form.invoice_date||null, currency: form.currency, amount: toNum(form.amount), advance_amount: toNum(form.advance_amount), advance_date: form.advance_date||null, adjustments: toNum(form.adjustments), adjustment_notes: form.adjustment_notes||null, due_date: form.due_date||null, actual_payment_date: form.actual_payment_date||null, exchange_rate: toNum(form.exchange_rate)||1, notes: form.notes||null, updated_at: new Date() }
    let error
    if (editing) { const r = await supabase.from('invoice_payments').update(payload).eq('id', editing.id); error = r.error }
    else         { const r = await supabase.from('invoice_payments').insert(payload); error = r.error }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'Updated' : 'Added', type: 'success' })
    setModalOpen(false); load()
  }

  async function markPaid(row) {
    await supabase.from('invoice_payments').update({ actual_payment_date: today(), updated_at: new Date() }).eq('id', row.id)
    setConfirmPaid(null)
    setToast({ message: 'Marked as paid', type: 'success' })
    load()
  }

  async function handleDelete() {
    await supabase.from('invoice_payments').update({ is_deleted: true }).eq('id', confirmDelete.id)
    setConfirmDelete(null); load()
  }

  const computed = rows.map(r => {
    const balance  = calcBalance(r.amount, r.advance_amount, r.adjustments)
    const daysLeft = calcInvDaysLeft(r.due_date, r.actual_payment_date)
    const status   = invStatus(daysLeft, r.actual_payment_date, r.advance_amount, r.amount)
    return { ...r, _balance: balance, _daysLeft: daysLeft, _status: status }
  })

  const filtered = statusFilter === 'all' ? computed : computed.filter(r => r._status === statusFilter)
  const totalOutstanding = computed.filter(r => r._status !== 'paid').reduce((s, r) => s + r._balance, 0)

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '10px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', whiteSpace: 'nowrap' }
  const td = { padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, fontSize: '12px', verticalAlign: 'middle' }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Outstanding' value={formatINR(totalOutstanding)} color={totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Overdue'     value={computed.filter(r => r._status === 'overdue').length} color={computed.filter(r => r._status === 'overdue').length > 0 ? C.danger : C.success} />
        <StatCard label='Paid'        value={computed.filter(r => r._status === 'paid').length} color={C.success} />
        <StatCard label='Total'       value={computed.length} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All</option>
          <option value='pending'>Pending</option>
          <option value='due_soon'>Due Soon</option>
          <option value='overdue'>Overdue</option>
          <option value='paid'>Paid</option>
        </select>
        <div style={{ flex: 1 }} />
        <Btn onClick={openNew}>+ Add</Btn>
      </div>

      <Card>
        {loading ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        : filtered.length === 0 ? <EmptyState icon='💳' title='No invoice payments' action={<Btn onClick={openNew}>+ Add</Btn>} />
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1100px' }}>
              <thead><tr>
                {['#','Entity','Party','Invoice No','Date','CCY','Amount','Advance','Balance','Due','Days Left','Paid Date','Docs','Status',''].map((h,i) => (
                  <th key={i} style={{ ...th, textAlign: i >= 6 && i <= 8 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.id} style={{ background: r._status === 'overdue' ? '#fff5f5' : r._status === 'due_soon' ? '#fffdf0' : i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={{ ...td, color: C.textMuted }}>{i+1}</td>
                    <td style={td}>{r.entity?.short_name || r.entity?.name || '—'}</td>
                    <td style={td}>{r.party?.short_name || r.party?.name || r.party_name || '—'}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{r.invoice_no || '—'}</td>
                    <td style={td}>{fmtDate(r.invoice_date)}</td>
                    <td style={td}><CurrBadge currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}><AmtCell amount={r.amount} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={r.advance_amount} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r._balance > 0 ? C.warning : C.success }}><AmtCell amount={r._balance} currency={r.currency} /></td>
                    <td style={td}>{fmtDate(r.due_date)}</td>
                    <td style={td}><DaysLeft days={r._daysLeft} paid={!!r.actual_payment_date} /></td>
                    <td style={td}>{fmtDate(r.actual_payment_date)}</td>
                    <td style={td}><DocumentAttachments sourceType='invoice_payments' sourceId={r.id} entityName={r.entity?.name || 'General'} compact /></td>
                    <td style={td}><StatusPill status={r._status} /></td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
                        {r._status !== 'paid' && <Btn size='sm' variant='success' onClick={() => setConfirmPaid(r)}>Mark Paid</Btn>}
                        <Btn size='sm' variant='ghost' onClick={() => setDetailOpen(r)} style={{ color: C.info }}>Docs</Btn>
                        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Del</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Detail / Documents panel */}
      <Modal open={!!detailOpen} onClose={() => setDetailOpen(null)} title={`Documents — ${detailOpen?.invoice_no || 'Invoice Payment'}`} width={560}>
        <DocumentAttachments sourceType='invoice_payments' sourceId={detailOpen?.id} entityName={detailOpen?.entity?.name || 'General'} />
      </Modal>

      {/* Add / Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Invoice Payment' : 'Add Invoice Payment'} width={660}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <SectionDivider label='Invoice' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Link Invoice'>
              <Select value={form.invoice_id} onChange={e => setF('invoice_id', e.target.value)}>
                <option value=''>No invoice linked</option>
                {invoices.map(i => <option key={i.id} value={i.id}>{i.invoice_no || i.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Invoice No'><Input value={form.invoice_no} onChange={e => setF('invoice_no', e.target.value)} /></FormRow>
            <FormRow label='Invoice Date'><Input type='date' value={form.invoice_date} onChange={e => setF('invoice_date', e.target.value)} /></FormRow>
            <FormRow label='Our Entity'>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Party (in system)'>
              <Select value={form.party_entity_id} onChange={e => setF('party_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Party (external)'><Input value={form.party_name} onChange={e => setF('party_name', e.target.value)} disabled={!!form.party_entity_id} /></FormRow>
          </div>
          <SectionDivider label='Amount' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Currency'><Select value={form.currency} onChange={e => setF('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></FormRow>
            <FormRow label='Amount' required><Input type='number' value={form.amount} onChange={e => setF('amount', e.target.value)} /></FormRow>
            {form.currency !== 'INR' && <FormRow label='Rate (1 unit = ₹)'><Input type='number' value={form.exchange_rate} onChange={e => setF('exchange_rate', e.target.value)} /></FormRow>}
          </div>
          <SectionDivider label='Payments' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Advance Paid'><Input type='number' value={form.advance_amount} onChange={e => setF('advance_amount', e.target.value)} placeholder='0' /></FormRow>
            <FormRow label='Advance Date'><Input type='date' value={form.advance_date} onChange={e => setF('advance_date', e.target.value)} /></FormRow>
            <FormRow label='Adjustments'><Input type='number' value={form.adjustments} onChange={e => setF('adjustments', e.target.value)} placeholder='0' /></FormRow>
            <FormRow label='Adj. Notes'><Input value={form.adjustment_notes} onChange={e => setF('adjustment_notes', e.target.value)} /></FormRow>
          </div>
          <BalancePreview amount={form.amount} advance={form.advance_amount} adjustments={form.adjustments} currency={form.currency} />
          <SectionDivider label='Dates' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Due Date'><Input type='date' value={form.due_date} onChange={e => setF('due_date', e.target.value)} /></FormRow>
            <FormRow label='Actual Payment Date'><Input type='date' value={form.actual_payment_date} onChange={e => setF('actual_payment_date', e.target.value)} /></FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmPaid} onClose={() => setConfirmPaid(null)} onConfirm={() => markPaid(confirmPaid)}
        title='Mark as Paid' message={`Mark this invoice payment as paid today (${today()})?`} />
      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete' message='Delete this payment entry?' danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Expense Payment Tracker ──────────────────────────────────────────────────
const EMPTY_EXP = {
  expense_category: '', expense_type: 'Direct', expense_tag: '',
  from_entity_id: '', from_name: '', to_entity_id: '', to_name: '',
  location: '', qty: '', proforma_ref: '',
  linked_invoice_id: '', linked_pi_id: '',
  invoice_no: '', invoice_date: '',
  currency: 'INR', amount: '',
  advance_amount: '', advance_date: '',
  adjustments: '0', adjustment_notes: '',
  due_date: '', actual_payment_date: '',
  manual_status: '',
  usd_rate: '', notes: '',
}

function ExpensePaymentTracker() {
  const [rows, setRows]         = useState([])
  const [entities, setEntities] = useState([])
  const [invoices, setInvoices] = useState([])
  const [pis, setPIs]           = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen]   = useState(false)
  const [detailOpen, setDetailOpen] = useState(null)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_EXP)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmPaid, setConfirmPaid]     = useState(null)
  const [statusFilter, setStatusFilter]   = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: rs }, { data: es }, { data: invs }, { data: piData }] = await Promise.all([
      supabase.from('expense_payments')
        .select('*, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name), linked_invoice:linked_invoice_id(invoice_no), linked_pi:linked_pi_id(pi_no)')
        .eq('is_deleted', false).order('created_at', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('invoices').select('id,invoice_no').eq('is_deleted', false).neq('status','cancelled').order('invoice_date', { ascending: false }),
      supabase.from('proforma_invoices').select('id,pi_no').eq('is_deleted', false).order('pi_date', { ascending: false }),
    ])
    setRows(rs || [])
    setEntities(es || [])
    setInvoices(invs || [])
    setPIs(piData || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function openNew()   { setEditing(null); setForm(EMPTY_EXP); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({
      expense_category: r.expense_category||'', expense_type: r.expense_type||'Direct', expense_tag: r.expense_tag||'',
      from_entity_id: r.from_entity_id||'', from_name: r.from_name||'', to_entity_id: r.to_entity_id||'', to_name: r.to_name||'',
      location: r.location||'', qty: r.qty!=null?String(r.qty):'', proforma_ref: r.proforma_ref||'',
      linked_invoice_id: r.linked_invoice_id||'', linked_pi_id: r.linked_pi_id||'',
      invoice_no: r.invoice_no||'', invoice_date: r.invoice_date||'',
      currency: r.currency||'INR', amount: r.amount!=null?String(r.amount):'',
      advance_amount: r.advance_amount!=null?String(r.advance_amount):'', advance_date: r.advance_date||'',
      adjustments: r.adjustments!=null?String(r.adjustments):'0', adjustment_notes: r.adjustment_notes||'',
      due_date: r.due_date||'', actual_payment_date: r.actual_payment_date||'',
      manual_status: r.manual_status||'',
      usd_rate: r.usd_rate!=null?String(r.usd_rate):'', notes: r.notes||'',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.expense_category) return setToast({ message: 'Category required', type: 'error' })
    if (!toNum(form.amount))    return setToast({ message: 'Amount required', type: 'error' })
    setSaving(true)
    const balance = calcBalance(form.amount, form.advance_amount, form.adjustments)
    const computedStatus = form.manual_status || autoStatus(form.advance_amount, balance, form.actual_payment_date)
    const payload = {
      expense_category: form.expense_category, expense_type: form.expense_type, expense_tag: form.expense_tag||null,
      from_entity_id: form.from_entity_id||null, from_name: form.from_name||null,
      to_entity_id: form.to_entity_id||null, to_name: form.to_name||null,
      location: form.location||null, qty: toNum(form.qty)||null, proforma_ref: form.proforma_ref||null,
      linked_invoice_id: form.linked_invoice_id||null, linked_pi_id: form.linked_pi_id||null,
      invoice_no: form.invoice_no||null, invoice_date: form.invoice_date||null,
      currency: form.currency, amount: toNum(form.amount),
      advance_amount: toNum(form.advance_amount), advance_date: form.advance_date||null,
      adjustments: toNum(form.adjustments), adjustment_notes: form.adjustment_notes||null,
      due_date: form.due_date||null, actual_payment_date: form.actual_payment_date||null,
      manual_status: form.manual_status||null,
      usd_rate: toNum(form.usd_rate)||null, notes: form.notes||null,
      updated_at: new Date(),
    }
    let error
    if (editing) { const r = await supabase.from('expense_payments').update(payload).eq('id', editing.id); error = r.error }
    else         { const r = await supabase.from('expense_payments').insert(payload); error = r.error }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'Updated' : 'Added', type: 'success' })
    setModalOpen(false); load()
  }

  async function markPaid(row) {
    const balance = calcBalance(row.amount, row.advance_amount, row.adjustments)
    await supabase.from('expense_payments').update({ actual_payment_date: today(), manual_status: 'Paid', updated_at: new Date() }).eq('id', row.id)
    setConfirmPaid(null)
    setToast({ message: 'Marked as paid', type: 'success' })
    load()
  }

  async function handleDelete() {
    await supabase.from('expense_payments').update({ is_deleted: true }).eq('id', confirmDelete.id)
    setConfirmDelete(null); load()
  }

  const computed = rows.map(r => {
    const balance      = calcBalance(r.amount, r.advance_amount, r.adjustments)
    const daysLeft     = calcDaysLeft(r.due_date, r.actual_payment_date)
    const autoSt       = autoStatus(r.advance_amount, balance, r.actual_payment_date)
    const status       = r.manual_status || autoSt
    const totalPaid    = r.actual_payment_date ? toNum(r.amount) : toNum(r.advance_amount) + toNum(r.adjustments)
    const totalPayable = r.actual_payment_date ? 0 : balance
    const pendingUSD   = r.usd_rate && totalPayable > 0 ? Math.round(totalPayable / r.usd_rate) : null
    return { ...r, _balance: balance, _daysLeft: daysLeft, _status: status, _totalPaid: totalPaid, _totalPayable: totalPayable, _pendingUSD: pendingUSD }
  })

  const filtered = computed.filter(r => {
    const ms = statusFilter === 'all'   || r._status === statusFilter
    const mc = categoryFilter === 'all' || r.expense_category === categoryFilter
    return ms && mc
  })

  const totalOutstanding = computed.reduce((s, r) => s + r._totalPayable, 0)

  const th = { padding: '8px 10px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '10px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', whiteSpace: 'nowrap' }
  const td = { padding: '8px 10px', borderBottom: `1px solid #f0e8d8`, fontSize: '12px', verticalAlign: 'middle' }

  const COLS = ['#','Category','Type','From','To','Location','Qty','Invoice','Date','CCY','Amount','Advance','Balance','Due','Days','Paid Date','Total Paid','Payable','USD Pending','Tag','Docs','Status','']

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Outstanding' value={formatINR(totalOutstanding)} color={totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Overdue'     value={computed.filter(r => r._daysLeft !== null && r._daysLeft < 0 && !r.actual_payment_date).length} color={C.danger} />
        <StatCard label='Total Rows'  value={computed.length} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {EXPENSE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All categories</option>
          {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <Btn onClick={openNew}>+ Add Expense</Btn>
      </div>

      <Card>
        {loading ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        : filtered.length === 0 ? <EmptyState icon='📊' title='No expense payments' action={<Btn onClick={openNew}>+ Add Expense</Btn>} />
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1700px' }}>
              <thead><tr>{COLS.map((h,i) => <th key={i} style={{ ...th, textAlign: i >= 10 && i <= 18 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.id} style={{ background: r._daysLeft !== null && r._daysLeft < 0 && !r.actual_payment_date ? '#fff5f5' : i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={{ ...td, color: C.textMuted }}>{i+1}</td>
                    <td style={td}><strong>{r.expense_category}</strong></td>
                    <td style={td}><span style={{ fontSize: '10px', fontWeight: 700, background: r.expense_type === 'Direct' ? '#e8f0f3' : '#ede8f3', color: r.expense_type === 'Direct' ? '#1a4a6a' : '#3a1a6a', padding: '1px 5px', borderRadius: '3px' }}>{r.expense_type}</span></td>
                    <td style={td}>{r.from_entity?.short_name || r.from_entity?.name || r.from_name || '—'}</td>
                    <td style={td}>{r.to_entity?.short_name || r.to_entity?.name || r.to_name || '—'}</td>
                    <td style={td}>{r.location || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{r.qty || '—'}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>
                      {r.linked_invoice?.invoice_no || r.linked_pi?.pi_no || r.invoice_no || '—'}
                    </td>
                    <td style={td}>{fmtDate(r.invoice_date)}</td>
                    <td style={td}><CurrBadge currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}><AmtCell amount={r.amount} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={r.advance_amount} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r._balance > 0 ? C.warning : C.success }}><AmtCell amount={r._balance} currency={r.currency} /></td>
                    <td style={td}>{fmtDate(r.due_date)}</td>
                    <td style={td}><DaysLeft days={r._daysLeft} paid={!!r.actual_payment_date} /></td>
                    <td style={td}>{fmtDate(r.actual_payment_date)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: C.success }}><AmtCell amount={r._totalPaid} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r._totalPayable > 0 ? C.danger : C.success }}><AmtCell amount={r._totalPayable} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right', color: C.textSoft }}>{r._pendingUSD != null ? `$${r._pendingUSD.toLocaleString('en-IN')}` : '—'}</td>
                    <td style={td}>{r.expense_tag || '—'}</td>
                    <td style={td}><DocumentAttachments sourceType='expense_payments' sourceId={r.id} entityName={r.from_entity?.name || 'General'} compact /></td>
                    <td style={td}><StatusPill status={r._status} isExpense /></td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
                        {r._status !== 'Paid' && r._status !== 'Closed' && <Btn size='sm' variant='success' onClick={() => setConfirmPaid(r)}>Mark Paid</Btn>}
                        <Btn size='sm' variant='ghost' onClick={() => setDetailOpen(r)} style={{ color: C.info }}>Docs</Btn>
                        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Del</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Documents panel */}
      <Modal open={!!detailOpen} onClose={() => setDetailOpen(null)} title={`Documents — ${detailOpen?.expense_category || 'Expense'}`} width={560}>
        <DocumentAttachments sourceType='expense_payments' sourceId={detailOpen?.id} entityName={detailOpen?.from_entity?.name || 'General'} />
      </Modal>

      {/* Add / Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Expense Payment' : 'Add Expense Payment'} width={740}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          <SectionDivider label='Classification' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Category' required>
              <Select value={form.expense_category} onChange={e => setF('expense_category', e.target.value)}>
                <option value=''>Select</option>
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Type'>
              <Select value={form.expense_type} onChange={e => setF('expense_type', e.target.value)}>
                <option value='Direct'>Direct</option>
                <option value='Indirect'>Indirect</option>
              </Select>
            </FormRow>
            <FormRow label='Tag / Label'><Input value={form.expense_tag} onChange={e => setF('expense_tag', e.target.value)} placeholder='e.g. GiorVan' /></FormRow>
          </div>

          <SectionDivider label='Parties' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='From (in system)'>
              <Select value={form.from_entity_id} onChange={e => setF('from_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='From (external)'><Input value={form.from_name} onChange={e => setF('from_name', e.target.value)} disabled={!!form.from_entity_id} /></FormRow>
            <FormRow label='To (in system)'>
              <Select value={form.to_entity_id} onChange={e => setF('to_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='To (external)'><Input value={form.to_name} onChange={e => setF('to_name', e.target.value)} disabled={!!form.to_entity_id} /></FormRow>
            <FormRow label='Location'><Input value={form.location} onChange={e => setF('location', e.target.value)} placeholder='e.g. DXB' /></FormRow>
            <FormRow label='Qty'><Input type='number' value={form.qty} onChange={e => setF('qty', e.target.value)} /></FormRow>
          </div>

          <SectionDivider label='Invoice / PI Reference' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Link Invoice'>
              <Select value={form.linked_invoice_id} onChange={e => setF('linked_invoice_id', e.target.value)}>
                <option value=''>No invoice</option>
                {invoices.map(i => <option key={i.id} value={i.id}>{i.invoice_no || i.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Link PI'>
              <Select value={form.linked_pi_id} onChange={e => setF('linked_pi_id', e.target.value)}>
                <option value=''>No PI</option>
                {pis.map(p => <option key={p.id} value={p.id}>{p.pi_no || p.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Proforma Ref'><Input value={form.proforma_ref} onChange={e => setF('proforma_ref', e.target.value)} /></FormRow>
            <FormRow label='Invoice No'><Input value={form.invoice_no} onChange={e => setF('invoice_no', e.target.value)} /></FormRow>
            <FormRow label='Invoice Date'><Input type='date' value={form.invoice_date} onChange={e => setF('invoice_date', e.target.value)} /></FormRow>
          </div>

          <SectionDivider label='Amount' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Currency'><Select value={form.currency} onChange={e => setF('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></FormRow>
            <FormRow label='Amount' required><Input type='number' value={form.amount} onChange={e => setF('amount', e.target.value)} /></FormRow>
            <FormRow label='USD Rate' hint='1 USD = ? currency'><Input type='number' value={form.usd_rate} onChange={e => setF('usd_rate', e.target.value)} placeholder='e.g. 3.67' /></FormRow>
          </div>

          <SectionDivider label='Payments' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Advance Paid'><Input type='number' value={form.advance_amount} onChange={e => setF('advance_amount', e.target.value)} placeholder='0' /></FormRow>
            <FormRow label='Advance Date'><Input type='date' value={form.advance_date} onChange={e => setF('advance_date', e.target.value)} /></FormRow>
            <FormRow label='Adjustments'><Input type='number' value={form.adjustments} onChange={e => setF('adjustments', e.target.value)} placeholder='0' /></FormRow>
            <FormRow label='Adj. Notes'><Input value={form.adjustment_notes} onChange={e => setF('adjustment_notes', e.target.value)} /></FormRow>
          </div>

          <BalancePreview amount={form.amount} advance={form.advance_amount} adjustments={form.adjustments} currency={form.currency} usdRate={form.usd_rate} />

          <SectionDivider label='Dates & Status' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Due Date'><Input type='date' value={form.due_date} onChange={e => setF('due_date', e.target.value)} /></FormRow>
            <FormRow label='Actual Payment Date'><Input type='date' value={form.actual_payment_date} onChange={e => setF('actual_payment_date', e.target.value)} /></FormRow>
            <FormRow label='Override Status' hint='Leave blank for auto'>
              <Select value={form.manual_status} onChange={e => setF('manual_status', e.target.value)}>
                <option value=''>Auto</option>
                {EXPENSE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </FormRow>
          </div>

          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Expense'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmPaid} onClose={() => setConfirmPaid(null)} onConfirm={() => markPaid(confirmPaid)}
        title='Mark as Paid' message={`Mark this expense as fully paid today (${today()})?`} />
      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete' message='Delete this expense payment entry?' danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Shell ────────────────────────────────────────────────────────────────────
export default function Payments() {
  const [tab, setTab] = useState('Invoice Payments')
  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: C.text, margin: 0 }}>Payments</h1>
        <p style={{ fontSize: '13px', color: C.textMuted, margin: '4px 0 0' }}>Track invoice and expense payment status</p>
      </div>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `2px solid ${C.border}` }}>
        {['Invoice Payments', 'Expense Payments'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontWeight: tab === t ? 700 : 500, fontSize: '13px',
            color: tab === t ? C.text : C.textSoft, background: 'transparent',
            borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: '-2px', transition: 'all 0.15s',
          }}>{t}</button>
        ))}
      </div>
      {tab === 'Invoice Payments' && <InvoicePaymentTracker />}
      {tab === 'Expense Payments' && <ExpensePaymentTracker />}
    </div>
  )
}
