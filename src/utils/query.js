// Small helper to bound how long we'll wait on a Supabase query before giving
// the user a clear error instead of an indefinite spinner. Supabase query
// builders are thenables, so Promise.race works directly on them.
//
// This does NOT cancel the underlying request (PostgREST has no client-side
// cancel), it just stops the UI from waiting forever — the user gets a usable
// error and can retry rather than staring at a frozen "Loading…".
export function withTimeout(promise, ms = 20000, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — the server did not respond. Check your connection and try again.`)), ms)
    ),
  ])
}

// The moment a 'sales' invoice gets an E-way Bill, autoCompletePurchaseMirror
// (Invoices/index.jsx) auto-creates a SECOND invoice row for the buyer's own
// purchase register — invoice_type: 'purchase', source_invoice_id pointing
// back at the original, but seller_entity_id/buyer_entity_id/taxable_amount/
// cgst/sgst/igst/total_amount/order_leg_id all copied VERBATIM from the
// source. It represents the exact same physical transaction, not a second
// one — any query that aggregates invoices by seller/buyer (GST output vs
// input tax, P&L, ledgers, ageing, per-leg tranche totals, dashboard totals)
// MUST exclude it or every mirrored transaction gets double-counted.
// Concretely: an entity that buys from an internal (non-external) upstream
// entity gets its purchase mirrored (input tax doubles), but only gets its
// own sale mirrored if ITS buyer is also internal — sell to an external
// customer and output tax stays single-counted. That asymmetry is what
// makes a genuinely profitable trade (real output > real input) show up as
// "more inward than outward" once the purchase side is silently doubled.
// stock.js's fetchStockMovementData() and the Invoices list page already
// apply the equivalent filter; this is the same rule for any other
// aggregate query built straight from `.from('invoices')`.
export function excludeAutoPurchaseMirrors(query) {
  return query.or('invoice_type.neq.purchase,source_invoice_id.is.null')
}

// Same rule as excludeAutoPurchaseMirrors, for callers that already have the
// rows in JS (e.g. a leg's invoice list built up client-side) rather than
// shaping a fresh query.
export function isAutoPurchaseMirror(inv) {
  return inv?.invoice_type === 'purchase' && !!inv?.source_invoice_id
}

// PostgREST caps a single response at 1000 rows by default. Any table that
// can realistically grow past that (products, opening stock, etc.) needs to
// page through with .range() or it silently truncates — the query looks like
// it succeeded, it just quietly drops everything past row 1000. Pass a
// builder-factory (not a built query) so each page can set its own .range().
export async function fetchAllPages(buildQuery, pageSize = 1000) {
  const all = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return { data: all, error: null }
}
