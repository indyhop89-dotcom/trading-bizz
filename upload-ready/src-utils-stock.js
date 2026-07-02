import { supabase } from '../supabaseClient'
import { toNum } from './money'

// Invoice statuses that represent goods having actually moved. 'draft'
// invoices haven't been sent yet (see access-control rollout — draft is
// private to the seller) and 'cancelled' invoices never happened, so
// neither should affect real stock.
const MOVEMENT_STATUSES_EXCLUDED = ['draft', 'cancelled']

// Raw data fetch — shared by both consumers below so we only hit the DB once
// per page load rather than once per entity.
export async function fetchStockMovementData() {
  const [{ data: opening }, { data: invLines }] = await Promise.all([
    supabase.from('stock_opening_balance').select('entity_id, product_id, qty'),
    supabase.from('invoice_lines')
      .select('qty, product_id, invoice:invoice_id(seller_entity_id, buyer_entity_id, status)')
      .not('invoice', 'is', null),
  ])
  return {
    opening: opening || [],
    invLines: (invLines || []).filter(l => l.invoice && !MOVEMENT_STATUSES_EXCLUDED.includes(l.invoice.status)),
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
