import { toNum, round2 } from './money'
import { supabase } from '../supabaseClient'

// Single source of truth for "how much of this invoice has actually been
// settled" — every payment tranche's amount + tds_amount + adjustments all
// count toward reducing what's still owed. Reused by notifications.js (the
// overdue/due-soon scan) and the Payments module's invoice tracker table so
// the two can never quietly drift apart on the definition of "pending".
export function summarizeTranches(tranches) {
  const paidSum = (tranches || []).reduce((s, t) => s + toNum(t.amount), 0)
  const tdsSum  = (tranches || []).reduce((s, t) => s + toNum(t.tds_amount), 0)
  const adjSum  = (tranches || []).reduce((s, t) => s + toNum(t.adjustments), 0)
  return { paidSum, tdsSum, adjSum, settled: paidSum + tdsSum + adjSum }
}

// outstanding = invoice total − linked payments − adjustments, floored at 0
// (a rounding blip or an over-recorded adjustment should never show as a
// negative amount owed).
export function computeInvoiceOutstanding(invoice, tranches) {
  const { paidSum, tdsSum, adjSum, settled } = summarizeTranches(tranches)
  const pending = Math.max(0, Math.round(toNum(invoice?.total_amount) - settled))
  return { paidSum, tdsSum, adjSum, settled, pending }
}

// Auto-advance an invoice's payment status from its recorded tranches — the
// same "derive from reality" idea the Orders page uses for leg activity.
// Called after every payment insert/update/soft-delete so paid_amount /
// outstanding_amount / status on the invoice row can never drift from the
// payment tracker. Rules: draft/cancelled invoices are never touched (their
// status isn't payment-driven); otherwise settled==0 → 'submitted',
// 0<settled<total → 'partial', settled>=total (to the paisa) → 'paid'.
// Failures are returned, not thrown — the payment itself already saved, so
// callers surface a warning rather than rolling anything back.
export async function syncInvoicePaymentStatus(invoiceId) {
  if (!invoiceId) return {}
  const [{ data: inv }, { data: tranches }] = await Promise.all([
    supabase.from('invoices').select('id,total_amount,status').eq('id', invoiceId).single(),
    supabase.from('invoice_payments').select('amount,tds_amount,adjustments').eq('invoice_id', invoiceId).eq('is_deleted', false),
  ])
  if (!inv || ['draft', 'cancelled'].includes(inv.status)) return {}
  const { settled } = summarizeTranches(tranches)
  const total = toNum(inv.total_amount)
  const status = settled <= 0 ? 'submitted' : settled >= total - 0.005 ? 'paid' : 'partial'
  const { error } = await supabase.from('invoices').update({
    paid_amount: round2(settled),
    outstanding_amount: round2(Math.max(0, total - settled)),
    status,
    updated_at: new Date(),
  }).eq('id', invoiceId)
  return { status, error }
}

// Groups a flat invoice_payments result set by invoice_id — the shape both
// consumers need before calling computeInvoiceOutstanding per invoice.
export function groupTranchesByInvoice(tranches) {
  const map = new Map()
  for (const t of (tranches || [])) {
    if (!t.invoice_id) continue
    if (!map.has(t.invoice_id)) map.set(t.invoice_id, [])
    map.get(t.invoice_id).push(t)
  }
  return map
}

// Builds a single chronological cash-movement list for one entity, merging
// standalone entity_payments rows with invoice_payments tranches where that
// entity is either the payer (entity_id) or the payee/seller (party_entity_id)
// — entities here routinely sell as well as buy, so a ledger scoped only to
// entity_id would look empty for a primarily-selling entity. Balance = cash
// in − cash out, starting at 0. No opening-balance concept — this is a simple
// running total, not double-entry accounting.
export function buildEntityLedger(entityId, { entityPayments = [], invoicePayments = [] } = {}) {
  const rows = []

  for (const p of entityPayments) {
    if (p.entity_id === entityId) {
      rows.push({
        id: p.id, source: 'entity_payment', date: p.actual_payment_date,
        counterpartyId: p.party_entity_id, counterpartyName: p.party_name,
        inbound: p.direction === 'received', amount: toNum(p.amount), currency: p.currency,
        category: p.category, notes: p.notes, raw: p,
      })
    } else if (p.party_entity_id === entityId) {
      // Flip side: the OTHER entity's direction determines what this one experienced.
      rows.push({
        id: p.id, source: 'entity_payment', date: p.actual_payment_date,
        counterpartyId: p.entity_id, counterpartyName: null,
        inbound: p.direction !== 'received', amount: toNum(p.amount), currency: p.currency,
        category: p.category, notes: p.notes, raw: p,
      })
    }
  }

  for (const t of invoicePayments) {
    // Cash that actually moved: settled amount + TCS collected on top (TDS is
    // withheld, not paid out — same reasoning as index.jsx's tranche modal).
    const cash = toNum(t.amount) + toNum(t.tcs_amount)
    if (t.entity_id === entityId) {
      rows.push({
        id: t.id, source: 'invoice_payment', date: t.actual_payment_date,
        counterpartyId: t.party_entity_id, counterpartyName: t.party_name,
        inbound: false, amount: cash, currency: t.currency,
        invoiceNo: t.invoice_no, notes: t.notes, raw: t,
      })
    } else if (t.party_entity_id === entityId) {
      rows.push({
        id: t.id, source: 'invoice_payment', date: t.actual_payment_date,
        counterpartyId: t.entity_id, counterpartyName: null,
        inbound: true, amount: cash, currency: t.currency,
        invoiceNo: t.invoice_no, notes: t.notes, raw: t,
      })
    }
  }

  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.id || '').localeCompare(b.id || ''))
  let balance = 0
  for (const r of rows) {
    balance += r.inbound ? r.amount : -r.amount
    r.runningBalance = balance
  }
  return rows
}
