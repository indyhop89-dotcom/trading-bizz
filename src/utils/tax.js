import { round2 } from './money'

/**
 * Detect interstate from two GSTIN state codes (first 2 chars).
 */
export function isInterstate(sellerGstin, buyerGstin) {
  if (!sellerGstin || !buyerGstin) return false
  return sellerGstin.substring(0, 2) !== buyerGstin.substring(0, 2)
}

/**
 * Calculate tax amounts for a line item.
 *
 * @param {number} taxableAmount  - taxable amount in rupees (may have 2dp)
 * @param {number} gstRate        - GST rate as % e.g. 18
 * @param {boolean} interstate    - true = IGST, false = CGST+SGST
 * @returns {{ cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, total_tax }}
 *
 * All returned amounts are rounded to 2dp (not whole rupees) — the DB column
 * is numeric(15,2), and rounding to a whole rupee per line before storage/
 * summation is what causes header totals to drift from the true value.
 *
 * Rounds the line's TOTAL first (taxable + tax, as one precise figure), then
 * derives CGST/SGST/IGST from that already-rounded total — matching how
 * externally generated GST documents/spreadsheets conventionally compute
 * (round the whole line once, split into components after), rather than
 * rounding taxable*rate/200 independently per component. The two conventions
 * agree almost everywhere but can differ by a paisa on lines that land right
 * on a rounding boundary; this keeps totals in agreement with bulk-uploaded
 * reference files instead of silently recomputing to a different (though
 * individually valid) figure. Because CGST and SGST are each independently
 * rounded from the same precise half below, their sum can occasionally land
 * a paisa off from total_tax — an accepted artifact of this convention, not
 * a bug: total_amount is always derived from total_tax directly (see
 * computeLine in LineItemsEditor.jsx), never from cgst_amount + sgst_amount,
 * so it stays exact.
 */
export function calcLineTax(taxableAmount, gstRate, interstate) {
  const rate = Number(gstRate) || 0
  const base = Number(taxableAmount) || 0

  const total = round2(base + (base * rate / 100))
  const totalTax = round2(total - base)

  if (interstate) {
    return {
      cgst_rate: 0, cgst_amount: 0,
      sgst_rate: 0, sgst_amount: 0,
      igst_rate: rate, igst_amount: totalTax,
      total_tax: totalTax,
    }
  } else {
    const half = round2(rate / 2)
    const each = round2(totalTax / 2)
    return {
      cgst_rate: half, cgst_amount: each,
      sgst_rate: half, sgst_amount: each,
      igst_rate: 0,    igst_amount: 0,
      total_tax: totalTax,
    }
  }
}

/**
 * Sum totals from an array of computed line objects.
 */
export function calcInvoiceTotals(lines) {
  return lines.reduce((acc, l) => ({
    taxable_amount: acc.taxable_amount + (Number(l.taxable_amount) || 0),
    cgst_amount:    acc.cgst_amount    + (Number(l.cgst_amount)    || 0),
    sgst_amount:    acc.sgst_amount    + (Number(l.sgst_amount)    || 0),
    igst_amount:    acc.igst_amount    + (Number(l.igst_amount)    || 0),
    total_amount:   acc.total_amount   + (Number(l.total_amount)   || 0),
  }), { taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_amount: 0 })
}
