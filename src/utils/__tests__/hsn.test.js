import { describe, it, expect } from 'vitest'
import { buildHSNMap, resolveGSTRate, formatSlabSummary } from '../hsn.js'

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const fixedRow = {
  hsn_code: '1001',
  is_active: true,
  rate_type: 'fixed',
  fixed_rate: 5,
  slabs: null,
}

const slabRow = {
  hsn_code: '6109',
  is_active: true,
  rate_type: 'slab',
  fixed_rate: null,
  slabs: [
    { max_rate: 1000, gst_rate: 5  },
    { max_rate: null, gst_rate: 12 },
  ],
}

const inactiveRow = {
  hsn_code: '9999',
  is_active: false,
  rate_type: 'fixed',
  fixed_rate: 18,
  slabs: null,
}

// ─── buildHSNMap ──────────────────────────────────────────────────────────────

describe('buildHSNMap', () => {
  it('builds a Map from active HSN rows', () => {
    const map = buildHSNMap([fixedRow, slabRow])
    expect(map.size).toBe(2)
    expect(map.has('1001')).toBe(true)
    expect(map.has('6109')).toBe(true)
  })

  it('excludes inactive rows', () => {
    const map = buildHSNMap([fixedRow, inactiveRow])
    expect(map.has('9999')).toBe(false)
    expect(map.size).toBe(1)
  })

  it('trims whitespace from hsn_code keys', () => {
    const row = { ...fixedRow, hsn_code: '  1001  ' }
    const map = buildHSNMap([row])
    expect(map.has('1001')).toBe(true)
  })

  it('returns empty Map for empty array', () => {
    expect(buildHSNMap([]).size).toBe(0)
  })

  it('returns empty Map for null input', () => {
    expect(buildHSNMap(null).size).toBe(0)
  })

  it('stores the full row object as the map value', () => {
    const map = buildHSNMap([fixedRow])
    expect(map.get('1001')).toEqual(fixedRow)
  })
})

// ─── resolveGSTRate ───────────────────────────────────────────────────────────

describe('resolveGSTRate — fixed rate', () => {
  let map

  it('resolves fixed GST rate correctly', () => {
    map = buildHSNMap([fixedRow])
    const result = resolveGSTRate('1001', 500, map)
    expect(result.gst_rate).toBe(5)
    expect(result.source).toBe('hsn_fixed')
    expect(result.master).toEqual(fixedRow)
  })

  it('is not affected by ratePerUnit for fixed type', () => {
    map = buildHSNMap([fixedRow])
    const r1 = resolveGSTRate('1001', 100, map)
    const r2 = resolveGSTRate('1001', 99999, map)
    expect(r1.gst_rate).toBe(r2.gst_rate)
  })
})

describe('resolveGSTRate — slab rate', () => {
  it('applies lower slab rate when rate ≤ max_rate', () => {
    const map = buildHSNMap([slabRow])
    const result = resolveGSTRate('6109', 999, map)
    expect(result.gst_rate).toBe(5)
    expect(result.source).toBe('hsn_slab')
  })

  it('applies lower slab rate at exact boundary (rate = max_rate)', () => {
    const map = buildHSNMap([slabRow])
    const result = resolveGSTRate('6109', 1000, map)
    expect(result.gst_rate).toBe(5)
  })

  it('applies fallback slab rate when rate > max_rate', () => {
    const map = buildHSNMap([slabRow])
    const result = resolveGSTRate('6109', 1001, map)
    expect(result.gst_rate).toBe(12)
    expect(result.source).toBe('hsn_slab')
  })

  it('applies fallback slab (null max_rate) for very high rate', () => {
    const map = buildHSNMap([slabRow])
    const result = resolveGSTRate('6109', 99999, map)
    expect(result.gst_rate).toBe(12)
  })

  it('returns default when slabs array is empty', () => {
    const emptySlabRow = { ...slabRow, hsn_code: '0001', slabs: [] }
    const map = buildHSNMap([emptySlabRow])
    const result = resolveGSTRate('0001', 500, map)
    expect(result.gst_rate).toBe(null)
    expect(result.source).toBe('default')
  })
})

describe('resolveGSTRate — not found / edge cases', () => {
  it('returns default when HSN code not in map', () => {
    const map = buildHSNMap([fixedRow])
    const result = resolveGSTRate('XXXX', 500, map)
    expect(result.gst_rate).toBe(null)
    expect(result.source).toBe('default')
    expect(result.master).toBe(null)
  })

  it('returns default when hsnCode is null', () => {
    const map = buildHSNMap([fixedRow])
    expect(resolveGSTRate(null, 500, map).source).toBe('default')
  })

  it('returns default when hsnCode is empty string', () => {
    const map = buildHSNMap([fixedRow])
    expect(resolveGSTRate('', 500, map).source).toBe('default')
  })

  it('returns default when map is null', () => {
    expect(resolveGSTRate('1001', 500, null).source).toBe('default')
  })

  it('returns default when map is empty', () => {
    expect(resolveGSTRate('1001', 500, new Map()).source).toBe('default')
  })

  it('trims whitespace from hsnCode lookup', () => {
    const map = buildHSNMap([fixedRow])
    const result = resolveGSTRate('  1001  ', 500, map)
    expect(result.gst_rate).toBe(5)
  })
})

// ─── formatSlabSummary ────────────────────────────────────────────────────────

describe('formatSlabSummary', () => {
  it('formats a two-slab structure correctly', () => {
    const slabs = [
      { max_rate: 1000, gst_rate: 5  },
      { max_rate: null, gst_rate: 12 },
    ]
    const result = formatSlabSummary(slabs)
    expect(result).toContain('≤ ₹1,000')
    expect(result).toContain('5%')
    expect(result).toContain('12%')
    expect(result).toContain('|')
  })

  it('shows "All" for a single open-ended slab', () => {
    const slabs = [{ max_rate: null, gst_rate: 18 }]
    const result = formatSlabSummary(slabs)
    expect(result).toContain('All')
    expect(result).toContain('18%')
  })

  it('returns — for empty array', () => {
    expect(formatSlabSummary([])).toBe('—')
  })

  it('returns — for null', () => {
    expect(formatSlabSummary(null)).toBe('—')
  })

  it('returns — for undefined', () => {
    expect(formatSlabSummary(undefined)).toBe('—')
  })

  it('formats three slabs with correct range labels', () => {
    const slabs = [
      { max_rate: 500,  gst_rate: 5  },
      { max_rate: 1000, gst_rate: 12 },
      { max_rate: null, gst_rate: 18 },
    ]
    const result = formatSlabSummary(slabs)
    expect(result).toContain('≤ ₹500')
    expect(result).toContain('≤ ₹1,000')
    expect(result).toContain('18%')
  })
})
