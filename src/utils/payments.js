import { toNum } from './money'

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
