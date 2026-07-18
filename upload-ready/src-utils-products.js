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
export function round2(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}
export function productMatchKey({ name, hsn_code, rate, gst_rate }) {
  const hsn = String(hsn_code || '').trim().toLowerCase()
  return `${productKey(name)}__${hsn}__${round2(rate)}__${round2(gst_rate)}`
}

// Real incident (confirmed against production data): a CSV row for "Lace
// Embellished Mauve Cushion Cover" carried a rate ~0.5% above the existing
// product's rate (₹412.78 vs ₹410.73 — a margin/markup calculation upstream
// of the CSV), so productMatchKey's exact-rate rule correctly treated it as
// "not a match" and auto-created a brand-new product with zero opening
// stock. Every invoice billed against that new row then looked like it was
// selling from nothing ("billed beyond stock"), while the real 22 units of
// opening stock sat untouched on the original product. See
// supabase/maintenance/dedupe_rate_markup_products.sql for the one-time
// cleanup of rows already split this way.
//
// This is the same failure mode, caught BEFORE a duplicate gets created: same
// name + HSN + GST, but the rate lands within NEAR_MATCH_RATE_TOLERANCE of an
// existing product's rate instead of matching exactly. Reuse that product
// instead of minting a new one. The tolerance is intentionally tight — wide
// enough to catch a small markup/rounding drift, tight enough that two
// legitimately different price points for the same design (which do happen —
// see productMatchKey's own doc comment) don't get silently merged.
const NEAR_MATCH_RATE_TOLERANCE = 0.02 // 2%

export function findNearMatchProduct(products, { name, hsn_code, rate, gst_rate }) {
  const key = productKey(name)
  const hsn = String(hsn_code || '').trim().toLowerCase()
  const targetRate = Number(rate)
  const targetGst  = round2(gst_rate)
  if (!Number.isFinite(targetRate) || targetRate <= 0) return null
  let best = null
  let bestDiff = Infinity
  for (const p of products) {
    if (productKey(p.name) !== key) continue
    if (String(p.hsn_code || '').trim().toLowerCase() !== hsn) continue
    if (round2(p.gst_rate) !== targetGst) continue
    const pRate = Number(p.default_rate)
    if (!Number.isFinite(pRate) || pRate <= 0) continue
    const diff = Math.abs(pRate - targetRate) / pRate
    if (diff <= NEAR_MATCH_RATE_TOLERANCE && diff < bestDiff) { best = p; bestDiff = diff }
  }
  return best
}

// "Merge Stocks" suggestion finder — the inverse of the near-match check
// above. That one silently prevents a NEW near-duplicate from being created;
// this one surfaces EXISTING products worth reviewing for a manual merge,
// per the product-owner's stated rule: same name (junk-stripped) + same HSN,
// but a different rate, is worth flagging even though productMatchKey
// correctly treats them as distinct products (a genuinely different design
// sharing a name is possible — see productMatchKey's doc comment). Grouping
// only on name+HSN (not GST) so a GST-rate typo on one row of an otherwise
// identical pair still surfaces as a candidate instead of hiding in a
// separate group of its own.
//
// Deliberately does NOT decide which product to keep — that requires
// knowledge of opening stock / usage across entities that lives outside the
// products table, so the caller (Stock > Merge Duplicates tab) enriches each
// product with that data and picks the keeper.
export function findMergeSuggestionGroups(products) {
  const groups = new Map()
  for (const p of (products || [])) {
    if (p.is_active === false) continue
    const hsn = String(p.hsn_code || '').trim().toLowerCase()
    const key = `${productKey(p.name)}__${hsn}`
    if (!groups.has(key)) groups.set(key, { key, name: cleanProductName(p.name), hsn_code: p.hsn_code, products: [] })
    groups.get(key).products.push(p)
  }
  return [...groups.values()]
    .filter(g => g.products.length > 1 && new Set(g.products.map(p => round2(p.default_rate))).size > 1)
    .sort((a, b) => a.name.localeCompare(b.name))
}
