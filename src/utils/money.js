// All amounts stored in paise (integer). ₹1 = 100 paise.

// Paise → INR display with Indian comma formatting
export function formatINR(paise) {
  if (paise === null || paise === undefined) return '₹0.00'
  const rupees = Number(paise) / 100
  return '₹' + rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// Rupees string → paise integer (for storing)
export function toPaise(rupeesStr) {
  if (!rupeesStr) return 0
  const clean = String(rupeesStr).replace(/,/g, '').replace(/₹/g, '').trim()
  return Math.round(parseFloat(clean || 0) * 100)
}

// Paise → rupees number (for calculations)
export function toRupees(paise) {
  return Number(paise || 0) / 100
}

// Format compact — ₹1.2L, ₹3.4Cr
export function formatINRCompact(paise) {
  const r = Number(paise || 0) / 100
  if (r >= 1_00_00_000) return '₹' + (r / 1_00_00_000).toFixed(2) + 'Cr'
  if (r >= 1_00_000) return '₹' + (r / 1_00_000).toFixed(2) + 'L'
  if (r >= 1_000) return '₹' + (r / 1_000).toFixed(1) + 'K'
  return formatINR(paise)
}

// Sum array of paise values
export function sumPaise(arr, key) {
  return arr.reduce((s, item) => s + Number(key ? item[key] : item || 0), 0)
}
