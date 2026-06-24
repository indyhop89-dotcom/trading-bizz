/**
 * Money utilities — all amounts in RUPEES (numeric, no paise).
 *
 * Rules:
 *  - Store: numeric(15,2) in Postgres — e.g. 1250.00
 *  - Calculate: intermediate 2dp, final values rounded to whole rupee
 *  - Display: Indian comma format, no decimal places — ₹1,250 not ₹1,250.00
 */

/**
 * Format a rupee amount for display.
 * 1250     → "₹1,250"
 * 1250.60  → "₹1,251"   (rounds to whole rupee)
 * 0        → "₹0"
 * null/''  → "—"
 */
export function formatINR(amount) {
  if (amount === null || amount === undefined || amount === '') return '—'
  const n = Math.round(Number(amount))
  if (isNaN(n)) return '—'
  return '₹' + n.toLocaleString('en-IN')
}

/**
 * Safe parse a user-entered string to a number.
 * Strips commas, handles empty string → 0.
 * "1,250.50" → 1250.50
 */
export function toNum(val) {
  if (val === null || val === undefined || val === '') return 0
  return Number(String(val).replace(/,/g, '')) || 0
}

/**
 * Round a rupee amount to whole rupee (standard round-half-up).
 * 1250.5 → 1251
 * 1250.4 → 1250
 */
export function roundRupees(val) {
  return Math.round(Number(val) || 0)
}

/**
 * Round to 2 decimal places (for intermediate calculations).
 * Used on rate, taxable amount before final rounding.
 */
export function round2(val) {
  return Math.round((Number(val) || 0) * 100) / 100
}
