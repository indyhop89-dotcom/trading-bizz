import { describe, it, expect } from 'vitest'
import { summarizeTranches, computeInvoiceOutstanding, groupTranchesByInvoice, buildEntityLedger } from '../payments.js'

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

describe('buildEntityLedger', () => {
  it('includes a standalone entry recorded directly against the entity, using its direction as-is', () => {
    const rows = buildEntityLedger('A', {
      entityPayments: [{ id: 'ep1', entity_id: 'A', party_entity_id: 'B', direction: 'paid', amount: 100, actual_payment_date: '2026-01-01' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'entity_payment', inbound: false, amount: 100 })
  })

  it('flips the direction for a standalone entry where the entity is the counterparty', () => {
    const rows = buildEntityLedger('B', {
      entityPayments: [{ id: 'ep1', entity_id: 'A', party_entity_id: 'B', direction: 'paid', amount: 100, actual_payment_date: '2026-01-01' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'entity_payment', inbound: true, amount: 100 })
  })

  it('treats invoice_payments as outbound when the entity is the payer', () => {
    const rows = buildEntityLedger('A', {
      invoicePayments: [{ id: 'ip1', entity_id: 'A', party_entity_id: 'B', amount: 900, tcs_amount: 0, actual_payment_date: '2026-01-02' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'invoice_payment', inbound: false, amount: 900 })
  })

  it('treats invoice_payments as inbound (amount + tcs_amount) when the entity is the seller', () => {
    const rows = buildEntityLedger('B', {
      invoicePayments: [{ id: 'ip1', entity_id: 'A', party_entity_id: 'B', amount: 900, tcs_amount: 90, actual_payment_date: '2026-01-02' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'invoice_payment', inbound: true, amount: 990 })
  })

  it('sorts merged rows chronologically and accumulates a running balance', () => {
    const rows = buildEntityLedger('A', {
      entityPayments: [{ id: 'ep1', entity_id: 'A', direction: 'received', amount: 500, actual_payment_date: '2026-01-03' }],
      invoicePayments: [{ id: 'ip1', entity_id: 'A', amount: 200, tcs_amount: 0, actual_payment_date: '2026-01-01' }],
    })
    expect(rows.map(r => r.id)).toEqual(['ip1', 'ep1'])
    expect(rows[0].runningBalance).toBe(-200)
    expect(rows[1].runningBalance).toBe(300)
  })

  it('ignores rows unrelated to the given entity', () => {
    const rows = buildEntityLedger('A', {
      entityPayments: [{ id: 'ep1', entity_id: 'B', party_entity_id: 'C', direction: 'paid', amount: 100, actual_payment_date: '2026-01-01' }],
    })
    expect(rows).toHaveLength(0)
  })
})
