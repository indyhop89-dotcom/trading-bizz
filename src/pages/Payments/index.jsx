import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Modal, ConfirmModal, Toast, EmptyState,
  Card, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import DocumentAttachments from '../../components/DocumentAttachments'
import { formatINR, formatNumberIN, toNum, roundRupees } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { useAuth } from '../../hooks/useAuth'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { hasFullAccess } from '../../utils/roles'
import { computeInvoiceOutstanding, syncInvoicePaymentStatus } from '../../utils/payments'
import { excludeAutoPurchaseMirrors } from '../../utils/query'

// ─── TDS / TCS constants ────────────────────────────────────────────────────────
// CHANGED: §206C (TCS on sale of goods) was previously listed here as a "TDS
// section" — it's TCS, a distinct withholding a SELLER collects from a buyer,
// not tax a payer deducts. Split into its own section list so the two are
// never conflated in the UI or the saved data.
const TDS_SECTIONS = ['194C', '194H', '194I', '194J', '194Q']
const TDS_SECTION_LABELS = {
  '194C': 'Payment to Contractors',
  '194H': 'Commission or Brokerage',
  '194I': 'Rent',
  '194J': 'Professional/Technical Services',
  '194Q': 'Purchase of Goods',
}
const TDS_DEFAULT_RATES = {
  '194C': 1, '194H': 5, '194I': 10, '194J': 10, '194Q': 0.1,
}
const TCS_SECTIONS = ['206C']
const TCS_SECTION_LABELS = { '206C': 'TCS on Sale of Goods' }
const TCS_DEFAULT_RATES = { '206C': 0.1 }

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

