import { supabase } from '../supabaseClient'
import { toNum } from './money'
import { fetchAllPages } from './query'

// Invoice statuses that are never real movements regardless of dispatch —
// 'draft' invoices haven't been sent yet, 'cancelled' invoices never
// happened. Kept separately from the E-way Bill check below because a
// cancelled invoice must never count even if it happened to have an
// E-way Bill number entered before it was cancelled.
const MOVEMENT_STATUSES_EXCLUDED = ['draft', 'cancelled']

// CHANGED: temporarily disabled at the user's explicit request — a real
// business review found every "Billed Beyond Stock" / "Negative stock risk"
// flag across the whole transaction history to be a false positive, most
// likely explained by the invoice_lines/stock_opening_balance RLS gap fixed
// in migration 043 (a non-master viewer's Actual Stock aggregation silently
// dropped rows for entities/invoices they had no grant on, understating
// inbound movements and making a real, fully-covered sale look oversold).
// Shared by Stock/index.jsx (the "Billed Beyond Stock" badge/StatCard) and
// notifications.js ("Negative stock risk") so both suppress in lockstep.
// Once migration 043 is applied and this stays clean across a few days of
// real use, flip back to true rather than deleting the check — it catches a
// genuine class of data-entry error (billing more than was ever received)
// when the underlying data is actually complete.
export const NEGATIVE_STOCK_FLAG_ENABLED = false

// Raw data fetch — shared by both consumers below so we only hit the DB once
// per page load rather than once per entity.
export async function fetchStockMovementData() {
  // CHANGED: both tables can exceed PostgREST's default 1000-row response
  // cap — a plain .select() silently truncates rather than erroring, which
  // undercounts opening/actual stock once either table grows past 1000 rows.
  const [{ data: opening }, { data: invLines }, { data: adjustments }] = await Promise.all([
    // `rate` on both feeds buildStockValuationMap (avg acquisition cost) —
    // the qty-only consumers just ignore it. Date columns (as_of_date,
    // invoice_date/eway_bill_date, adjustment_date) feed filterStockDataAsOf
    // for the point-in-time stock view.
    fetchAllPages(() => supabase.from('stock_opening_balance').select('entity_id, product_id, qty, rate, as_of_date')),
    fetchAllPages(() => supabase.from('invoice_lines')
      .select('qty, rate, product_id, invoice:invoice_id(seller_entity_id, buyer_entity_id, status, eway_bill_no, eway_bill_date, invoice_date, invoice_type, is_deleted, source_invoice_id)')
      .not('invoice', 'is', null)),
    // CHANGED: manual corrections (shortfall/damage/found/recount/offloaded)
    // — a signed qty_delta applied straight into actual_qty, same as
    // opening/invoice movements. Unlike invoice lines these have no
    // lifecycle gate (no draft/cancelled/E-way state to check) since an
    // adjustment row only exists once someone has actually recorded the
    // correction. 'offloaded' rows are stock this tool is done tracking
    // (sold/disposed of outside it) — they affect Actual Stock exactly like
    // every other reason, but never P&L (Reports' P&L/Profitability tabs
    // are computed purely from invoices/expenses, not stock_adjustments).
    fetchAllPages(() => supabase.from('stock_adjustments').select('entity_id, product_id, qty_delta, adjustment_date')),
  ])
  return {
    opening: opening || [],
    adjustments: adjustments || [],
    // CHANGED: goods only count as physically moved once an E-way Bill has
    // actually been entered on the invoice — raising or submitting an
    // invoice alone doesn't move stock, dispatch does. Because this whole
    // map is recomputed live from source data on every call (never stored),
    // cancelling an invoice after its E-way Bill was done automatically
    // reverses the movement on the very next load — no separate reversal
    // step needed. If the same trade is redone as a fresh invoice later,
    // it's evaluated independently and follows the same rule from scratch.
    //
    // invoice_type='purchase' rows with a source_invoice_id are auto-created
    // bookkeeping mirrors of a 'sales' invoice for the buyer's own purchase
    // register (see Invoices auto-complete-on-E-way-Bill flow) and represent
    // the exact same physical movement, not a second one — excluded here to
    // avoid double-counting. A purchase invoice with NO source_invoice_id was
    // entered manually (e.g. no matching sales invoice was ever raised on the
    // seller's side) and is the only record of that movement anywhere in the
    // system — it must still count, or the buyer's incoming stock silently
    // never gets recorded and their actual stock understates what they
    // really have on hand (surfacing later as a false "Billed beyond stock").
    invLines: (invLines || []).filter(l =>
      l.invoice &&
      !l.invoice.is_deleted &&
      !MOVEMENT_STATUSES_EXCLUDED.includes(l.invoice.status) &&
      !!l.invoice.eway_bill_no &&
      !(l.invoice.invoice_type === 'purchase' && l.invoice.source_invoice_id)
    ),
  }
}

