// Product-name normalization — the single source of truth for "are these two
// product names the same product?" and "what should we store as the name?".
//
// Background: the catalog got polluted with duplicate products whose names
// differed only by trailing junk, e.g. 'Foo Set of 4' vs 'Foo Set of 4))'.
// Opening stock landed on one, invoices on the other, and stock never
// reconciled. These helpers stop that at the source: matching is done on a
// normalized key, and newly auto-created products are stored with a cleaned
// name.

// Cleaned display name: trim, collapse internal whitespace, and strip trailing
// stray ')' / whitespace (the artifact we keep seeing). Note this also trims a
// legitimately-matched trailing ')' e.g. 'Towel (Set of 2)' -> 'Towel (Set of
// 2' — acceptable for this catalog, where trailing parens are junk, and it
// never causes two genuinely-different products to collide (an opening '(' is
// left intact, so '...(A)' and '...(B)' stay distinct).
export function cleanProductName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[)\s]+$/, '')
    .trim()
}

// Case-insensitive match key. Use this on BOTH sides when looking up whether a
// product already exists, so 'Foo Set of 4', 'foo set of 4', and
// 'Foo Set of 4))' all resolve to the same existing product.
export function productKey(name) {
  return cleanProductName(name).toLowerCase()
}

// Full identity key: name alone is NOT enough to say "same product". A single
// bulk-upload file can legitimately contain many different products that share
// one generic name (e.g. a source system exporting 7 different cushion-cover
// designs all labeled "Embroidered Cotton Cushion Cover" at 7 different
// rates). Matching those by name only would silently merge distinct products
// and lose real stock/quantity data.
//
// Rule (explicit product owner decision): two rows are the SAME product only
// if name, HSN code, rate, AND GST rate all match. If any of the four
// differs, treat them as different products — never merge.
//
// Rate/GST are rounded to 2dp before comparing so '410.7' and '410.70' (or
// float artifacts like 410.729999999) don't spuriously fail to match.
function round2(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}
export function productMatchKey({ name, hsn_code, rate, gst_rate }) {
  const hsn = String(hsn_code || '').trim().toLowerCase()
  return `${productKey(name)}__${hsn}__${round2(rate)}__${round2(gst_rate)}`
}
