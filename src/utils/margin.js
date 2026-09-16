import { round2 } from './money'

// Margin is always markup on cost price
// Sell Price = Cost × (1 + margin% / 100)

// Calculate sell rate from cost and margin
// CHANGED: was Math.round() — whole-rupee rounding — but every rate in this
// app is a rupee amount with 2 decimal places (see round2 in money.js), so a
// margin-applied rate was silently losing its paise on every copy/apply.
export function calcSellRate(costPaise, marginPct) {
  return round2(Number(costPaise) * (1 + Number(marginPct) / 100))
}

// Calculate margin % from cost and sell rate
export function calcMarginPct(costPaise, sellPaise) {
  if (!costPaise || costPaise === 0) return 0
  return ((Number(sellPaise) - Number(costPaise)) / Number(costPaise)) * 100
}

// Blended average cost for same item from multiple sources
// sources = [{ qty, costPaise }, { qty, costPaise }, ...]
export function calcBlendedCost(sources) {
  const totalQty = sources.reduce((s, x) => s + Number(x.qty), 0)
  if (totalQty === 0) return 0
  const totalValue = sources.reduce((s, x) => s + Number(x.qty) * Number(x.costPaise), 0)
  return Math.round(totalValue / totalQty)
}

// Calculate blended cost for a leg stock item
// prevLegQty + prevLegCost from previous leg
// inventoryQty + inventoryCost from entity inventory added
export function calcLegItemBlendedCost(prevLegQty, prevLegCostPaise, inventoryQty, inventoryCostPaise) {
  return calcBlendedCost([
    { qty: prevLegQty, costPaise: prevLegCostPaise },
    { qty: inventoryQty, costPaise: inventoryCostPaise },
  ])
}

// Apply margin to all line items
export function applyMarginToAll(lineItems, marginPct) {
  return lineItems.map(item => ({
    ...item,
    marginPct: Number(marginPct),
    sellRate: calcSellRate(item.blendedCost || item.costPaise, marginPct),
  }))
}

const MATCH_EPS = 1e-6

// Matches a middleman's purchase invoice lines to their sale invoice lines
// for the Margin Report (Reports → Margin Report), for whatever wasn't
// already resolved by an exact Order/leg pairing. There's no lot/batch id in
// the data (see migration 046_product_name_as_key.sql — product identity is
// name-based), so a purchase is matched to a sale of the SAME product_name,
// oldest unmatched purchase covering oldest unmatched sale first (FIFO), with
// the added constraint that a purchase lot can only cover a sale on or after
// its own invoice_date — a lot can't fund a sale that happened before it was
// bought. A sale that outruns every available lot (oversold, e.g. from
// opening stock or a supplier excluded by the report's filter) is returned
// unmatched on the sale side; purchased qty never resold is returned
// unmatched on the purchase side.
//
// Each input line: { invoice_id, invoice_no, invoice_date, product_name, qty, rate, ...passthrough }.
// Returns a flat array of:
//   matched:   { matched: true, product_name, qty, purchase, sale, purchaseRate, saleRate }
//   unmatched: { matched: false, side: 'purchase'|'sale', product_name, qty, purchase|sale }
export function matchPurchasesToSales(purchaseLines, saleLines) {
  const rows = []
  const byProduct = {}
  const bucket = name => (byProduct[name] ||= { p: [], s: [] })
  for (const p of purchaseLines) bucket(p.product_name).p.push(p)
  for (const s of saleLines) bucket(s.product_name).s.push(s)

  const byDate = (a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || '') || String(a.invoice_id).localeCompare(String(b.invoice_id))

  for (const [product_name, { p, s }] of Object.entries(byProduct)) {
    const lots = p.map(x => ({ ...x, remaining: Number(x.qty) || 0 })).sort(byDate)
    const sales = [...s].sort(byDate)
    for (const sale of sales) {
      let remaining = Number(sale.qty) || 0
      while (remaining > MATCH_EPS) {
        const lot = lots.find(l => l.remaining > MATCH_EPS && l.invoice_date <= sale.invoice_date)
        if (!lot) { rows.push({ matched: false, side: 'sale', product_name, qty: remaining, sale }); break }
        const take = Math.min(lot.remaining, remaining)
        rows.push({ matched: true, product_name, qty: take, purchase: lot, sale, purchaseRate: Number(lot.rate) || 0, saleRate: Number(sale.rate) || 0 })
        lot.remaining -= take
        remaining -= take
      }
    }
    for (const lot of lots) {
      if (lot.remaining > MATCH_EPS) rows.push({ matched: false, side: 'purchase', product_name, qty: lot.remaining, purchase: lot })
    }
  }
  return rows
}