// Builds { "entityId__productId": { entity_id, product_id, opening_qty, invoiced_in, invoiced_out, adjustment_qty, actual_qty } }
// actual_qty = opening + goods invoiced in (as buyer) - goods invoiced out (as seller) + manual adjustments
export function buildActualStockMap({ opening, invLines, adjustments = [] }) {
  const map = {}
  function ensure(entityId, productId) {
    const key = `${entityId}__${productId}`
    if (!map[key]) map[key] = { entity_id: entityId, product_id: productId, opening_qty: 0, invoiced_in: 0, invoiced_out: 0, adjustment_qty: 0 }
    return map[key]
  }
  for (const ob of opening) {
    ensure(ob.entity_id, ob.product_id).opening_qty += toNum(ob.qty)
  }
  for (const line of invLines) {
    const qty = toNum(line.qty)
    ensure(line.invoice.seller_entity_id, line.product_id).invoiced_out += qty
    ensure(line.invoice.buyer_entity_id, line.product_id).invoiced_in   += qty
  }
  for (const adj of adjustments) {
    ensure(adj.entity_id, adj.product_id).adjustment_qty += toNum(adj.qty_delta)
  }
  for (const row of Object.values(map)) {
    row.actual_qty = row.opening_qty + row.invoiced_in - row.invoiced_out + row.adjustment_qty
  }
  return map
}

// Point-in-time view: keep only the movements that had happened by asOfDate
// (ISO YYYY-MM-DD), so buildActualStockMap over the result answers "what did
// each entity hold on that day". Movement dates: opening rows use as_of_date,
// invoice lines use the E-way Bill date (the actual dispatch event) falling
// back to invoice_date, adjustments use adjustment_date. Rows with no date
// at all are kept — they can't be placed in time, and silently dropping them
// would understate stock. Pass a falsy asOfDate to get the data unchanged.
export function filterStockDataAsOf(raw, asOfDate) {
  if (!asOfDate) return raw
  return {
    opening: raw.opening.filter(ob => !ob.as_of_date || ob.as_of_date <= asOfDate),
    adjustments: raw.adjustments.filter(a => !a.adjustment_date || a.adjustment_date <= asOfDate),
    invLines: raw.invLines.filter(l => {
      const moved = l.invoice.eway_bill_date || l.invoice.invoice_date
      return !moved || moved <= asOfDate
    }),
  }
}

// Average acquisition cost per entity+product — what the stock an entity is
// holding actually cost it: opening stock at its recorded rate plus goods
// invoiced IN (as buyer, E-way-Bill gated like everything else) at the
// invoice line rate. Returns { "entityId__productId": { qty_in, value_in,
// avg_rate } }. This is the cost basis for the "stock margin" view — margin
// of a sale against what the goods on hand are actually carried at, as
// opposed to the deal margin (this sale vs the previous leg's sale).
export function buildStockValuationMap({ opening, invLines }) {
  const map = {}
  function ensure(entityId, productId) {
    const key = `${entityId}__${productId}`
    if (!map[key]) map[key] = { qty_in: 0, value_in: 0, avg_rate: 0 }
    return map[key]
  }
  for (const ob of opening) {
    const s = ensure(ob.entity_id, ob.product_id)
    s.qty_in += toNum(ob.qty)
    s.value_in += toNum(ob.qty) * toNum(ob.rate)
  }
  for (const l of invLines) {
    const s = ensure(l.invoice.buyer_entity_id, l.product_id)
    s.qty_in += toNum(l.qty)
    s.value_in += toNum(l.qty) * toNum(l.rate)
  }
  for (const s of Object.values(map)) {
    s.avg_rate = s.qty_in > 0 ? s.value_in / s.qty_in : 0
  }
  return map
}

