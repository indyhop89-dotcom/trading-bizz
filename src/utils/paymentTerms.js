// Shared payment-terms vocabulary + due-date derivation. PI/PO already
// collect payment_terms as free text for the printed document; Invoices now
// collect it too and derive due_date from it, so the mapping from a terms
// string to a day count lives here once.

export const PAYMENT_TERMS_OPTIONS = [
  '100% Advance', 'Net 30 Days', 'Net 45 Days', 'Net 60 Days',
  '50% Advance, 50% on Delivery', 'Against Delivery', 'LC at Sight', 'Cash on Delivery',
]

// Days from document date to due date for a terms string, or null when the
// terms don't imply a computable offset (unknown/custom text — leave the
// due date alone rather than guessing).
export function daysForPaymentTerms(terms) {
  const t = (terms || '').trim().toLowerCase()
  if (!t) return null
  const m = t.match(/(\d+)\s*day/) || t.match(/^net\s+(\d+)/)
  if (m) return parseInt(m[1], 10)
  if (/advance|against delivery|sight|cash on delivery|\bcod\b/.test(t)) return 0
  return null
}

// ISO due date for docDate (YYYY-MM-DD) + terms, or '' when not derivable.
export function dueDateForTerms(docDate, terms) {
  const days = daysForPaymentTerms(terms)
  if (days === null || !docDate) return ''
  const d = new Date(`${docDate}T00:00:00`)
  if (isNaN(d)) return ''
  d.setDate(d.getDate() + days)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
