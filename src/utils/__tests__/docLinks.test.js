import { describe, it, expect, vi } from 'vitest'

// docLinks.js imports the Supabase client for its fetch helpers; the pure
// functions under test never touch it.
vi.mock('../../supabaseClient', () => ({ supabase: {} }))

import { sumQtyByProduct, remainingLines, invoiceCoverage } from '../docLinks.js'

const pi = [
  { line_no: 1, product_name: 'Towel', qty: 100, rate: 50 },
  { line_no: 2, product_name: 'Bedsheet', qty: 40, rate: 200 },
]

describe('sumQtyByProduct', () => {
  it('sums by name, ignoring case and stray whitespace', () => {
    expect(sumQtyByProduct([
      { product_name: 'Towel', qty: 10 },
      { product_name: ' towel ', qty: '5.5' },
      { product_name: 'Bedsheet', qty: 2 },
    ])).toEqual({ towel: 15.5, bedsheet: 2 })
  })
  it('handles empty/undefined', () => {
    expect(sumQtyByProduct(undefined)).toEqual({})
  })
})

describe('remainingLines', () => {
  it('returns the full lines when nothing is invoiced', () => {
    expect(remainingLines(pi, [])).toEqual(pi)
  })
  it('reduces each line by what is already invoiced', () => {
    const out = remainingLines(pi, [{ product_name: 'Towel', qty: 30 }, { product_name: 'Bedsheet', qty: 10 }])
    expect(out.map(l => [l.product_name, l.qty])).toEqual([['Towel', 70], ['Bedsheet', 30]])
    expect(out[0].rate).toBe(50)
  })
  it('drops fully invoiced lines and sums several invoices', () => {
    const out = remainingLines(pi, [
      { product_name: 'Towel', qty: 60 }, { product_name: 'towel', qty: 40 },
      { product_name: 'Bedsheet', qty: 15 },
    ])
    expect(out.map(l => [l.product_name, l.qty])).toEqual([['Bedsheet', 25]])
  })
  it('never goes negative when over-invoiced', () => {
    expect(remainingLines(pi, [{ product_name: 'Towel', qty: 500 }, { product_name: 'Bedsheet', qty: 40 }])).toEqual([])
  })
  it('consumes invoiced qty top-down when a product repeats on the source', () => {
    const src = [{ product_name: 'Towel', qty: 10 }, { product_name: 'Towel', qty: 10 }]
    expect(remainingLines(src, [{ product_name: 'Towel', qty: 14 }]).map(l => l.qty)).toEqual([6])
  })
  it('keeps fractional quantities clean to 3dp', () => {
    const out = remainingLines([{ product_name: 'Yarn', qty: 10.5 }], [{ product_name: 'Yarn', qty: 0.1 }, { product_name: 'Yarn', qty: 0.2 }])
    expect(out[0].qty).toBe(10.2)
  })
  it('ignores invoiced products that are not on the source', () => {
    expect(remainingLines(pi, [{ product_name: 'Pillow', qty: 5 }])).toEqual(pi)
  })
})

describe('invoiceCoverage', () => {
  it('none when there is no invoice', () => {
    expect(invoiceCoverage(pi, [], 0)).toBe('none')
  })
  it('partial when any product is short', () => {
    expect(invoiceCoverage(pi, [{ product_name: 'Towel', qty: 100 }], 1)).toBe('partial')
    expect(invoiceCoverage(pi, [{ product_name: 'Towel', qty: 100 }, { product_name: 'Bedsheet', qty: 39.999 }], 2)).toBe('partial')
  })
  it('full when every product is covered, across invoices', () => {
    expect(invoiceCoverage(pi, [
      { product_name: 'Towel', qty: 60 }, { product_name: 'Bedsheet', qty: 40 }, { product_name: 'Towel', qty: 40 },
    ], 2)).toBe('full')
  })
  it('full when over-invoiced', () => {
    expect(invoiceCoverage(pi, [{ product_name: 'Towel', qty: 120 }, { product_name: 'Bedsheet', qty: 40 }], 1)).toBe('full')
  })
  it('a source with no lines converts on its first invoice', () => {
    expect(invoiceCoverage([], [{ product_name: 'Towel', qty: 1 }], 1)).toBe('full')
  })
})
