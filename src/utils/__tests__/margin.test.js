import { describe, it, expect } from 'vitest'
import {
  calcSellRate,
  calcMarginPct,
  calcBlendedCost,
  calcLegItemBlendedCost,
  applyMarginToAll,
} from '../margin.js'

// ─── calcSellRate ──────────────────────────────────────────────────────────────

describe('calcSellRate', () => {
  it('calculates sell rate at 10% margin on ₹1000 cost', () => {
    expect(calcSellRate(1000, 10)).toBe(1100)
  })

  it('calculates sell rate at 0% margin (sell = cost)', () => {
    expect(calcSellRate(1000, 0)).toBe(1000)
  })

  it('calculates sell rate at 100% margin (sell = 2× cost)', () => {
    expect(calcSellRate(500, 100)).toBe(1000)
  })

  it('rounds fractional result to whole rupee', () => {
    // 1000 * 1.15 = 1150 — clean
    expect(calcSellRate(1000, 15)).toBe(1150)
  })

  it('rounds when result has fraction', () => {
    // 3 * 1.1 = 3.3 → rounds to 3
    expect(calcSellRate(3, 10)).toBe(3)
  })

  it('handles string inputs via Number coercion', () => {
    expect(calcSellRate('1000', '20')).toBe(1200)
  })

  it('returns 0 when cost is 0', () => {
    expect(calcSellRate(0, 50)).toBe(0)
  })

  it('handles negative margin (sell < cost)', () => {
    expect(calcSellRate(1000, -10)).toBe(900)
  })
})

// ─── calcMarginPct ────────────────────────────────────────────────────────────

describe('calcMarginPct', () => {
  it('calculates 10% margin correctly', () => {
    expect(calcMarginPct(1000, 1100)).toBe(10)
  })

  it('returns 0% margin when sell equals cost', () => {
    expect(calcMarginPct(1000, 1000)).toBe(0)
  })

  it('calculates 100% margin (double cost)', () => {
    expect(calcMarginPct(500, 1000)).toBe(100)
  })

  it('calculates negative margin (sell below cost)', () => {
    expect(calcMarginPct(1000, 900)).toBe(-10)
  })

  it('returns 0 when cost is 0', () => {
    expect(calcMarginPct(0, 1000)).toBe(0)
  })

  it('returns 0 when cost is null', () => {
    expect(calcMarginPct(null, 1000)).toBe(0)
  })

  it('handles string inputs via Number coercion', () => {
    expect(calcMarginPct('800', '1000')).toBe(25)
  })
})

// ─── calcBlendedCost ──────────────────────────────────────────────────────────

describe('calcBlendedCost', () => {
  it('calculates weighted average from two equal-qty sources', () => {
    const sources = [
      { qty: 100, costPaise: 1000 },
      { qty: 100, costPaise: 2000 },
    ]
    expect(calcBlendedCost(sources)).toBe(1500)
  })

  it('weights heavier-qty source more', () => {
    const sources = [
      { qty: 200, costPaise: 1000 },
      { qty: 100, costPaise: 2000 },
    ]
    // (200×1000 + 100×2000) / 300 = 400000/300 = 1333.33 → rounds to 1333
    expect(calcBlendedCost(sources)).toBe(1333)
  })

  it('returns the single source cost when only one source', () => {
    expect(calcBlendedCost([{ qty: 50, costPaise: 1500 }])).toBe(1500)
  })

  it('returns 0 when total qty is 0', () => {
    const sources = [
      { qty: 0, costPaise: 1000 },
      { qty: 0, costPaise: 2000 },
    ]
    expect(calcBlendedCost(sources)).toBe(0)
  })

  it('rounds to whole number', () => {
    // 1 × 1 + 1 × 2 = 3 / 2 = 1.5 → rounds to 2
    expect(calcBlendedCost([{ qty: 1, costPaise: 1 }, { qty: 1, costPaise: 2 }])).toBe(2)
  })

  it('handles three sources', () => {
    const sources = [
      { qty: 10, costPaise: 100 },
      { qty: 10, costPaise: 200 },
      { qty: 10, costPaise: 300 },
    ]
    // (1000 + 2000 + 3000) / 30 = 200
    expect(calcBlendedCost(sources)).toBe(200)
  })
})

// ─── calcLegItemBlendedCost ───────────────────────────────────────────────────

describe('calcLegItemBlendedCost', () => {
  it('blends previous leg cost and inventory cost correctly', () => {
    // 100 × 1000 + 100 × 2000 = 300000 / 200 = 1500
    expect(calcLegItemBlendedCost(100, 1000, 100, 2000)).toBe(1500)
  })

  it('returns inventory cost when previous leg qty is 0', () => {
    expect(calcLegItemBlendedCost(0, 0, 50, 1200)).toBe(1200)
  })

  it('returns prev leg cost when inventory qty is 0', () => {
    expect(calcLegItemBlendedCost(50, 800, 0, 0)).toBe(800)
  })

  it('returns 0 when all qtys are 0', () => {
    expect(calcLegItemBlendedCost(0, 0, 0, 0)).toBe(0)
  })
})

// ─── applyMarginToAll ─────────────────────────────────────────────────────────

describe('applyMarginToAll', () => {
  it('applies margin to all line items and sets sellRate', () => {
    const items = [
      { id: 1, blendedCost: 1000 },
      { id: 2, blendedCost: 2000 },
    ]
    const result = applyMarginToAll(items, 10)
    expect(result[0].sellRate).toBe(1100)
    expect(result[0].marginPct).toBe(10)
    expect(result[1].sellRate).toBe(2200)
    expect(result[1].marginPct).toBe(10)
  })

  it('falls back to costPaise when blendedCost is absent', () => {
    const items = [{ id: 1, costPaise: 500 }]
    const result = applyMarginToAll(items, 20)
    expect(result[0].sellRate).toBe(600)
  })

  it('preserves all existing fields on each item', () => {
    const items = [{ id: 99, name: 'Widget', blendedCost: 100 }]
    const result = applyMarginToAll(items, 0)
    expect(result[0].id).toBe(99)
    expect(result[0].name).toBe('Widget')
  })

  it('returns empty array when given empty array', () => {
    expect(applyMarginToAll([], 10)).toEqual([])
  })

  it('applies 0% margin — sell rate equals cost', () => {
    const items = [{ blendedCost: 1000 }]
    const result = applyMarginToAll(items, 0)
    expect(result[0].sellRate).toBe(1000)
  })
})
