// Product-name normalization — the single source of truth for "are these two
// product names the same product?" and "what should we store as the name?".
//
// CHANGED: product identity is now NAME ALONE (see migration
// 046_product_name_as_key.sql) — product_id is gone from every referencing
// table. Two rows are the same product if and only if they share a name
// (case-insensitively, after cleaning). The DB enforces this with a
// UNIQUE(name) constraint (plus a case-insensitive unique index), so the
// matching helpers here just need to normalize consistently with what the DB
// considers canonical — there is no more HSN/rate/GST tie-breaking, because
// there is no longer a second product allowed to share a name in the first
// place.

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

export function round2(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}

// Sole product lookup — name is the entire identity now. Case-insensitive,
// junk-stripped, same normalization as the DB's unique index on
// lower(name)/products_name_ci_unique_idx.
export function findProductByName(products, name) {
  const key = productKey(name)
  if (!key) return null
  return (products || []).find(p => productKey(p.name) === key) || null
}
