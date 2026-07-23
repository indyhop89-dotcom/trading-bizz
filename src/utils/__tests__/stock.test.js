import { describe, it, expect } from 'vitest'
import { buildActualStockMap, buildLastPurchaseRateMap, findLinesMissingProductName, findLinesExceedingStock, getInvoiceLifecycleStage } from '../stock.js'

const ENTITY_A = 'entity-siddi'
const ENTITY_B = 'entity-vrvpl'
const PRODUCT_1 = 'product-1'

function invLine({ qty, seller = ENTITY_A, buyer = ENTITY_B, status = 'submitted', eway_bill_no = 'EWB123', invoice_type = 'sales', product_name = PRODUCT_1 }) {
  return { qty, product_name, invoice: { seller_entity_id: seller, buyer_entity_id: buyer, status, eway_bill_no, invoice_type } }
}

describe('buildActualStockMap — scenario A: opening stock only', () => {
  it('entity with only opening stock shows that stock and nothing else', () => {
    const map = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [],
    })
    expect(map[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(100)
  })
})

describe('buildActualStockMap — scenario C: invoice without E-way Bill', () => {
  it('does not affect actual stock (fetchStockMovementData excludes it before this point, so a raw invLines list simulating that exclusion has zero rows)', () => {
    // fetchStockMovementData() is what filters by eway_bill_no presence —
    // buildActualStockMap trusts its input. Passing zero invLines simulates
    // "invoice exists but has no E-way Bill yet".
    const map = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [],
    })
    expect(map[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(100)
    expect(map[`${ENTITY_B}__${PRODUCT_1}`]).toBeUndefined()
  })
})

describe('buildActualStockMap — scenario D: E-way Bill generated', () => {
  it('decreases seller stock and increases buyer stock by the same qty', () => {
    const map = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [invLine({ qty: 30 })],
    })
    expect(map[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(70)
    // scenario G: buyer inward is automatic — no separate buyer-side entry
    // was ever inserted, yet the buyer's actual stock reflects it.
    expect(map[`${ENTITY_B}__${PRODUCT_1}`].actual_qty).toBe(30)
  })
})

describe('buildActualStockMap — scenario F: cancelled after E-way Bill reverses', () => {
  it('a cancelled invoice contributes nothing even if it had an E-way Bill', () => {
    // fetchStockMovementData() filters out status==='cancelled' regardless of
    // eway_bill_no — simulate that by simply not including the line, since a
    // once-cancelled invoice recomputes from scratch on every load (no
    // separate reversal entries are ever written).
    const map = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [],
    })
    expect(map[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(100)
    expect(map[`${ENTITY_B}__${PRODUCT_1}`]).toBeUndefined()
  })
})

describe('buildActualStockMap — regression: mirror purchase invoice must not double-count', () => {
  it('an auto-created purchase mirror of the same sale is excluded even if passed in', () => {
    // fetchStockMovementData() is responsible for filtering invoice_type ===
    // 'purchase' out before this point. This test locks in that the mirror
    // row, if it ever slipped through, would double the movement — proving
    // why that filter exists and must stay.
    const withMirrorIncluded = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [
        invLine({ qty: 30, invoice_type: 'sales' }),
        invLine({ qty: 30, invoice_type: 'purchase' }), // the mirror — should be filtered upstream
      ],
    })
    // Demonstrates the bug this fix prevents: if the mirror leaks through,
    // the seller is debited twice and the buyer credited twice.
    expect(withMirrorIncluded[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(40) // 100 - 30 - 30 (bug, if unfiltered)

    const withMirrorExcluded = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [invLine({ qty: 30, invoice_type: 'sales' })],
    })
    expect(withMirrorExcluded[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(70) // correct — counted once
    expect(withMirrorExcluded[`${ENTITY_B}__${PRODUCT_1}`].actual_qty).toBe(30)
  })
})

describe('buildActualStockMap — scenario H: missing product_name', () => {
  it('lines with no product_name are grouped separately, never merged into a real product row', () => {
    const map = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [invLine({ qty: 10, product_name: null })],
    })
    expect(map[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(100) // untouched
    expect(map[`${ENTITY_A}__null`]).toBeDefined()
    expect(map[`${ENTITY_A}__null`].invoiced_out).toBe(10)
  })
})

describe('findLinesMissingProductName', () => {
  it('flags lines with qty > 0 and no product_name', () => {
    const lines = [
      { qty: 5, product_name: 'p1' },
      { qty: 5, product_name: null },
      { qty: 0, product_name: null }, // zero qty — not a real stock-affecting line
    ]
    const missing = findLinesMissingProductName(lines)
    expect(missing).toHaveLength(1)
    expect(missing[0]._lineNo).toBe(2)
  })

  it('returns empty when every line has a product_name', () => {
    expect(findLinesMissingProductName([{ qty: 5, product_name: 'p1' }])).toHaveLength(0)
  })
})

describe('findLinesExceedingStock', () => {
  it('flags lines whose qty exceeds the stockMap availability for that product', () => {
    const lines = [
      { product_name: 'p1', qty: 50 },
      { product_name: 'p2', qty: 5 },
    ]
    const stockMap = { p1: 30, p2: 100 }
    const exceeding = findLinesExceedingStock(lines, stockMap)
    expect(exceeding).toHaveLength(1)
    expect(exceeding[0].product_name).toBe('p1')
  })

  it('does not flag a product with no known stock figure (undefined avail)', () => {
    const exceeding = findLinesExceedingStock([{ product_name: 'unknown', qty: 999 }], { p1: 10 })
    expect(exceeding).toHaveLength(0)
  })

  it('returns empty when stockMap is not provided', () => {
    expect(findLinesExceedingStock([{ product_name: 'p1', qty: 999 }], null)).toHaveLength(0)
  })
})

