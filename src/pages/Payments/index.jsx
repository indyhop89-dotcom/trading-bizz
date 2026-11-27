import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import { exportRows } from '../../utils/exportCsv' // CHANGED: CSV export of the rows on screen
import {
  C, Btn, MultiSelectDropdown, Modal, ConfirmModal, Toast, EmptyState,
  Card, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import DocumentAttachments from '../../components/DocumentAttachments'
import PickTable from './PickTable'
import TdsRegister from './TdsRegister'
import Journal from './Journal'
import { formatINR, formatNumberIN, toNum, roundRupees, round2 } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { useAuth } from '../../hooks/useAuth'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { hasFullAccess } from '../../utils/roles'
import {
  computeInvoiceOutstanding, syncInvoicePaymentStatus, syncInvoicesPaymentStatus, buildEntityLedger,
  fetchSettlements, groupSettlementsByInvoice, settlementFor, groupTranchesByInvoice, pairSetoffs, nextJournalNo,
} from '../../utils/payments'
import { excludeAutoPurchaseMirrors } from '../../utils/query'

// ─── TDS / TCS constants ────────────────────────────────────────────────────────
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

function calcInvDaysLeft(dueDate) {
  if (!dueDate) return null
  return Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24))
}

// Status for an INVOICE (aggregated across all its payment tranches), not a single row.
function invStatus(daysLeft, pending) {
  if (pending <= 0) return 'paid'
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

const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', AED: 'AED ', EUR: '€', GBP: '£' }

function AmtCell({ amount, currency }) {
  if (!amount && amount !== 0) return <span style={{ color: C.textMuted }}>—</span>
  const sym = CURRENCY_SYMBOLS[currency] || currency + ' '
  // CHANGED: was Math.round(...).toLocaleString — whole rupees, no decimals,
  // inconsistent with the 2-decimal convention formatNumberIN enforces
  // everywhere else in the app.
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{sym}{formatNumberIN(amount)}</span>
}

function CurrBadge({ currency }) {
  return <span style={{ fontSize: '10px', fontWeight: 700, background: '#f0ebe0', color: C.textMid, padding: '1px 5px', borderRadius: '3px' }}>{currency}</span>
}

function BalancePreview({ amount, advance, adjustments, currency, usdRate }) {
  const bal = calcBalance(amount, advance, adjustments)
  // CHANGED: was Math.round(...) — dropped to a whole USD number, inconsistent
  // with the 2-decimal convention used everywhere else.
  const pendingUSD = usdRate && bal > 0 ? bal / toNum(usdRate) : null
  if (!toNum(amount)) return null
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', display: 'grid', gridTemplateColumns: `repeat(${pendingUSD != null ? 4 : 3}, 1fr)`, gap: '8px', fontSize: '13px' }}>
      {[
        { label: 'Amount',      val: `${currency} ${formatNumberIN(amount)}`,     color: C.text },
        { label: 'Advance',     val: `− ${formatNumberIN(advance)}`,              color: C.textSoft },
        { label: 'Balance Due', val: `${currency} ${formatNumberIN(bal)}`,        color: bal > 0 ? C.danger : C.success },
        pendingUSD != null ? { label: 'Pending USD', val: `$${formatNumberIN(pendingUSD)}`, color: C.warning } : null,
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
// Each row in `invoice_payments` is ONE PAYMENT TRANCHE against an invoice.
// The table below is invoice-centric: it aggregates tranches, register TDS
// (tds_tcs_entries) and journal set-offs (invoice_setoffs) per invoice to show
// paid / TDS / set-off / pending — see computeInvoiceOutstanding.
//
// CHANGED (064): one payment can now cover several invoices of the same party
// (rows share payment_group_id + payment_ref), and our own pending sales to
// that party can be knocked off inside the same payment (saved as journal
// set-offs). TDS/TCS are no longer entered here — they are recorded per
// invoice in the TDS / TCS tab.
const EMPTY_PAY = {
  entity_id: '', party_entity_id: '',
  actual_payment_date: '', payment_ref: '',
  currency: 'INR', exchange_rate: '1',
  notes: '',
  lines: {},  // purchase invoice id → { checked, amount, adjustments }
  knock: {},  // our sales invoice id → { checked, amount }
}
const EMPTY_EDIT = {
  invoice_id: '', amount: '', adjustments: '0', adjustment_notes: '',
  actual_payment_date: '', payment_ref: '', currency: 'INR', exchange_rate: '1', notes: '',
}

function MiniLabel({ children }) {
  return <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>{children}</div>
}

function InvoicePaymentTracker() {
  const { profile } = useAuth()
  const [invoices, setInvoices] = useState([])
  const [payments, setPayments] = useState([])
  const [settlements, setSettlements] = useState(new Map())
  const [entities, setEntities] = useState([])
  // invpay_write is gated on has_entity_grant(entity_id) — entity_id is the
  // buyer/paying side, same "acting entity" concept used everywhere else.
  const { entities: accessEntities, frozen: toEntityLocked, defaultEntityId, loading: accessLoading } = useEntityAccess()
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen]   = useState(false)   // new (multi-invoice) payment
  const [editOpen, setEditOpen]     = useState(false)   // edit one tranche
  const [detailOpen, setDetailOpen] = useState(null) // invoice row for history panel
  const [editingPayment, setEditingPayment] = useState(null) // tranche row being edited
  const [form, setForm]         = useState(EMPTY_PAY)
  const [editForm, setEditForm] = useState(EMPTY_EDIT)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null) // tranche row to delete
  // status / from / to filters are multi-select — an empty array means "all".
  const [statusFilter, setStatusFilter]   = useState([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [fromEntityFilter, setFromEntityFilter] = useState([]) // seller
  const [toEntityFilter, setToEntityFilter]     = useState([]) // buyer
  const [toast, setToast]       = useState(null)

  const isAdmin = hasFullAccess(profile)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: invs }, { data: pays }, { data: es }, settle] = await Promise.all([
      // excludeAutoPurchaseMirrors — the auto-mirrored 'purchase' copy of an
      // internal sale must never be paid against (see utils/query.js).
      excludeAutoPurchaseMirrors(supabase.from('invoices')
        .select('id,invoice_no,invoice_date,due_date,total_amount,status,seller_entity_id,buyer_entity_id,seller:seller_entity_id(name,short_name),buyer:buyer_entity_id(name,short_name)')
        .eq('is_deleted', false).neq('status', 'cancelled').order('invoice_date', { ascending: false })),
      supabase.from('invoice_payments')
        .select('*')
        .eq('is_deleted', false).order('actual_payment_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      fetchSettlements(),
    ])
    setInvoices(invs || [])
    setPayments(pays || [])
    setEntities(es || [])
    setSettlements(groupSettlementsByInvoice(settle.tdsEntries, settle.setoffs))
    if (settle.error) setToast({ message: `TDS / set-off data could not be loaded: ${settle.error.message}`, type: 'error' })
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Default "To Entity" filter for non-admins: locked if they have exactly one entity, else a scoped dropdown.
  useEffect(() => {
    if (defaultEntityId && toEntityFilter.length === 0) setToEntityFilter([defaultEntityId])
  }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps

  const toEntityOptions = accessEntities
  const entityMap = useMemo(() => new Map(entities.map(e => [e.id, e])), [entities])
  const entName = id => entityMap.get(id)?.short_name || entityMap.get(id)?.name || '—'

  // ── Aggregate per invoice ───────────────────────────────────────────────────
  const paymentsByInvoice = useMemo(() => groupTranchesByInvoice(payments), [payments])

  const computed = useMemo(() => invoices.map(inv => {
    const tranches = (paymentsByInvoice.get(inv.id) || []).slice().sort((a, b) => (a.actual_payment_date || '').localeCompare(b.actual_payment_date || ''))
    const settle = settlementFor(settlements, inv.id)
    const { paidSum, tdsSum, adjSum, setoffSum, pending } = computeInvoiceOutstanding(inv, tranches, settle)
    const daysLeft = pending <= 0 ? 0 : calcInvDaysLeft(inv.due_date)
    const status = invStatus(daysLeft, pending)
    return { ...inv, _tranches: tranches, _settle: settle, _paid: paidSum, _tds: tdsSum, _adj: adjSum, _setoff: setoffSum, _pending: pending, _daysLeft: daysLeft, _status: status }
  }), [invoices, paymentsByInvoice, settlements])

  const computedById = useMemo(() => new Map(computed.map(c => [c.id, c])), [computed])

  // ── Filters ──────────────────────────────────────────────────────────────────
  const filtered = computed.filter(inv => {
    if (statusFilter.length > 0 && !statusFilter.includes(inv._status)) return false
    if (dateFrom && inv.invoice_date < dateFrom) return false
    if (dateTo && inv.invoice_date > dateTo) return false
    if (fromEntityFilter.length > 0 && !fromEntityFilter.includes(inv.seller_entity_id)) return false
    if (toEntityFilter.length > 0 && !toEntityFilter.includes(inv.buyer_entity_id)) return false
    // Hard restriction — non-admins never see invoices outside their entity access.
    if (!accessLoading && !accessEntities.some(e => e.id === inv.buyer_entity_id)) return false
    return true
  })

  const totalOutstanding = filtered.filter(r => r._status !== 'paid').reduce((s, r) => s + r._pending, 0)

  // ── New payment (multi-invoice + knock-off) ─────────────────────────────────
  // Invoices this payer owes the party, and our own sales to the party that can be knocked off.
  const payables = useMemo(() => (!form.entity_id || !form.party_entity_id) ? [] : computed
    .filter(i => i.buyer_entity_id === form.entity_id && i.seller_entity_id === form.party_entity_id && i._pending > 0 && i.status !== 'draft')
    .sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || '')),
  [computed, form.entity_id, form.party_entity_id])
  const knockables = useMemo(() => (!form.entity_id || !form.party_entity_id) ? [] : computed
    .filter(i => i.seller_entity_id === form.entity_id && i.buyer_entity_id === form.party_entity_id && i._pending > 0 && i.status !== 'draft')
    .sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || '')),
  [computed, form.entity_id, form.party_entity_id])

  // Parties this payer has pending invoices from — keeps the Party list short.
  const partyOptions = useMemo(() => {
    if (!form.entity_id) return []
    const ids = new Set(computed.filter(i => i.buyer_entity_id === form.entity_id && i._pending > 0).map(i => i.seller_entity_id))
    return entities.filter(e => ids.has(e.id))
  }, [computed, entities, form.entity_id])

  function setP(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'entity_id') { u.party_entity_id = ''; u.lines = {}; u.knock = {} }
      if (k === 'party_entity_id') { u.lines = {}; u.knock = {} }
      return u
    })
  }
  function setLine(id, patch) {
    setForm(f => {
      const prev = f.lines[id] || { checked: false, amount: '', adjustments: '' }
      const next = { ...prev, ...patch }
      if (patch.checked === true && !prev.amount) next.amount = String(computedById.get(id)?._pending || '')
      return { ...f, lines: { ...f.lines, [id]: next } }
    })
  }
  function setKnock(id, patch) {
    setForm(f => {
      const prev = f.knock[id] || { checked: false, amount: '' }
      const next = { ...prev, ...patch }
      if (patch.checked === true && !prev.amount) next.amount = String(computedById.get(id)?._pending || '')
      return { ...f, knock: { ...f.knock, [id]: next } }
    })
  }

  const chosenLines = payables.filter(i => form.lines[i.id]?.checked)
  const chosenKnock = knockables.filter(i => form.knock[i.id]?.checked)
  const settleTotal = round2(chosenLines.reduce((s, i) => s + toNum(form.lines[i.id].amount), 0))
  const adjTotal    = round2(chosenLines.reduce((s, i) => s + toNum(form.lines[i.id].adjustments), 0))
  const knockTotal  = round2(chosenKnock.reduce((s, i) => s + toNum(form.knock[i.id].amount), 0))
  const cashTotal   = round2(settleTotal - knockTotal)

  function openNew(invoiceRow) {
    setEditingPayment(null)
    if (invoiceRow) {
      setForm({
        ...EMPTY_PAY, entity_id: invoiceRow.buyer_entity_id || '', party_entity_id: invoiceRow.seller_entity_id || '',
        actual_payment_date: today(),
        lines: { [invoiceRow.id]: { checked: true, amount: String(invoiceRow._pending || 0), adjustments: '' } },
      })
    } else {
      setForm({ ...EMPTY_PAY, entity_id: defaultEntityId || '', actual_payment_date: today() })
    }
    setModalOpen(true)
  }

  async function handleSaveNew() {
    if (!form.entity_id) return setToast({ message: 'Select the paying entity', type: 'error' })
    if (!form.party_entity_id) return setToast({ message: 'Select the party being paid', type: 'error' })
    if (!form.actual_payment_date) return setToast({ message: 'Payment date is required', type: 'error' })
    if (chosenLines.length === 0) return setToast({ message: 'Tick at least one invoice to pay', type: 'error' })
    for (const i of chosenLines) {
      const l = form.lines[i.id]
      if (toNum(l.amount) <= 0 && toNum(l.adjustments) <= 0) return setToast({ message: `Enter an amount for ${i.invoice_no}`, type: 'error' })
      if (toNum(l.amount) + toNum(l.adjustments) > i._pending + 0.5) return setToast({ message: `${i.invoice_no}: amount is more than its pending ${formatINR(i._pending)}`, type: 'error' })
    }
    for (const i of chosenKnock) {
      const a = toNum(form.knock[i.id].amount)
      if (a <= 0) return setToast({ message: `Enter a knock-off amount for ${i.invoice_no}`, type: 'error' })
      if (a > i._pending + 0.5) return setToast({ message: `${i.invoice_no}: knock-off is more than its pending ${formatINR(i._pending)}`, type: 'error' })
    }
    if (knockTotal > settleTotal + 0.005) return setToast({ message: `Knock-off (${formatINR(knockTotal)}) can't be more than the invoices being paid (${formatINR(settleTotal)})`, type: 'error' })

    setSaving(true)
    const groupId = crypto.randomUUID()

    // Knock-off is used up against the ticked invoices in order; what's left on each is cash.
    let knockLeft = knockTotal
    const purchaseSetoff = chosenLines.map(i => {
      const take = round2(Math.min(toNum(form.lines[i.id].amount), knockLeft))
      knockLeft = round2(knockLeft - take)
      return { invoice_id: i.id, amount: take }
    })
    const pairs = pairSetoffs(chosenKnock.map(i => ({ invoice_id: i.id, amount: form.knock[i.id].amount })), purchaseSetoff)

    const rows = chosenLines.map((i, idx) => {
      const l = form.lines[i.id]
      const cash = round2(toNum(l.amount) - purchaseSetoff[idx].amount)
      return {
        invoice_id: i.id, entity_id: form.entity_id, party_entity_id: form.party_entity_id,
        invoice_no: i.invoice_no || null, invoice_date: i.invoice_date || null, due_date: i.due_date || null,
        currency: form.currency, exchange_rate: toNum(form.exchange_rate) || 1,
        amount: cash, adjustments: toNum(l.adjustments) || 0,
        actual_payment_date: form.actual_payment_date, notes: form.notes || null,
        payment_group_id: groupId, payment_ref: form.payment_ref || null,
        updated_at: new Date(),
      }
    }).filter(r => r.amount > 0 || r.adjustments > 0)

    if (rows.length) {
      const { error } = await supabase.from('invoice_payments').insert(rows)
      if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    }
    if (pairs.length) {
      const journalNo = await nextJournalNo(form.entity_id, entityMap.get(form.entity_id)?.short_name, form.actual_payment_date)
      const { error } = await supabase.from('invoice_setoffs').insert(pairs.map(p => ({
        ...p, journal_no: journalNo, journal_date: form.actual_payment_date,
        entity_id: form.entity_id, party_entity_id: form.party_entity_id,
        payment_group_id: groupId,
        notes: `Knocked off in payment${form.payment_ref ? ` ${form.payment_ref}` : ''}`,
      })))
      if (error) {
        // Undo the cash rows so the payment isn't left half-saved.
        if (rows.length) await supabase.from('invoice_payments').update({ is_deleted: true }).eq('payment_group_id', groupId)
        setSaving(false)
        return setToast({ message: `Payment not saved — knock-off failed: ${error.message}`, type: 'error' })
      }
    }
    const touched = [...chosenLines.map(i => i.id), ...chosenKnock.map(i => i.id)]
    const { error: syncErr } = await syncInvoicesPaymentStatus(touched)
    setSaving(false)
    if (syncErr) setToast({ message: `Payment saved, but an invoice status could not be updated: ${syncErr.message}`, type: 'error' })
    else setToast({ message: `Payment recorded against ${chosenLines.length} invoice${chosenLines.length > 1 ? 's' : ''}${pairs.length ? `, ${formatINR(knockTotal)} knocked off` : ''}`, type: 'success' })
    setModalOpen(false); load()
  }

  // ── Edit one tranche ────────────────────────────────────────────────────────
  function openEditPayment(payment, invoiceRow) {
    setEditingPayment({ ...payment, _ceiling: Math.max(0, roundRupees(invoiceRow._pending + toNum(payment.amount) + toNum(payment.adjustments))) })
    setEditForm({
      invoice_id: payment.invoice_id || invoiceRow.id,
      amount: String(toNum(payment.amount)),
      adjustments: payment.adjustments != null ? String(payment.adjustments) : '0',
      adjustment_notes: payment.adjustment_notes || '',
      actual_payment_date: payment.actual_payment_date || today(),
      payment_ref: payment.payment_ref || '',
      currency: payment.currency || 'INR',
      exchange_rate: payment.exchange_rate != null ? String(payment.exchange_rate) : '1',
      notes: payment.notes || '',
    })
    setEditOpen(true)
  }
  const setE = (k, v) => setEditForm(f => ({ ...f, [k]: v }))

  async function handleSaveEdit() {
    if (!editForm.actual_payment_date) return setToast({ message: 'Payment date is required', type: 'error' })
    if (toNum(editForm.amount) + toNum(editForm.adjustments) > toNum(editingPayment._ceiling) + 0.5)
      return setToast({ message: `More than the invoice's pending ${formatINR(editingPayment._ceiling)}`, type: 'error' })
    setSaving(true)
    // TDS/TCS columns on old rows are left exactly as they are (history only).
    const { error } = await supabase.from('invoice_payments').update({
      amount: round2(toNum(editForm.amount)),
      adjustments: toNum(editForm.adjustments) || 0, adjustment_notes: editForm.adjustment_notes || null,
      actual_payment_date: editForm.actual_payment_date, payment_ref: editForm.payment_ref || null,
      currency: editForm.currency, exchange_rate: toNum(editForm.exchange_rate) || 1,
      notes: editForm.notes || null, updated_at: new Date(),
    }).eq('id', editingPayment.id)
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    const { error: syncErr } = await syncInvoicePaymentStatus(editingPayment.invoice_id)
    setSaving(false)
    if (syncErr) setToast({ message: `Payment saved, but the invoice status could not be updated: ${syncErr.message}`, type: 'error' })
    else setToast({ message: 'Payment updated', type: 'success' })
    setEditOpen(false); load()
  }

  async function handleDeletePayment() {
    await supabase.from('invoice_payments').update({ is_deleted: true }).eq('id', confirmDelete.id)
    // Removing a tranche re-derives the invoice's payment status.
    await syncInvoicePaymentStatus(confirmDelete.invoice_id)
    setConfirmDelete(null); load()
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '10px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', whiteSpace: 'nowrap' }
  const td = { padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, fontSize: '12px', verticalAlign: 'middle' }
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Outstanding' value={formatINR(totalOutstanding)} color={totalOutstanding > 0 ? C.warning : C.success} />
        <StatCard label='Overdue'     value={filtered.filter(r => r._status === 'overdue').length} color={filtered.filter(r => r._status === 'overdue').length > 0 ? C.danger : C.success} />
        <StatCard label='Paid'        value={filtered.filter(r => r._status === 'paid').length} color={C.success} />
        <StatCard label='Total'       value={filtered.length} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: '130px' }}><FormRow label='From Date'><Input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></FormRow></div>
        <div style={{ width: '130px' }}><FormRow label='To Date'><Input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} /></FormRow></div>
        <div style={{ width: '160px' }}>
          <FormRow label='From Entity (seller)'>
            <MultiSelectDropdown options={entities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={fromEntityFilter} onChange={setFromEntityFilter} placeholder='All' capitalize={false} style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ width: '160px' }}>
          <FormRow label='To Entity (buyer)'>
            <MultiSelectDropdown options={toEntityOptions.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={toEntityFilter} onChange={setToEntityFilter} placeholder={isAdmin ? 'All' : 'All accessible'} capitalize={false} disabled={toEntityLocked} style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ width: '140px' }}>
          <FormRow label='Status'>
            <MultiSelectDropdown options={[{ value: 'pending', label: 'Pending' }, { value: 'due_soon', label: 'Due Soon' }, { value: 'overdue', label: 'Overdue' }, { value: 'paid', label: 'Paid' }]} selected={statusFilter} onChange={setStatusFilter} placeholder='All' style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' onClick={() => { if (!exportRows('invoice_payments', filtered)) setToast({ message: 'Nothing to export', type: 'error' }) }}>↓ Export CSV</Btn>
        <Btn onClick={() => openNew()}>+ Add Payment</Btn>
      </div>

      <Card>
        {loading ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        : filtered.length === 0 ? <EmptyState icon='💳' title='No invoices found' action={<Btn onClick={() => openNew()}>+ Add Payment</Btn>} />
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1250px' }}>
              <thead><tr>
                {['#','Invoice No','Date','From','To','Invoice Amt','Paid','TDS','Set-off','Pending','Due','Days Left','Status',''].map((h,i) => (
                  <th key={i} style={{ ...th, textAlign: i >= 5 && i <= 9 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.id} style={{ background: r._status === 'overdue' ? '#fff5f5' : r._status === 'due_soon' ? '#fffdf0' : i % 2 === 0 ? C.surface : '#faf6ed', cursor: 'pointer' }}
                    onClick={() => setDetailOpen(r)}>
                    <td style={{ ...td, color: C.textMuted }}>{i+1}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{r.invoice_no || '—'}</td>
                    <td style={td}>{fmtDate(r.invoice_date)}</td>
                    <td style={td}>{r.seller?.short_name || r.seller?.name || '—'}</td>
                    <td style={td}>{r.buyer?.short_name || r.buyer?.name || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}><AmtCell amount={r.total_amount} currency='INR' /></td>
                    <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={r._paid} currency='INR' /></td>
                    <td style={{ ...td, textAlign: 'right', color: C.textSoft }}><AmtCell amount={r._tds} currency='INR' /></td>
                    <td style={{ ...td, textAlign: 'right', color: C.textSoft }}><AmtCell amount={r._setoff} currency='INR' /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r._pending > 0 ? C.warning : C.success }}><AmtCell amount={r._pending} currency='INR' /></td>
                    <td style={td}>{fmtDate(r.due_date)}</td>
                    <td style={td}><DaysLeft days={r._daysLeft} paid={r._status === 'paid'} /></td>
                    <td style={td}><StatusPill status={r._status} /></td>
                    <td style={td} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {r._status !== 'paid' && <Btn size='sm' variant='success' onClick={() => openNew(r)}>+ Pay</Btn>}
                        <Btn size='sm' variant='ghost' onClick={() => setDetailOpen(r)}>View</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Invoice detail — payments, TDS/TCS and set-offs */}
      <Modal open={!!detailOpen} onClose={() => setDetailOpen(null)} title={`Payment History — ${detailOpen?.invoice_no || ''}`} width={820}>
        {detailOpen && (() => {
          const inv = computedById.get(detailOpen.id) || detailOpen
          const tdsRows = (inv._settle?.tdsEntries || [])
          const setoffRows = (inv._settle?.setoffs || [])
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '8px', fontSize: '13px' }}>
                <div><MiniLabel>Invoice</MiniLabel><strong>{formatINR(inv.total_amount)}</strong></div>
                <div><MiniLabel>Paid + Adj.</MiniLabel><strong>{formatINR(inv._paid + inv._adj)}</strong></div>
                <div><MiniLabel>TDS</MiniLabel><strong>{formatINR(inv._tds)}</strong></div>
                <div><MiniLabel>Set-off</MiniLabel><strong>{formatINR(inv._setoff)}</strong></div>
                <div><MiniLabel>Pending</MiniLabel><strong style={{ color: inv._pending > 0 ? C.danger : C.success }}>{formatINR(inv._pending)}</strong></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: C.text }}>Payments ({inv._tranches.length})</div>
                {inv._pending > 0 && <Btn size='sm' onClick={() => { setDetailOpen(null); openNew(inv) }}>+ Add Payment</Btn>}
              </div>
              {inv._tranches.length === 0 ? (
                <div style={{ fontSize: '12px', color: C.textMuted }}>No payments recorded yet against this invoice.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      {['Date','Paid','Adj.','Reference','Notes','Docs',''].map((h,i) => (
                        <th key={i} style={{ ...th, textAlign: i === 1 || i === 2 ? 'right' : 'left' }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {inv._tranches.map(t => (
                        <tr key={t.id}>
                          <td style={td}>{fmtDate(t.actual_payment_date)}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}><AmtCell amount={t.amount} currency='INR' /></td>
                          <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={t.adjustments} currency='INR' /></td>
                          <td style={td}>{t.payment_ref || '—'}{t.payment_group_id && payments.filter(p => p.payment_group_id === t.payment_group_id).length > 1 ? <span style={{ color: C.textMuted }}> · multi-invoice</span> : null}</td>
                          <td style={{ ...td, maxWidth: '160px' }}>{t.notes || '—'}</td>
                          <td style={td}><DocumentAttachments sourceType='invoice_payments' sourceId={t.id} entityName={inv.buyer?.name || 'General'} compact /></td>
                          <td style={td}>
                            <div style={{ display: 'flex', gap: '4px' }}>
                              <Btn size='xs' variant='ghost' onClick={() => { setDetailOpen(null); openEditPayment(t, inv) }}>Edit</Btn>
                              <Btn size='xs' variant='ghost' onClick={() => setConfirmDelete(t)} style={{ color: C.danger }}>Del</Btn>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {tdsRows.length > 0 && (
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: C.text, marginBottom: '6px' }}>TDS / TCS <span style={{ fontWeight: 400, color: C.textMuted, fontSize: '12px' }}>— edit in the TDS / TCS tab</span></div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>{['Type','Section','Rate %','Base','Amount','Date'].map((h,i) => <th key={i} style={{ ...th, textAlign: i >= 2 && i <= 4 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
                    <tbody>{tdsRows.map(e => (
                      <tr key={e.id}>
                        <td style={td}>{(e.entry_type || '').toUpperCase()}</td>
                        <td style={td}>{e.section_code}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{toNum(e.rate)}</td>
                        <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={e.base_amount} currency='INR' /></td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}><AmtCell amount={e.amount} currency='INR' /></td>
                        <td style={td}>{fmtDate(e.entry_date)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {setoffRows.length > 0 && (
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: C.text, marginBottom: '6px' }}>Set-offs <span style={{ fontWeight: 400, color: C.textMuted, fontSize: '12px' }}>— edit in the Journal tab</span></div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>{['Journal No','Date','Against','Amount'].map((h,i) => <th key={i} style={{ ...th, textAlign: i === 3 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
                    <tbody>{setoffRows.map(o => {
                      const otherId = o.sales_invoice_id === inv.id ? o.purchase_invoice_id : o.sales_invoice_id
                      return (
                        <tr key={o.id}>
                          <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{o.journal_no}</td>
                          <td style={td}>{fmtDate(o.journal_date)}</td>
                          <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{computedById.get(otherId)?.invoice_no || '—'}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}><AmtCell amount={o.amount} currency='INR' /></td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })()}
      </Modal>

      {/* New payment — one or more invoices of one party, with optional knock-off */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='Add Payment' width={820}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Paying Entity (buyer)' required hint={toEntityLocked ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.entity_id} onChange={e => setP('entity_id', e.target.value)} disabled={toEntityLocked}>
                <option value=''>Select</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Party being paid (seller)' required hint={form.entity_id && partyOptions.length === 0 ? 'No pending invoices for this entity.' : undefined}>
              <Select value={form.party_entity_id} onChange={e => setP('party_entity_id', e.target.value)} disabled={!form.entity_id}>
                <option value=''>Select</option>
                {(partyOptions.some(p => p.id === form.party_entity_id) || !form.party_entity_id ? partyOptions : [...partyOptions, entityMap.get(form.party_entity_id)].filter(Boolean))
                  .map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Payment Date' required><Input type='date' value={form.actual_payment_date} onChange={e => setP('actual_payment_date', e.target.value)} /></FormRow>
            <FormRow label='Reference (UTR / cheque no)'><Input value={form.payment_ref} onChange={e => setP('payment_ref', e.target.value)} /></FormRow>
            <FormRow label='Currency'><Select value={form.currency} onChange={e => setP('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></FormRow>
          </div>

          {form.entity_id && form.party_entity_id && (
            <>
              <PickTable title={`Invoices to pay — ${entName(form.party_entity_id)} → ${entName(form.entity_id)}`} list={payables} state={form.lines} onChange={setLine} showAdj />
              <PickTable title={`Knock off our sales — ${entName(form.entity_id)} → ${entName(form.party_entity_id)} (optional)`} list={knockables} state={form.knock} onChange={setKnock} />
            </>
          )}

          {settleTotal > 0 && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', display: 'grid', gridTemplateColumns: `repeat(${adjTotal > 0 ? 4 : 3},1fr)`, gap: '8px', fontSize: '13px' }}>
              <div><MiniLabel>Invoices settled</MiniLabel><strong>{formatINR(settleTotal)}</strong></div>
              <div><MiniLabel>Knock-off</MiniLabel><strong style={{ color: knockTotal > settleTotal ? C.danger : C.warning }}>− {formatINR(knockTotal)}</strong></div>
              {adjTotal > 0 && <div><MiniLabel>Adjustments</MiniLabel><strong>{formatINR(adjTotal)}</strong></div>}
              <div><MiniLabel>Cash to pay</MiniLabel><strong style={{ color: cashTotal < 0 ? C.danger : C.success }}>{formatINR(cashTotal)}</strong></div>
            </div>
          )}

          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setP('notes', e.target.value)} rows={2} /></FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSaveNew} disabled={saving}>{saving ? 'Saving…' : 'Record Payment'}</Btn>
          </div>
        </div>
      </Modal>

      {/* Edit one tranche */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Edit Payment — ${editingPayment?.invoice_no || ''}`} width={600}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Amount Paid' required hint={editingPayment ? `Up to ${formatINR(editingPayment._ceiling)} including adjustments` : undefined}>
              <Input type='number' value={editForm.amount} onChange={e => setE('amount', e.target.value)} />
            </FormRow>
            <FormRow label='Payment Date' required><Input type='date' value={editForm.actual_payment_date} onChange={e => setE('actual_payment_date', e.target.value)} /></FormRow>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Reference (UTR / cheque no)'><Input value={editForm.payment_ref} onChange={e => setE('payment_ref', e.target.value)} /></FormRow>
            <FormRow label='Currency'><Select value={editForm.currency} onChange={e => setE('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></FormRow>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Adjustments'><Input type='number' value={editForm.adjustments} onChange={e => setE('adjustments', e.target.value)} placeholder='0' /></FormRow>
            <FormRow label='Adj. Notes'><Input value={editForm.adjustment_notes} onChange={e => setE('adjustment_notes', e.target.value)} /></FormRow>
          </div>
          {toNum(editingPayment?.tds_amount) > 0 && (
            <div style={{ fontSize: '12px', color: C.textMuted }}>This older payment carried TDS of {formatINR(editingPayment.tds_amount)}. It now sits in the TDS / TCS register for this invoice.</div>
          )}
          <FormRow label='Notes'><Textarea value={editForm.notes} onChange={e => setE('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setEditOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSaveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDeletePayment}
        title='Delete Payment' message={confirmDelete?.payment_group_id
          ? 'Delete this payment line? Other invoices paid in the same payment, and any knock-off made with it, stay as they are (knock-offs are removed from the Journal tab).'
          : 'Delete this payment tranche? This cannot be undone.'} danger />
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
  // CHANGED: exppay_write is gated on has_entity_grant(from_entity_id) — the
  // entity actually making the payment.
  const { entities: accessEntities, frozen: fromEntityFrozen, defaultEntityId } = useEntityAccess()
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
  // CHANGED: multi-select filters — an empty array means "all".
  const [statusFilter, setStatusFilter]   = useState([])
  const [categoryFilter, setCategoryFilter] = useState([])
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: rs }, { data: es }, { data: invs }, { data: piData }] = await Promise.all([
      supabase.from('expense_payments')
        .select('*, from_entity:from_entity_id(name,short_name), to_entity:to_entity_id(name,short_name), linked_invoice:linked_invoice_id(invoice_no), linked_pi:linked_pi_id(pi_no)')
        .eq('is_deleted', false).order('created_at', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      // CHANGED: excludeAutoPurchaseMirrors — a "link to invoice" dropdown
      // shouldn't offer the phantom auto-mirror copies (see utils/query.js).
      excludeAutoPurchaseMirrors(supabase.from('invoices').select('id,invoice_no').eq('is_deleted', false).neq('status','cancelled').order('invoice_date', { ascending: false })),
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

  function openNew()   { setEditing(null); setForm({ ...EMPTY_EXP, from_entity_id: defaultEntityId }); setModalOpen(true) }
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
    const ms = statusFilter.length === 0 || statusFilter.includes(r._status)
    const mc = categoryFilter.length === 0 || categoryFilter.includes(r.expense_category)
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
        <MultiSelectDropdown options={EXPENSE_STATUSES} selected={statusFilter} onChange={setStatusFilter} placeholder='All statuses' />
        <MultiSelectDropdown options={EXPENSE_CATEGORIES} selected={categoryFilter} onChange={setCategoryFilter} placeholder='All categories' capitalize={false} />
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' onClick={() => { if (!exportRows('expense_payments', filtered)) setToast({ message: 'Nothing to export', type: 'error' }) }}>↓ Export CSV</Btn>
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
            <FormRow label='From (in system)' hint={fromEntityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.from_entity_id} onChange={e => setF('from_entity_id', e.target.value)} disabled={fromEntityFrozen}>
                <option value=''>Select</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
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

// ─── Entity Payment Ledger ──────────────────────────────────────────────────
// Per-entity running ledger merging standalone (non-invoice) entity_payments
// entries with invoice_payments tranches — including tranches where the
// entity is the SELLER being paid (party_entity_id match), not just the
// buyer, so the ledger is complete for entities that both buy and sell. See
// buildEntityLedger (utils/payments.js) for the merge/balance logic itself.
const ENTPAY_CATEGORIES = ['Advance', 'Loan', 'Capital Infusion', 'Refund', 'Bank Transfer', 'Other']

const EMPTY_ENTPAY = {
  entity_id: '', party_entity_id: '', party_name: '',
  direction: 'paid', category: '', currency: 'INR', exchange_rate: '1',
  amount: '', reference_no: '', actual_payment_date: '', notes: '',
}

function EntityPaymentLedger() {
  // CHANGED: entpay_write is gated on has_entity_grant(entity_id) — the
  // entity whose book this entry is recorded under, same "acting entity"
  // concept as InvoicePaymentTracker's "To Entity".
  const { entities: accessEntities, frozen, defaultEntityId, loading: accessLoading } = useEntityAccess()
  const [selectedEntity, setSelectedEntity] = useState('')
  const [entityPayments, setEntityPayments] = useState([])
  const [invoicePayments, setInvoicePayments] = useState([])
  const [entities, setEntities] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_ENTPAY)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [toast, setToast] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: eps }, { data: ips }, { data: es }] = await Promise.all([
      supabase.from('entity_payments').select('*')
        .eq('is_deleted', false).order('actual_payment_date', { ascending: true }),
      supabase.from('invoice_payments')
        .select('id,invoice_id,invoice_no,entity_id,party_entity_id,party_name,amount,tcs_amount,currency,actual_payment_date,notes')
        .eq('is_deleted', false).order('actual_payment_date', { ascending: true }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
    ])
    setEntityPayments(eps || [])
    setInvoicePayments(ips || [])
    setEntities(es || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (defaultEntityId && !selectedEntity) setSelectedEntity(defaultEntityId) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps

  const entityMap = useMemo(() => new Map(entities.map(e => [e.id, e])), [entities])

  const ledger = useMemo(
    () => selectedEntity ? buildEntityLedger(selectedEntity, { entityPayments, invoicePayments }) : [],
    [selectedEntity, entityPayments, invoicePayments]
  )
  const filteredLedger = ledger.filter(r => (!dateFrom || r.date >= dateFrom) && (!dateTo || r.date <= dateTo))
  const totalIn  = filteredLedger.filter(r => r.inbound).reduce((s, r) => s + r.amount, 0)
  const totalOut = filteredLedger.filter(r => !r.inbound).reduce((s, r) => s + r.amount, 0)
  const closingBalance = filteredLedger.length ? filteredLedger[filteredLedger.length - 1].runningBalance : 0

  function setF(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'party_entity_id' && v) u.party_name = ''
      return u
    })
  }

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY_ENTPAY, entity_id: selectedEntity || defaultEntityId, actual_payment_date: today() })
    setModalOpen(true)
  }

  function openEdit(row) {
    const p = row.raw
    setEditing(p)
    setForm({
      entity_id: p.entity_id || '', party_entity_id: p.party_entity_id || '', party_name: p.party_name || '',
      direction: p.direction || 'paid', category: p.category || '',
      currency: p.currency || 'INR', exchange_rate: p.exchange_rate != null ? String(p.exchange_rate) : '1',
      amount: p.amount != null ? String(p.amount) : '', reference_no: p.reference_no || '',
      actual_payment_date: p.actual_payment_date || '', notes: p.notes || '',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.entity_id) return setToast({ message: 'Select an entity', type: 'error' })
    if (!toNum(form.amount)) return setToast({ message: 'Amount is required', type: 'error' })
    if (!form.actual_payment_date) return setToast({ message: 'Payment date is required', type: 'error' })
    setSaving(true)
    const payload = {
      entity_id: form.entity_id, party_entity_id: form.party_entity_id || null,
      party_name: form.party_name || null, direction: form.direction,
      category: form.category || null, currency: form.currency,
      exchange_rate: toNum(form.exchange_rate) || 1, amount: toNum(form.amount),
      reference_no: form.reference_no || null, actual_payment_date: form.actual_payment_date,
      notes: form.notes || null, updated_at: new Date(),
    }
    let error
    if (editing) { const r = await supabase.from('entity_payments').update(payload).eq('id', editing.id); error = r.error }
    else         { const r = await supabase.from('entity_payments').insert(payload); error = r.error }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'Entry updated' : 'Entry recorded', type: 'success' })
    setModalOpen(false); load()
  }

  async function handleDelete() {
    await supabase.from('entity_payments').update({ is_deleted: true }).eq('id', confirmDelete.raw.id)
    setConfirmDelete(null); load()
  }

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '10px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', whiteSpace: 'nowrap' }
  const td = { padding: '9px 12px', borderBottom: `1px solid #f0e8d8`, fontSize: '12px', verticalAlign: 'middle' }

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: '180px' }}>
          <FormRow label='Entity' hint={frozen ? 'Locked to the only entity you have access to' : undefined}>
            <Select value={selectedEntity} onChange={e => setSelectedEntity(e.target.value)} disabled={frozen}>
              <option value=''>Select entity</option>
              {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
            </Select>
          </FormRow>
        </div>
        <div style={{ width: '130px' }}><FormRow label='From Date'><Input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></FormRow></div>
        <div style={{ width: '130px' }}><FormRow label='To Date'><Input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} /></FormRow></div>
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' onClick={() => { if (!exportRows('entity_ledger', filteredLedger)) setToast({ message: 'Nothing to export', type: 'error' }) }}>↓ Export CSV</Btn>
        <Btn onClick={() => openNew()} disabled={!selectedEntity}>+ Add Entry</Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Total In'        value={formatINR(totalIn)} color={C.success} />
        <StatCard label='Total Out'       value={formatINR(totalOut)} color={C.warning} />
        <StatCard label='Closing Balance' value={formatINR(closingBalance)} color={closingBalance >= 0 ? C.success : C.danger} />
        <StatCard label='Entries'         value={filteredLedger.length} />
      </div>

      <Card>
        {!selectedEntity ? (
          <EmptyState icon='📒' title='Select an entity to view its ledger' />
        ) : loading || accessLoading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        ) : filteredLedger.length === 0 ? (
          <EmptyState icon='📒' title='No entries found' action={<Btn onClick={() => openNew()}>+ Add Entry</Btn>} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ padding: '10px 12px', fontSize: '11px', color: C.textMuted }}>Balance sums amounts at face value — does not FX-convert mixed currencies.</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1100px' }}>
              <thead><tr>
                {['#','Date','Type','Counterparty','In','Out','Running Balance','Ref / Invoice','Notes',''].map((h,i) => (
                  <th key={i} style={{ ...th, textAlign: i >= 4 && i <= 6 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {filteredLedger.map((r, i) => (
                  <tr key={r.id} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={{ ...td, color: C.textMuted }}>{i+1}</td>
                    <td style={td}>{fmtDate(r.date)}</td>
                    <td style={td}>
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', background: r.source === 'entity_payment' ? '#ede8f3' : '#e8f0f3', color: r.source === 'entity_payment' ? '#3a1a6a' : '#1a4a6a' }}>
                        {r.source === 'entity_payment' ? 'Standalone' : 'Invoice Settlement'}
                      </span>
                    </td>
                    <td style={td}>{entityMap.get(r.counterpartyId)?.short_name || entityMap.get(r.counterpartyId)?.name || r.counterpartyName || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', color: C.success, fontWeight: r.inbound ? 600 : 400 }}>{r.inbound ? <AmtCell amount={r.amount} currency={r.currency} /> : '—'}</td>
                    <td style={{ ...td, textAlign: 'right', color: C.warning, fontWeight: !r.inbound ? 600 : 400 }}>{!r.inbound ? <AmtCell amount={r.amount} currency={r.currency} /> : '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r.runningBalance >= 0 ? C.success : C.danger }}><AmtCell amount={r.runningBalance} currency='INR' /></td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{r.source === 'entity_payment' ? (r.raw.reference_no || '—') : (r.invoiceNo || '—')}</td>
                    <td style={{ ...td, maxWidth: '160px' }}>{r.notes || '—'}</td>
                    <td style={td}>
                      {r.source === 'entity_payment' ? (
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <Btn size='xs' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
                          <Btn size='xs' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Del</Btn>
                        </div>
                      ) : (
                        <span style={{ fontSize: '11px', color: C.textMuted }}>via Invoice Payments</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Entry' : 'Add Entity Payment'} width={640}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <SectionDivider label='Entity & Direction' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Entity' hint={frozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)} disabled={frozen}>
                <option value=''>Select</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Direction'>
              <Select value={form.direction} onChange={e => setF('direction', e.target.value)}>
                <option value='paid'>Paid (cash out)</option>
                <option value='received'>Received (cash in)</option>
              </Select>
            </FormRow>
          </div>

          <SectionDivider label='Counterparty' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Party (in-system)'>
              <Select value={form.party_entity_id} onChange={e => setF('party_entity_id', e.target.value)}>
                <option value=''>Any</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Party Name (if not in system)'>
              <Input value={form.party_name} onChange={e => setF('party_name', e.target.value)} disabled={!!form.party_entity_id} />
            </FormRow>
          </div>

          <SectionDivider label='Amount' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Category'>
              <Select value={form.category} onChange={e => setF('category', e.target.value)}>
                <option value=''>Select</option>
                {ENTPAY_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Currency'><Select value={form.currency} onChange={e => setF('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></FormRow>
            <FormRow label='Amount' required><Input type='number' value={form.amount} onChange={e => setF('amount', e.target.value)} /></FormRow>
            <FormRow label='Reference No'><Input value={form.reference_no} onChange={e => setF('reference_no', e.target.value)} /></FormRow>
          </div>

          <SectionDivider label='Date & Notes' />
          <FormRow label='Payment Date' required><Input type='date' value={form.actual_payment_date} onChange={e => setF('actual_payment_date', e.target.value)} /></FormRow>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Record Entry'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Entry' message='Delete this entry? This cannot be undone.' danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Shell ────────────────────────────────────────────────────────────────────
export default function Payments() {
  // CHANGED: ?tab=expense deep-links straight to the Expense Payments tab
  // (e.g. from a notification's source link) — read once on mount so a
  // manual tab click afterwards isn't fighting the URL.
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState(searchParams.get('tab') === 'expense' ? 'Expense Payments' : 'Invoice Payments')
  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: C.text, margin: 0 }}>Payments</h1>
        <p style={{ fontSize: '13px', color: C.textMuted, margin: '4px 0 0' }}>Track invoice and expense payments, TDS / TCS and journal set-offs</p>
      </div>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `2px solid ${C.border}` }}>
        {['Invoice Payments', 'TDS / TCS', 'Journal', 'Expense Payments', 'Entity Ledger'].map(t => (
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
      {tab === 'TDS / TCS' && <TdsRegister />}
      {tab === 'Journal' && <Journal />}
      {tab === 'Expense Payments' && <ExpensePaymentTracker />}
      {tab === 'Entity Ledger' && <EntityPaymentLedger />}
    </div>
  )
}
