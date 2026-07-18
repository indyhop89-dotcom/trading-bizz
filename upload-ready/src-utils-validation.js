// Format validators for Indian tax/logistics identifiers. Blank values always
// pass — these fields stay optional (e.g. a vendor with no GSTIN is
// legitimate); only a non-empty, malformed value is rejected. Callers pair
// these with a hard save-block, same convention as every other required-field
// check in this codebase.

export const PAN_REGEX       = /^[A-Z]{5}[0-9]{4}[A-Z]$/
export const GSTIN_REGEX     = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const EWAY_BILL_REGEX = /^[0-9]{12}$/

export function isValidPAN(v) {
  return !v || PAN_REGEX.test(v.trim().toUpperCase())
}

export function isValidGSTIN(v) {
  return !v || GSTIN_REGEX.test(v.trim().toUpperCase())
}

// Accepts either a raw 12-digit string or one formatted with dashes/spaces
// (e.g. "1234-5678-9012") — strips separators before checking.
export function isValidEwayBill(v) {
  return !v || EWAY_BILL_REGEX.test((v || '').replace(/[\s-]/g, ''))
}

export const PAN_ERROR   = 'Invalid PAN format (e.g. AAAAA1234A)'
export const GSTIN_ERROR = 'Invalid GSTIN format (e.g. 22AAAAA0000A1Z5)'
export const EWAY_BILL_ERROR = 'Invalid E-Way Bill number (must be 12 digits)'
