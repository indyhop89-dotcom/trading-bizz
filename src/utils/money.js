/**
 * Money utilities — all amounts in RUPEES (numeric, no paise).
 *
 * Rules:
 *  - Store: numeric(15,2) in Postgres — e.g. 1250.00
 *  - Calculate: round to 2dp at every step (line taxable/tax amounts, then
 *    header totals) — never collapse to a whole rupee mid-calculation.
 *    Summing many already-2dp line amounts in JS floating point can leave a
 *    tiny residue (e.g. 8784284.829999999), so the one "final adjustment" is
 *    a last round2() pass on the summed header total — not a re-round to a
 *    whole rupee.
 *  - Display: Indian comma format, 2 decimal places — ₹1,250.00
 */

/**
 * Indian comma-grouped, 2dp number formatting with no currency symbol and
 * no "—" fallback — the shared primitive behind formatINR below, also used
 * directly by print/Excel document generation where every cell must always
 * show a number rather than a dash for null/zero.
 * 1250 → "1,250.00"
 */
export function formatNumberIN(amount) {
  return (Number(amount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Format a rupee amount for display.
 * 1250     → "₹1,250.00"
 * 1250.6   → "₹1,250.60"
 * 0        → "₹0.00"
 * null/''  → "—"
 */
export function formatINR(amount) {
  if (amount === null || amount === undefined || amount === '') return '—'
  const n = Number(amount)
  if (isNaN(n)) return '—'
  return '₹' + formatNumberIN(n)
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
 *
 * Goes through toFixed() before Math.round() rather than `Math.round(val*100)/100`
 * directly: IEEE 754 floats can't represent most 2dp decimals exactly, so a value
 * that's conceptually exactly on a rounding boundary (e.g. 261.085) is often stored
 * as something like 261.08499999999998 — Math.round then rounds it the wrong way.
 * toFixed(4) collapses that noise before Math.round sees it, so half-up rounding is
 * consistent — matching the convention used by Excel/Tally-generated reference data.
 */
export function round2(val) {
  const n = Number(val) || 0
  return Math.round(Number((n * 100).toFixed(4))) / 100
}
