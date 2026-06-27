import { round2, roundRupees } from './money'

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
 * All returned amounts are whole rupees (Math.round applied).
 */
export function calcLineTax(taxableAmount, gstRate, interstate) {
  const rate = Number(gstRate) || 0
  const base = Number(taxableAmount) || 0

  if (interstate) {
    const igst = roundRupees(round2(base * rate / 100))
    return {
      cgst_rate: 0, cgst_amount: 0,
      sgst_rate: 0, sgst_amount: 0,
      igst_rate: rate, igst_amount: igst,
      total_tax: igst,
    }
  } else {
    const half  = round2(rate / 2)
    const each  = roundRupees(round2(base * half / 100))
    return {
      cgst_rate: half, cgst_amount: each,
      sgst_rate: half, sgst_amount: each,
      igst_rate: 0,    igst_amount: 0,
      total_tax: each * 2,
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
