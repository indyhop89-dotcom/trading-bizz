import { supabase } from '../supabaseClient'
import { toNum } from './money'
import { fetchAllPages } from './query'

// Invoice statuses that are never real movements regardless of dispatch —
// 'draft' invoices haven't been sent yet, 'cancelled' invoices never
// happened. Kept separately from the E-way Bill check below because a
// cancelled invoice must never count even if it happened to have an
// E-way Bill number entered before it was cancelled.
const MOVEMENT_STATUSES_EXCLUDED = ['draft', 'cancelled']

// Raw data fetch — shared by both consumers below so we only hit the DB once
// per page load rather than once per entity.
export async function fetchStockMovementData() {
  // CHANGED: both tables can exceed PostgREST's default 1000-row response
  // cap — a plain .select() silently truncates rather than erroring, which
  // undercounts opening/actual stock once either table grows past 1000 rows.
  const [{ data: opening }, { data: invLines }] = await Promise.all([
    fetchAllPages(() => supabase.from('stock_opening_balance').select('entity_id, product_id, qty')),
    fetchAllPages(() => supabase.from('invoice_lines')
      .select('qty, product_id, invoice:invoice_id(seller_entity_id, buyer_entity_id, status, eway_bill_no, invoice_type)')
      .not('invoice', 'is', null)),
  ])
  return {
    opening: opening || [],
    // CHANGED: goods only count as physically moved once an E-way Bill has
    // actually been entered on the invoice — raising or submitting an
    // invoice alone doesn't move stock, dispatch does. Because this whole
    // map is recomputed live from source data on every call (never stored),
    // cancelling an invoice after its E-way Bill was done automatically
    // reverses the movement on the very next load — no separate reversal
    // step needed. If the same trade is redone as a fresh invoice later,
    // it's evaluated independently and follows the same rule from scratch.
    //
    // invoice_type='purchase' rows are excluded here: those are auto-created
    // bookkeeping mirrors of a 'sales' invoice for the buyer's own purchase
    // register (see Invoices auto-complete-on-E-way-Bill flow) and represent
    // the exact same physical movement, not a second one. Counting them too
    // would double the qty on both sides.
    invLines: (invLines || []).filter(l =>
      l.invoice &&
      !MOVEMENT_STATUSES_EXCLUDED.includes(l.invoice.status) &&
      !!l.invoice.eway_bill_no &&
      l.invoice.invoice_type !== 'purchase'
    ),
  }
}

// Builds { "entityId__productId": { entity_id, product_id, opening_qty, invoiced_in, invoiced_out, actual_qty } }
// actual_qty = opening + goods invoiced in (as buyer) - goods invoiced out (as seller)
export function buildActualStockMap({ opening, invLines }) {
  const map = {}
  function ensure(entityId, productId) {
    const key = `${entityId}__${productId}`
    if (!map[key]) map[key] = { entity_id: entityId, product_id: productId, opening_qty: 0, invoiced_in: 0, invoiced_out: 0 }
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
  for (const row of Object.values(map)) {
    row.actual_qty = row.opening_qty + row.invoiced_in - row.invoiced_out
  }
  return map
}

// Convenience for a single entity — returns { product_id: actual_qty }.
// This is what feeds LineItemsEditor's `stockMap` prop so a seller can see
// (and not oversell past) what they actually have on hand while billing.
export async function fetchEntityAvailableStock(entityId) {
  if (!entityId) return {}
  const raw  = await fetchStockMovementData()
  const full = buildActualStockMap(raw)
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
