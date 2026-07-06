import { describe, it, expect } from 'vitest'
import { summarizeTranches, computeInvoiceOutstanding, groupTranchesByInvoice } from '../payments.js'

describe('summarizeTranches', () => {
  it('sums amount, tds_amount, and adjustments across tranches', () => {
    const tranches = [
      { amount: 1000, tds_amount: 100, adjustments: 0 },
      { amount: 500, tds_amount: 0, adjustments: 50 },
    ]
    expect(summarizeTranches(tranches)).toEqual({ paidSum: 1500, tdsSum: 100, adjSum: 50, settled: 1650 })
  })
  it('handles empty/undefined tranches', () => {
    expect(summarizeTranches(undefined)).toEqual({ paidSum: 0, tdsSum: 0, adjSum: 0, settled: 0 })
  })
})

describe('computeInvoiceOutstanding', () => {
  it('pending = total_amount - settled', () => {
    const invoice = { total_amount: 10000 }
    const tranches = [{ amount: 4000, tds_amount: 0, adjustments: 0 }]
    expect(computeInvoiceOutstanding(invoice, tranches).pending).toBe(6000)
  })
  it('floors at 0 when overpaid/over-adjusted', () => {
    const invoice = { total_amount: 1000 }
    const tranches = [{ amount: 1500, tds_amount: 0, adjustments: 0 }]
    expect(computeInvoiceOutstanding(invoice, tranches).pending).toBe(0)
  })
  it('fully pending when no tranches recorded', () => {
    const invoice = { total_amount: 5000 }
    expect(computeInvoiceOutstanding(invoice, []).pending).toBe(5000)
  })
})

describe('groupTranchesByInvoice', () => {
  it('groups tranches by invoice_id, skipping rows with no invoice_id', () => {
    const tranches = [
      { invoice_id: 'a', amount: 100 },
      { invoice_id: 'a', amount: 200 },
      { invoice_id: 'b', amount: 50 },
      { invoice_id: null, amount: 999 },
    ]
    const map = groupTranchesByInvoice(tranches)
    expect(map.get('a')).toHaveLength(2)
    expect(map.get('b')).toHaveLength(1)
    expect(map.has(null)).toBe(false)
  })
})
