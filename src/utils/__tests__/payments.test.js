import { describe, it, expect, vi } from 'vitest'

// payments.js imports the Supabase client; these tests only cover the pure helpers.
vi.mock('../../supabaseClient.js', () => ({ supabase: {} }))
import { summarizeTranches, computeInvoiceOutstanding, groupTranchesByInvoice, buildEntityLedger, groupSettlementsByInvoice, settlementFor, pairSetoffs, journalFormat } from '../payments.js'
import { nextFromExisting } from '../numbering.js'

describe('summarizeTranches', () => {
  it('sums cash amount and adjustments; payment-row TDS is history only', () => {
    const tranches = [
      { amount: 1000, tds_amount: 100, adjustments: 0 },
      { amount: 500, tds_amount: 0, adjustments: 50 },
    ]
    expect(summarizeTranches(tranches)).toEqual({ paidSum: 1500, adjSum: 50 })
  })
  it('handles empty/undefined tranches', () => {
    expect(summarizeTranches(undefined)).toEqual({ paidSum: 0, adjSum: 0 })
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
  it('ignores tds_amount on payment rows (it was copied to the register)', () => {
    const r = computeInvoiceOutstanding({ total_amount: 1000 }, [{ amount: 900, tds_amount: 100 }])
    expect(r.pending).toBe(100)
    expect(r.tdsSum).toBe(0)
  })
  it('register TDS reduces pending; TCS does not', () => {
    const r = computeInvoiceOutstanding({ total_amount: 1000 }, [{ amount: 900 }], {
      tdsEntries: [{ entry_type: 'tds', amount: 100 }, { entry_type: 'tcs', amount: 1 }],
    })
    expect(r.tdsSum).toBe(100)
    expect(r.pending).toBe(0)
  })
  it('set-offs reduce pending', () => {
    const r = computeInvoiceOutstanding({ total_amount: 1000 }, [], { setoffs: [{ amount: 400 }, { amount: 100, is_deleted: true }] })
    expect(r.setoffSum).toBe(400)
    expect(r.pending).toBe(600)
  })
})

describe('groupSettlementsByInvoice', () => {
  it('puts a set-off on both of its invoices', () => {
    const map = groupSettlementsByInvoice(
      [{ invoice_id: 'p1', entry_type: 'tds', amount: 10 }],
      [{ id: 'o1', sales_invoice_id: 's1', purchase_invoice_id: 'p1', amount: 50 }],
    )
    expect(settlementFor(map, 's1').setoffs).toHaveLength(1)
    expect(settlementFor(map, 'p1').setoffs).toHaveLength(1)
    expect(settlementFor(map, 'p1').tdsEntries).toHaveLength(1)
    expect(settlementFor(map, 'x').setoffs).toHaveLength(0)
  })
})

describe('pairSetoffs', () => {
  it('pairs first come first served', () => {
    const out = pairSetoffs(
      [{ invoice_id: 's1', amount: 300 }, { invoice_id: 's2', amount: 200 }],
      [{ invoice_id: 'p1', amount: 250 }, { invoice_id: 'p2', amount: 250 }],
    )
    expect(out).toEqual([
      { sales_invoice_id: 's1', purchase_invoice_id: 'p1', amount: 250 },
      { sales_invoice_id: 's1', purchase_invoice_id: 'p2', amount: 50 },
      { sales_invoice_id: 's2', purchase_invoice_id: 'p2', amount: 200 },
    ])
  })
  it('handles paise and skips zero amounts', () => {
    const out = pairSetoffs([{ invoice_id: 's1', amount: '100.50' }, { invoice_id: 's0', amount: 0 }], [{ invoice_id: 'p1', amount: 100.5 }])
    expect(out).toEqual([{ sales_invoice_id: 's1', purchase_invoice_id: 'p1', amount: 100.5 }])
  })
})

describe('journalFormat', () => {
  it('builds SHORT/JV/26-27/0001', () => {
    expect(nextFromExisting(journalFormat('kv'), '2026-11-27', [])).toBe('KV/JV/26-27/0001')
    expect(nextFromExisting(journalFormat('KV'), '2026-11-27', ['KV/JV/26-27/0004'])).toBe('KV/JV/26-27/0005')
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
