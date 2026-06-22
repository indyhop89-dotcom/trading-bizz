// Auto-detect interstate from GST state codes
// Same state → CGST + SGST (half each)
// Different state → IGST (full rate)

export function isInterstate(sellerStateCode, buyerStateCode) {
  if (!sellerStateCode || !buyerStateCode) return false
  return String(sellerStateCode).trim() !== String(buyerStateCode).trim()
}

export function calculateTax(gstRate, sellerStateCode, buyerStateCode) {
  const interstate = isInterstate(sellerStateCode, buyerStateCode)
  if (interstate) {
    return { igst: Number(gstRate), cgst: 0, sgst: 0, isInterstate: true }
  }
  return {
    igst: 0,
    cgst: Number(gstRate) / 2,
    sgst: Number(gstRate) / 2,
    isInterstate: false,
  }
}

// Calculate tax amounts on a taxable amount (in paise)
export function calculateTaxAmounts(taxableAmountPaise, gstRate, sellerStateCode, buyerStateCode) {
  const rates = calculateTax(gstRate, sellerStateCode, buyerStateCode)
  return {
    isInterstate: rates.isInterstate,
    taxableAmount: taxableAmountPaise,
    cgstRate: rates.cgst,
    cgstAmount: Math.round(taxableAmountPaise * rates.cgst / 100),
    sgstRate: rates.sgst,
    sgstAmount: Math.round(taxableAmountPaise * rates.sgst / 100),
    igstRate: rates.igst,
    igstAmount: Math.round(taxableAmountPaise * rates.igst / 100),
    totalTax: Math.round(taxableAmountPaise * Number(gstRate) / 100),
    totalAmount: taxableAmountPaise + Math.round(taxableAmountPaise * Number(gstRate) / 100),
  }
}

// Calculate line item totals
export function calcLineItem(qty, ratePaise, gstRate, sellerStateCode, buyerStateCode) {
  const taxable = Math.round(Number(qty) * Number(ratePaise))
  return calculateTaxAmounts(taxable, gstRate, sellerStateCode, buyerStateCode)
}