// Server-side aggregation (see migration 041_stock_position_rpc.sql) — same
// output as buildActualStockMap()+buildStockValuationMap() combined
// (actual_qty breakdown AND avg carrying-cost rate per entity+product), but
// computed entirely in Postgres. The client used to page through every raw
// invoice line, opening-balance and adjustment row (30k+ rows, ~35 requests)
// just to sum them in JS; the RPC returns one aggregated row per
// entity+product in a single round trip — this is what made Stock Position
// take ~60 seconds.
//
// Falls back to the full client-side computation automatically if the RPC
// isn't available yet (migration 041 not applied — Postgres returns
// PGRST202 "function not found") or errors for any other reason, so every
// caller keeps working before/after the migration lands, just slower before.
export async function fetchActualStockPosition(asOfDate = null) {
  // supabase.rpc() itself doesn't throw on a Postgres-side error (it
  // resolves with `error` set) — but a network-level failure or an
  // unexpectedly missing client method can still reject/throw, and this
  // helper is on paths (notifications, form stock checks) that must never
  // take the whole caller down over a stock-lookup hiccup. Any failure here
  // — thrown or returned — falls through to the same full client-side
  // computation.
  try {
    const { data, error } = await supabase.rpc('stock_actual_position', { p_as_of: asOfDate || null })
    if (!error && data) {
      const map = {}
      for (const row of data) {
        map[`${row.entity_id}__${row.product_id}`] = {
          entity_id: row.entity_id, product_id: row.product_id,
          opening_qty: toNum(row.opening_qty), invoiced_in: toNum(row.invoiced_in),
          invoiced_out: toNum(row.invoiced_out), adjustment_qty: toNum(row.adjustment_qty),
          actual_qty: toNum(row.actual_qty), avg_in_rate: toNum(row.avg_in_rate),
        }
      }
      return map
    }
  } catch { /* fall through to client-side computation below */ }
  const raw = filterStockDataAsOf(await fetchStockMovementData(), asOfDate)
  const actual = buildActualStockMap(raw)
  const valuation = buildStockValuationMap(raw)
  for (const key of Object.keys(actual)) actual[key].avg_in_rate = valuation[key]?.avg_rate ?? 0
  return actual
}

// Convenience for a single entity — returns { product_id: actual_qty }.
// This is what feeds LineItemsEditor's `stockMap` prop so a seller can see
// (and not oversell past) what they actually have on hand while billing.
export async function fetchEntityAvailableStock(entityId) {
  if (!entityId) return {}
  const full = await fetchActualStockPosition()
  const out  = {}
  for (const row of Object.values(full)) {
    if (row.entity_id === entityId) out[row.product_id] = row.actual_qty
  }
  return out
}

// Every stock-affecting or stock-planning line (PI, PO, Invoice) must carry a
// product_id — otherwise it silently falls out of every stock calculation
// above (see the `!row.product_id` branch in Stock Position). Call this
// before insert/update and block the save if it returns any rows.
export function findLinesMissingProductId(lines) {
  return (lines || [])
    .map((l, i) => ({ ...l, _lineNo: i + 1 }))
    .filter(l => toNum(l.qty) > 0 && !l.product_id)
}

// Returns the subset of `lines` whose qty exceeds the entity's currently
// available stock (per stockMap, e.g. from fetchEntityAvailableStock). Used
// to warn on PI (planned) and Invoice (billed) submission when the ask
// exceeds what the seller/from-entity actually has on hand.
export function findLinesExceedingStock(lines, stockMap) {
  if (!stockMap) return []
  return (lines || []).filter(l => {
    if (!l.product_id) return false
    const avail = stockMap[l.product_id]
    return avail != null && toNum(l.qty) > avail
  })
}

// Single source of truth for "where is this invoice in its life": Draft →
// Submitted → E-way Pending → Stock Moved → Cancelled/Reversed. Mirrors
// exactly the same rule fetchStockMovementData() uses to decide whether an
// invoice's lines count as an actual stock movement — an invoice is
// 'stock_moved' if and only if it would currently contribute to Actual
// Stock, so this can never drift from the real calculation.
// `key` is also a valid <Badge status=...> value (see BADGE_COLORS).
export function getInvoiceLifecycleStage(invoice) {
  if (!invoice) return { key: 'draft', label: 'Draft' }
  const hasEway = !!invoice.eway_bill_no
  if (invoice.status === 'cancelled') {
    return hasEway
      ? { key: 'overdue', label: 'Cancelled — Reversed' } // stock had moved, then reversed
      : { key: 'cancelled', label: 'Cancelled' }           // never moved, nothing to reverse
  }
  if (invoice.status === 'draft') return { key: 'draft', label: 'Draft' }
  if (hasEway) return { key: 'completed', label: 'Stock Moved' }
  return { key: 'pending', label: 'E-way Pending' }
}