function computeTds(base, rate) {
  return roundRupees((toNum(base) * toNum(rate)) / 100)
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
// Each row in `invoice_payments` is now ONE PAYMENT TRANCHE against an invoice
// (not a snapshot of the whole invoice). The table below is invoice-centric:
// it aggregates all tranches per invoice to show paid / TDS / pending.
const EMPTY_INV = {
  invoice_id: '', entity_id: '', party_entity_id: '', party_name: '',
  invoice_no: '', invoice_date: '', due_date: '',
  currency: 'INR', exchange_rate: '1',
  basis: '',                 // gross amount being settled by this tranche (defaults to pending)
  apply_tds: false, tds_section: '', tds_rate: '',
  apply_tcs: false, tcs_section: '', tcs_rate: '', // CHANGED: TCS at payment time
  adjustments: '0', adjustment_notes: '',
  actual_payment_date: '', notes: '',
}

function InvoicePaymentTracker() {
  const { profile } = useAuth()
  const [invoices, setInvoices] = useState([])
  const [payments, setPayments] = useState([])
  const [entities, setEntities] = useState([])
  // CHANGED: replaces the bespoke accessEntityIds state below with the shared
  // hook — invpay_write is gated on has_entity_grant(entity_id), and
  // entity_id here is the buyer/paying side, same "acting entity" concept
  // used everywhere else.
  const { entities: accessEntities, frozen: toEntityLocked, defaultEntityId, loading: accessLoading } = useEntityAccess()
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen]   = useState(false)
  const [detailOpen, setDetailOpen] = useState(null) // invoice row for tranche-history panel
  const [editingPayment, setEditingPayment] = useState(null) // tranche row being edited
  const [form, setForm]         = useState(EMPTY_INV)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null) // tranche row to delete
  const [statusFilter, setStatusFilter]   = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [fromEntityFilter, setFromEntityFilter] = useState('') // seller
  const [toEntityFilter, setToEntityFilter]     = useState('') // buyer
  const [toast, setToast]       = useState(null)

  const isAdmin = hasFullAccess(profile)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: invs }, { data: pays }, { data: es }] = await Promise.all([
      // CHANGED: excludeAutoPurchaseMirrors — without it, every internal
      // buyer/seller pair's auto-mirrored 'purchase' copy (see utils/query.js)
      // showed up here as its own phantom payable/receivable, alongside the
      // real invoice — someone could record a real payment against the
      // wrong (mirror) row and leave the actual invoice looking unpaid.
      excludeAutoPurchaseMirrors(supabase.from('invoices')
        .select('id,invoice_no,invoice_date,due_date,total_amount,status,seller_entity_id,buyer_entity_id,seller:seller_entity_id(name,short_name),buyer:buyer_entity_id(name,short_name)')
        .eq('is_deleted', false).neq('status', 'cancelled').order('invoice_date', { ascending: false })),
      supabase.from('invoice_payments')
        .select('*')
        .eq('is_deleted', false).order('actual_payment_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
    ])
    setInvoices(invs || [])
    setPayments(pays || [])
    setEntities(es || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Default "To Entity" filter for non-admins: locked if they have exactly one entity, else a scoped dropdown.
  useEffect(() => {
    if (defaultEntityId && !toEntityFilter) setToEntityFilter(defaultEntityId)
  }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps

  const toEntityOptions = accessEntities

  // ── Aggregate tranches per invoice ──────────────────────────────────────────
  const paymentsByInvoice = useMemo(() => {
    const map = new Map()
    for (const p of payments) {
      if (!p.invoice_id) continue
      if (!map.has(p.invoice_id)) map.set(p.invoice_id, [])
      map.get(p.invoice_id).push(p)
    }
    return map
  }, [payments])

  const computed = useMemo(() => invoices.map(inv => {
    const tranches = (paymentsByInvoice.get(inv.id) || []).slice().sort((a, b) => (a.actual_payment_date || '').localeCompare(b.actual_payment_date || ''))
    const { paidSum, tdsSum, adjSum, pending } = computeInvoiceOutstanding(inv, tranches)
    const daysLeft = pending <= 0 ? 0 : calcInvDaysLeft(inv.due_date)
    const status = invStatus(daysLeft, pending)
    return { ...inv, _tranches: tranches, _paid: paidSum, _tds: tdsSum, _adj: adjSum, _pending: pending, _daysLeft: daysLeft, _status: status }
  }), [invoices, paymentsByInvoice])

  // ── Filters ──────────────────────────────────────────────────────────────────
  const filtered = computed.filter(inv => {
    if (statusFilter !== 'all' && inv._status !== statusFilter) return false
    if (dateFrom && inv.invoice_date < dateFrom) return false
    if (dateTo && inv.invoice_date > dateTo) return false
    if (fromEntityFilter && inv.seller_entity_id !== fromEntityFilter) return false
    if (toEntityFilter && inv.buyer_entity_id !== toEntityFilter) return false
    // Hard restriction — non-admins never see invoices outside their entity access, filter or no filter.
    // accessEntities is the full active-entities list for master, so this is
    // a no-op restriction for them and a real one for everyone else. Skipped
    // while the access grants are still loading, so nothing briefly flashes
    // to empty on first render.
    if (!accessLoading && !accessEntities.some(e => e.id === inv.buyer_entity_id)) return false
    return true
  })

  const totalOutstanding = filtered.filter(r => r._status !== 'paid').reduce((s, r) => s + r._pending, 0)

  // ── Add / Edit payment modal ────────────────────────────────────────────────
  function setF(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'entity_id' || k === 'party_entity_id') u.invoice_id = ''
      if (k === 'invoice_id' && v) {
        const inv = computed.find(i => i.id === v)
        if (inv) {
          u.invoice_no = inv.invoice_no || ''
          u.invoice_date = inv.invoice_date || ''
          u.due_date = inv.due_date || ''
          u.entity_id = inv.buyer_entity_id || u.entity_id
          u.party_entity_id = inv.seller_entity_id || u.party_entity_id
          u.basis = String(inv._pending || 0)
        }
      }
      if (k === 'tds_section') u.tds_rate = TDS_DEFAULT_RATES[v] != null ? String(TDS_DEFAULT_RATES[v]) : u.tds_rate
      if (k === 'tcs_section') u.tcs_rate = TCS_DEFAULT_RATES[v] != null ? String(TCS_DEFAULT_RATES[v]) : u.tcs_rate
      return u
    })
  }

  // invoices available to link, scoped to chosen buyer/seller in the form
  const invoiceOptions = computed.filter(inv => {
    if (form.entity_id && inv.buyer_entity_id !== form.entity_id) return false
    if (form.party_entity_id && inv.seller_entity_id !== form.party_entity_id) return false
    return true
  })

  function openNew(invoiceRow) {
    setEditingPayment(null)
    if (invoiceRow) {
      setForm({
        ...EMPTY_INV,
        invoice_id: invoiceRow.id, entity_id: invoiceRow.buyer_entity_id || '', party_entity_id: invoiceRow.seller_entity_id || '',
        invoice_no: invoiceRow.invoice_no || '', invoice_date: invoiceRow.invoice_date || '', due_date: invoiceRow.due_date || '',
        basis: String(invoiceRow._pending || 0), actual_payment_date: today(),
      })
    } else {
      setForm({ ...EMPTY_INV, entity_id: defaultEntityId, actual_payment_date: today() })
    }
    setModalOpen(true)
  }

  function openEditPayment(payment, invoiceRow) {
    setEditingPayment(payment)
    // Pending as if this tranche didn't exist yet — the ceiling this tranche can settle up to.
    const otherSettled = (invoiceRow._paid + invoiceRow._tds + invoiceRow._adj) - (toNum(payment.amount) + toNum(payment.tds_amount) + toNum(payment.adjustments))
    const ceiling = Math.max(0, roundRupees(toNum(invoiceRow.total_amount) - otherSettled))
    setForm({
      invoice_id: payment.invoice_id || invoiceRow.id,
      entity_id: payment.entity_id || invoiceRow.buyer_entity_id || '',
      party_entity_id: payment.party_entity_id || invoiceRow.seller_entity_id || '',
      party_name: payment.party_name || '',
      invoice_no: payment.invoice_no || invoiceRow.invoice_no || '',
      invoice_date: payment.invoice_date || invoiceRow.invoice_date || '',
      due_date: payment.due_date || invoiceRow.due_date || '',
      currency: payment.currency || 'INR',
      exchange_rate: payment.exchange_rate != null ? String(payment.exchange_rate) : '1',
      basis: String(toNum(payment.amount) + toNum(payment.tds_amount)),
      apply_tds: !!toNum(payment.tds_amount),
      tds_section: payment.tds_section || '',
      tds_rate: payment.tds_rate != null ? String(payment.tds_rate) : '',
      apply_tcs: !!toNum(payment.tcs_amount),
      tcs_section: payment.tcs_section || '',
      tcs_rate: payment.tcs_rate != null ? String(payment.tcs_rate) : '',
      adjustments: payment.adjustments != null ? String(payment.adjustments) : '0',
      adjustment_notes: payment.adjustment_notes || '',
      actual_payment_date: payment.actual_payment_date || today(),
      notes: payment.notes || '',
      _ceiling: ceiling,
    })
    setModalOpen(true)
  }

  const tdsAmount  = form.apply_tds ? computeTds(form.basis, form.tds_rate) : 0
  // CHANGED: TCS is a separate collection ON TOP of the invoice amount (the
  // seller collects it from the buyer and remits it), not a reduction — unlike
  // TDS it must NOT flow into `cashAmount`/`amount`, because computeInvoiceOutstanding
  // (utils/payments.js) reconstructs "settled" as amount + tds_amount + adjustments,
  // deliberately designed so TDS "adds back" to fully settle the invoice's own
  // value. Folding TCS into `amount` would inflate settled by the TCS amount and
  // understate what's still pending. TCS is tracked in its own column and shown
  // only as an extra cash line in the preview below.
  const tcsAmount  = form.apply_tcs ? computeTds(form.basis, form.tcs_rate) : 0
  const cashAmount = Math.max(0, roundRupees(toNum(form.basis) - tdsAmount))
  const totalCashThisTranche = cashAmount + tcsAmount // informational only — not persisted as `amount`

  async function handleSave() {
    if (!form.invoice_id) return setToast({ message: 'Select an invoice', type: 'error' })
    if (!toNum(form.basis)) return setToast({ message: 'Settlement amount is required', type: 'error' })
    if (!form.actual_payment_date) return setToast({ message: 'Payment date is required', type: 'error' })
    setSaving(true)
    const payload = {
      invoice_id: form.invoice_id, entity_id: form.entity_id || null, party_entity_id: form.party_entity_id || null,
      party_name: form.party_name || null, invoice_no: form.invoice_no || null, invoice_date: form.invoice_date || null,
      due_date: form.due_date || null, currency: form.currency, exchange_rate: toNum(form.exchange_rate) || 1,
      amount: cashAmount,
      tds_section: form.apply_tds ? (form.tds_section || null) : null,
      tds_rate: form.apply_tds ? (toNum(form.tds_rate) || 0) : 0,
      tds_base_amount: form.apply_tds ? toNum(form.basis) : 0,
      tds_amount: tdsAmount,
      tcs_section: form.apply_tcs ? (form.tcs_section || null) : null,
      tcs_rate: form.apply_tcs ? (toNum(form.tcs_rate) || 0) : 0,
      tcs_base_amount: form.apply_tcs ? toNum(form.basis) : 0,
      tcs_amount: tcsAmount,
      adjustments: toNum(form.adjustments) || 0, adjustment_notes: form.adjustment_notes || null,
      actual_payment_date: form.actual_payment_date, notes: form.notes || null,
      updated_at: new Date(),
    }
    let error
    if (editingPayment) { const r = await supabase.from('invoice_payments').update(payload).eq('id', editingPayment.id); error = r.error }
    else                { const r = await supabase.from('invoice_payments').insert(payload); error = r.error }
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    // CHANGED: auto-advance the invoice's own status/paid/outstanding from
    // its recorded tranches (submitted → partial → paid) — previously the
    // invoice row never learned about payments at all. If this tranche was
    // moved to a different invoice while editing, re-sync the old one too.
    const { error: syncErr } = await syncInvoicePaymentStatus(form.invoice_id)
    if (editingPayment?.invoice_id && editingPayment.invoice_id !== form.invoice_id) {
      await syncInvoicePaymentStatus(editingPayment.invoice_id)
    }
    setSaving(false)
    if (syncErr) setToast({ message: `Payment saved, but the invoice status could not be updated: ${syncErr.message}`, type: 'error' })
    else setToast({ message: editingPayment ? 'Payment updated' : 'Payment recorded', type: 'success' })
    setModalOpen(false); load()
  }

  async function handleDeletePayment() {
    await supabase.from('invoice_payments').update({ is_deleted: true }).eq('id', confirmDelete.id)
    // CHANGED: removing a tranche re-derives the invoice's payment status
    // (a fully-paid invoice drops back to partial/submitted as appropriate).
    await syncInvoicePaymentStatus(confirmDelete.invoice_id)
    setConfirmDelete(null); load()
    if (detailOpen) setDetailOpen(d => d) // keep panel open; load() will refresh underlying data on next render
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
            <Select value={fromEntityFilter} onChange={e => setFromEntityFilter(e.target.value)}>
              <option value=''>All</option>
              {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
            </Select>
          </FormRow>
        </div>
        <div style={{ width: '160px' }}>
          <FormRow label='To Entity (buyer)'>
            <Select value={toEntityFilter} onChange={e => setToEntityFilter(e.target.value)} disabled={toEntityLocked}>
              {!isAdmin && !toEntityLocked && <option value=''>All accessible</option>}
              {isAdmin && <option value=''>All</option>}
              {toEntityOptions.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
            </Select>
          </FormRow>
        </div>
        <div style={{ width: '140px' }}>
          <FormRow label='Status'>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              style={{ padding: '7px 10px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit', width: '100%' }}>
              <option value='all'>All</option>
              <option value='pending'>Pending</option>
              <option value='due_soon'>Due Soon</option>
              <option value='overdue'>Overdue</option>
              <option value='paid'>Paid</option>
            </select>
          </FormRow>
        </div>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => openNew()}>+ Add Payment</Btn>
      </div>

      <Card>
        {loading ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        : filtered.length === 0 ? <EmptyState icon='💳' title='No invoices found' action={<Btn onClick={() => openNew()}>+ Add Payment</Btn>} />
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1150px' }}>
              <thead><tr>
                {['#','Invoice No','Date','From','To','Invoice Amt','Paid','TDS','Pending','Due','Days Left','Status',''].map((h,i) => (
                  <th key={i} style={{ ...th, textAlign: i >= 5 && i <= 8 ? 'right' : 'left' }}>{h}</th>
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

      {/* Invoice detail — tranche payment history */}
      <Modal open={!!detailOpen} onClose={() => setDetailOpen(null)} title={`Payment History — ${detailOpen?.invoice_no || ''}`} width={780}>
        {detailOpen && (() => {
          const inv = computed.find(c => c.id === detailOpen.id) || detailOpen
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <BalancePreview amount={inv.total_amount} advance={inv._paid + inv._tds} adjustments={inv._adj} currency='INR' />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: C.text }}>Payment Tranches ({inv._tranches.length})</div>
                {inv._pending > 0 && <Btn size='sm' onClick={() => { setDetailOpen(null); openNew(inv) }}>+ Add Payment</Btn>}
              </div>
              {inv._tranches.length === 0 ? (
                <div style={{ fontSize: '12px', color: C.textMuted, padding: '12px 0' }}>No payments recorded yet against this invoice.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      {['Date','Paid','TDS','Section','TCS','Section','Adj.','Notes','Docs',''].map((h,i) => (
                        <th key={i} style={{ ...th, textAlign: i === 1 || i === 2 || i === 4 || i === 6 ? 'right' : 'left' }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {inv._tranches.map(t => (
                        <tr key={t.id}>
                          <td style={td}>{fmtDate(t.actual_payment_date)}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}><AmtCell amount={t.amount} currency='INR' /></td>
                          <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={t.tds_amount} currency='INR' /></td>
                          <td style={td}>{t.tds_section || '—'}</td>
                          <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={t.tcs_amount} currency='INR' /></td>
                          <td style={td}>{t.tcs_section || '—'}</td>
                          <td style={{ ...td, textAlign: 'right' }}><AmtCell amount={t.adjustments} currency='INR' /></td>
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
            </div>
          )
        })()}
      </Modal>

      {/* Add / Edit payment modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editingPayment ? 'Edit Payment' : 'Add Invoice Payment'} width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <SectionDivider label='Entities' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='To Entity (buyer — makes payment)' hint={toEntityLocked ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)} disabled={toEntityLocked}>
                <option value=''>Select</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='From Entity (seller) — optional narrow'>
              <Select value={form.party_entity_id} onChange={e => setF('party_entity_id', e.target.value)}>
                <option value=''>Any</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
          </div>

          <SectionDivider label='Invoice' />
          <FormRow label='Link Invoice' hint={!form.entity_id ? 'Pick "To Entity" first to filter this list to invoices billed to them.' : undefined}>
            <Select value={form.invoice_id} onChange={e => setF('invoice_id', e.target.value)}>
              <option value=''>Select invoice</option>
              {invoiceOptions.map(i => (
                <option key={i.id} value={i.id}>
                  {i.invoice_no || i.id.slice(0,8)} — pending {formatINR(i._pending)}{i.id === editingPayment?.invoice_id ? '' : ''}
                </option>
              ))}
            </Select>
          </FormRow>
          {form.invoice_id && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <FormRow label='Invoice Date'><Input value={fmtDate(form.invoice_date)} disabled /></FormRow>
              <FormRow label='Due Date'><Input value={fmtDate(form.due_date)} disabled /></FormRow>
              <FormRow label='Currency'><Select value={form.currency} onChange={e => setF('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></FormRow>
            </div>
          )}

          <SectionDivider label='Settlement' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Settle Amount (this payment)' required hint='Defaults to full pending — reduce for a partial tranche.'>
              <Input type='number' value={form.basis} onChange={e => setF('basis', e.target.value)} />
            </FormRow>
            <FormRow label='Payment Date' required><Input type='date' value={form.actual_payment_date} onChange={e => setF('actual_payment_date', e.target.value)} /></FormRow>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='apply_tds' checked={form.apply_tds} onChange={e => setF('apply_tds', e.target.checked)} style={{ width: '15px', height: '15px', cursor: 'pointer' }} />
            <label htmlFor='apply_tds' style={{ fontSize: '13px', fontWeight: 600, color: C.text, cursor: 'pointer' }}>Deduct TDS from this payment</label>
          </div>

          {form.apply_tds && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px' }}>
              <FormRow label='TDS Section'>
                <Select value={form.tds_section} onChange={e => setF('tds_section', e.target.value)}>
                  <option value=''>Select</option>
                  {TDS_SECTIONS.map(s => <option key={s} value={s}>{s} — {TDS_SECTION_LABELS[s]}</option>)}
                </Select>
              </FormRow>
              <FormRow label='TDS Rate %'><Input type='number' step='0.01' value={form.tds_rate} onChange={e => setF('tds_rate', e.target.value)} /></FormRow>
            </div>
          )}

          {/* CHANGED: TCS — the seller collects this on top of the invoice
              amount from the buyer; unlike TDS it adds to what changes hands. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='apply_tcs' checked={form.apply_tcs} onChange={e => setF('apply_tcs', e.target.checked)} style={{ width: '15px', height: '15px', cursor: 'pointer' }} />
            <label htmlFor='apply_tcs' style={{ fontSize: '13px', fontWeight: 600, color: C.text, cursor: 'pointer' }}>Collect TCS on this payment</label>
          </div>

          {form.apply_tcs && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px' }}>
              <FormRow label='TCS Section'>
                <Select value={form.tcs_section} onChange={e => setF('tcs_section', e.target.value)}>
                  <option value=''>Select</option>
                  {TCS_SECTIONS.map(s => <option key={s} value={s}>{s} — {TCS_SECTION_LABELS[s]}</option>)}
                </Select>
              </FormRow>
              <FormRow label='TCS Rate %'><Input type='number' step='0.01' value={form.tcs_rate} onChange={e => setF('tcs_rate', e.target.value)} /></FormRow>
            </div>
          )}

          {toNum(form.basis) > 0 && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', display: 'grid', gridTemplateColumns: `repeat(${tcsAmount > 0 ? 5 : 3},1fr)`, gap: '8px', fontSize: '13px' }}>
              <div>
                <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>Settling</div>
                <strong>{formatINR(form.basis)}</strong>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>TDS Deducted</div>
                <strong style={{ color: C.warning }}>− {formatINR(tdsAmount)}</strong>
              </div>
              {tcsAmount > 0 && (
                <div>
                  <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>TCS Collected</div>
                  <strong style={{ color: C.warning }}>+ {formatINR(tcsAmount)}</strong>
                </div>
              )}
              <div>
                <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>Applied to Invoice</div>
                <strong style={{ color: C.success }}>{formatINR(cashAmount)}</strong>
              </div>
              {tcsAmount > 0 && (
                <div>
                  <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>Total Cash This Tranche</div>
                  <strong style={{ color: C.success }}>{formatINR(totalCashThisTranche)}</strong>
                </div>
              )}
            </div>
          )}

          <SectionDivider label='Adjustments (optional)' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Adjustments'><Input type='number' value={form.adjustments} onChange={e => setF('adjustments', e.target.value)} placeholder='0' /></FormRow>
            <FormRow label='Adj. Notes'><Input value={form.adjustment_notes} onChange={e => setF('adjustment_notes', e.target.value)} /></FormRow>
          </div>

          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editingPayment ? 'Save Changes' : 'Record Payment'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDeletePayment}
        title='Delete Payment' message='Delete this payment tranche? This cannot be undone.' danger />
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