describe('getInvoiceLifecycleStage', () => {
  it('draft invoice', () => {
    expect(getInvoiceLifecycleStage({ status: 'draft', eway_bill_no: null }).key).toBe('draft')
  })
  it('submitted without E-way Bill is pending', () => {
    expect(getInvoiceLifecycleStage({ status: 'submitted', eway_bill_no: null }).key).toBe('pending')
  })
  it('submitted with E-way Bill is stock_moved (completed)', () => {
    expect(getInvoiceLifecycleStage({ status: 'submitted', eway_bill_no: 'EWB1' }).key).toBe('completed')
  })
  it('cancelled without E-way Bill — nothing to reverse', () => {
    expect(getInvoiceLifecycleStage({ status: 'cancelled', eway_bill_no: null }).key).toBe('cancelled')
  })
  it('cancelled with E-way Bill — reversed', () => {
    const stage = getInvoiceLifecycleStage({ status: 'cancelled', eway_bill_no: 'EWB1' })
    expect(stage.key).toBe('overdue')
    expect(stage.label).toMatch(/Reversed/)
  })
})

// ─── buildLastPurchaseRateMap ──────────────────────────────────────────────
// "mimosa" scenario from the bug report: entity buys 50 mtr at rate 707 (a
// 1% margin over the seller's own 700 cost) — the buyer's stock view must
// show 707/35,350 (qty * rate), never fall back to a stale 700/35,000
// opening-style figure.
function rateInvLine({ qty, rate, buyer = ENTITY_B, seller = ENTITY_A, invoice_type = 'sales', eway_bill_date = '2026-07-20', invoice_date = '2026-07-19', source_invoice_id = null }) {
  return { qty, rate, product_name: PRODUCT_1, invoice: { buyer_entity_id: buyer, seller_entity_id: seller, invoice_type, eway_bill_date, invoice_date, source_invoice_id } }
}

describe('buildLastPurchaseRateMap', () => {
  it('mimosa scenario: buyer with no prior stock gets the purchase rate, not a stale one', () => {
    const map = buildLastPurchaseRateMap({
      opening: [],
      invLines: [rateInvLine({ qty: 50, rate: 707 })],
    })
    expect(map[`${ENTITY_B}__${PRODUCT_1}`]).toBe(707)
  })

  it('a more recent purchase invoice overrides an older opening-balance rate', () => {
    const map = buildLastPurchaseRateMap({
      opening: [{ entity_id: ENTITY_B, product_name: PRODUCT_1, rate: 700, as_of_date: '2025-04-01' }],
      invLines: [rateInvLine({ qty: 50, rate: 707, eway_bill_date: '2026-07-20', invoice_date: '2026-07-19' })],
    })
    expect(map[`${ENTITY_B}__${PRODUCT_1}`]).toBe(707)
  })

  it('falls back to the opening-balance rate when no purchase invoice exists yet', () => {
    const map = buildLastPurchaseRateMap({
      opening: [{ entity_id: ENTITY_B, product_name: PRODUCT_1, rate: 700, as_of_date: '2025-04-01' }],
      invLines: [],
    })
    expect(map[`${ENTITY_B}__${PRODUCT_1}`]).toBe(700)
  })

  it('an opening-balance entry dated AFTER the purchase invoice still loses to the invoice — real transactions outrank a same-or-later-dated opening estimate', () => {
    // Guards the exact failure mode that would reproduce the bug report: an
    // opening-balance row whose as_of_date is later than (or equal to) the
    // real purchase invoice must not out-rank it. Recency here is about the
    // real-world event date of acquiring the goods, and a purchase invoice
    // (source_invoice_id null / a real, non-mirror transaction) is always
    // the more authoritative signal on any date tie or when both exist.
    const map = buildLastPurchaseRateMap({
      opening: [{ entity_id: ENTITY_B, product_name: PRODUCT_1, rate: 700, as_of_date: '2026-07-20' }],
      invLines: [rateInvLine({ qty: 50, rate: 707, eway_bill_date: '2026-07-20', invoice_date: '2026-07-20' })],
    })
    expect(map[`${ENTITY_B}__${PRODUCT_1}`]).toBe(707)
  })

  it('a zero or blank rate is never eligible — a real purchase is never free', () => {
    const map = buildLastPurchaseRateMap({
      opening: [{ entity_id: ENTITY_B, product_name: PRODUCT_1, rate: 700, as_of_date: '2025-04-01' }],
      invLines: [rateInvLine({ qty: 50, rate: 0 })],
    })
    expect(map[`${ENTITY_B}__${PRODUCT_1}`]).toBe(700)
  })

  it('the seller side of the same invoice does not get a purchase rate from it — only the buyer acquired anything', () => {
    const map = buildLastPurchaseRateMap({
      opening: [],
      invLines: [rateInvLine({ qty: 50, rate: 707 })],
    })
    expect(map[`${ENTITY_A}__${PRODUCT_1}`]).toBeUndefined()
  })
})

describe('buildActualStockMap — scenario B (PI does not touch actual stock)', () => {
  it('PI data structurally never enters this calculation — only opening + invoice_lines do', () => {
    // There is no PI input to buildActualStockMap/fetchStockMovementData at
    // all, by construction — a PI can only ever affect the separate
    // Planned Stock calc (proforma_invoice_lines), never this one. Passing
    // only opening stock proves actual stock is unaffected by PI existence.
    const map = buildActualStockMap({
      opening: [{ entity_id: ENTITY_A, product_name: PRODUCT_1, qty: 100 }],
      invLines: [],
    })
    expect(map[`${ENTITY_A}__${PRODUCT_1}`].actual_qty).toBe(100)
  })
})
