// Order lifecycle derivation — a single place that answers "given this
// order's legs and the PI/PO/Invoice activity on them, what status should
// the order be in, and which leg is it currently at?". Both the Orders list
// and the Order detail page compute this on load and write the status back
// when it has advanced, so order status can never silently lag behind what
// the legs actually show.

export const ORDER_STATUSES = ['planned', 'open', 'in_progress', 'completed', 'cancelled']

const STATUS_RANK = { planned: 0, open: 1, in_progress: 2, completed: 3 }

// Orders that can still have documents (PI/PO/Invoice) raised against them —
// everything not finished. Creation dropdowns filter with this so completed/
// cancelled orders stop cluttering the pick list; a document already linked
// to a closed order keeps showing it (callers OR in the current selection).
export function isOrderOpenForDocs(o) {
  return !!o && !['completed', 'cancelled'].includes(o.status)
}

const activeDocs = docs => (docs || []).filter(d => d.status !== 'cancelled')

// An invoice counts as "stock moved" under exactly the same rule the stock
// calculation uses (see stock.js's MOVEMENT_STATUSES_EXCLUDED): E-way Bill
// set and not cancelled. Deliberately NOT gated on draft — the EWB section
// isn't locked for draft invoices, so a real E-way Bill can exist on one,
// and that's what actually moved the goods regardless of the document's own
// internal status label.
const invoiceMoved = inv => !!inv.eway_bill_no && inv.status !== 'cancelled'

// docsByLeg: { [legId]: { pis: [], pos: [], invoices: [] } } — rows only need
// `status` (and `eway_bill_no` for invoices).
//
// Rules: 'cancelled' is always manual and never overridden. Otherwise the
// status only ever auto-ADVANCES (planned/open → in_progress → completed) —
// a manually set further-along status is respected, so historical orders
// tracked outside the system don't get flipped backwards.
export function deriveOrderStatus(order, legs, docsByLeg) {
  if (!order || order.status === 'cancelled') return order?.status || null
  let derived = order.status
  if (legs?.length) {
    let anyActivity = false
    let allMoved = true
    for (const leg of legs) {
      const d = docsByLeg?.[leg.id] || {}
      const invs = activeDocs(d.invoices)
      if (invs.length || activeDocs(d.pis).length || activeDocs(d.pos).length) anyActivity = true
      if (!invs.some(invoiceMoved)) allMoved = false
    }
    if (allMoved) derived = 'completed'
    else if (anyActivity) derived = 'in_progress'
  }
  return (STATUS_RANK[derived] ?? 0) > (STATUS_RANK[order.status] ?? 0) ? derived : order.status
}

// Where the order currently stands: the furthest leg with any document
// activity, plus how far that leg itself has progressed. Returns
// { legNo, totalLegs, stage } — legNo is null when nothing has started.
export function getOrderProgress(legs, docsByLeg) {
  if (!legs?.length) return null
  let current = null
  let stage = 'Not started'
  for (const leg of [...legs].sort((a, b) => a.leg_no - b.leg_no)) {
    const d = docsByLeg?.[leg.id] || {}
    const invs = activeDocs(d.invoices)
    const pos = activeDocs(d.pos)
    const pis = activeDocs(d.pis)
    if (!invs.length && !pos.length && !pis.length) continue
    current = leg
    if (invs.some(invoiceMoved)) stage = 'Stock moved'
    else if (invs.length) stage = 'Invoiced'
    else if (pos.length) stage = 'PO raised'
    else stage = 'PI raised'
  }
  return { legNo: current?.leg_no ?? null, totalLegs: legs.length, stage }
}
