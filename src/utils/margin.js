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
