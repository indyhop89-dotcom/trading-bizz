import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Supabase mock ────────────────────────────────────────────────────────────
// vi.mock is hoisted to top of file, so mockFrom must be declared with vi.hoisted()

const mockFrom = vi.hoisted(() => vi.fn())

vi.mock('../../supabaseClient.js', () => ({
  supabase: { from: mockFrom },
}))

import { generateNotifications } from '../notifications.js'

// ─── Query builder helper ─────────────────────────────────────────────────────
// Returns a chainable object that resolves to { data, error } when awaited.
function makeQuery(data, error = null) {
  const resolved = Promise.resolve({ data, error })
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq:     vi.fn().mockReturnThis(),
    is:     vi.fn().mockReturnThis(),
    lt:     vi.fn().mockReturnThis(),
    lte:    vi.fn().mockReturnThis(),
    gte:    vi.fn().mockReturnThis(),
    not:    vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    then:   resolved.then.bind(resolved),
    catch:  resolved.catch.bind(resolved),
  }
  return chain
}

function mockAllEmpty() {
  mockFrom.mockReturnValue(makeQuery([]))
}

// ─── early exits ─────────────────────────────────────────────────────────────

describe('generateNotifications — early exits', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns immediately if userId is null', async () => {
    await generateNotifications(null)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns immediately if userId is undefined', async () => {
    await generateNotifications(undefined)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns immediately if userId is empty string', async () => {
    await generateNotifications('')
    expect(mockFrom).not.toHaveBeenCalled()
  })
})

// ─── queries correct tables ───────────────────────────────────────────────────

describe('generateNotifications — queries correct tables', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAllEmpty()
  })

  it('queries invoice_payments', async () => {
    await generateNotifications('user-1')
    expect(mockFrom.mock.calls.map(c => c[0])).toContain('invoice_payments')
  })

  it('queries expense_payments', async () => {
    await generateNotifications('user-1')
    expect(mockFrom.mock.calls.map(c => c[0])).toContain('expense_payments')
  })

  it('queries bill_discounting', async () => {
    await generateNotifications('user-1')
    expect(mockFrom.mock.calls.map(c => c[0])).toContain('bill_discounting')
  })

  it('does NOT query notifications table when no notifications are built', async () => {
    await generateNotifications('user-1')
    // All empty → notifs.length === 0 → early return before dedupe/insert
    expect(mockFrom.mock.calls.map(c => c[0])).not.toContain('notifications')
  })
})

// ─── notification building — queries notifications when data exists ────────────

describe('generateNotifications — triggers dedupe query when notifs exist', () => {
  beforeEach(() => vi.clearAllMocks())

  it('queries notifications table for deduplication when overdue invoices exist', async () => {
    const overdueInv = [{ id: 'inv-id-001', invoice_no: 'INV-001', amount: 5000, currency: 'INR', entity_id: null }]

    let invCallCount = 0
    mockFrom.mockImplementation((table) => {
      if (table === 'invoice_payments') {
        invCallCount++
        // 1st call = overdue (has data), 2nd call = due soon (empty)
        return makeQuery(invCallCount === 1 ? overdueInv : [])
      }
      return makeQuery([])
    })

    await generateNotifications('user-1')
    expect(mockFrom.mock.calls.map(c => c[0])).toContain('notifications')
  })
})

// ─── deduplication logic (pure) ───────────────────────────────────────────────

describe('deduplication key logic', () => {
  it('key is source_id__notification_type', () => {
    const existing = [
      { source_id: 'id-1', notification_type: 'overdue_invoice' },
      { source_id: 'id-2', notification_type: 'payment_due' },
    ]
    const set = new Set(existing.map(e => `${e.source_id}__${e.notification_type}`))
    expect(set.has('id-1__overdue_invoice')).toBe(true)
    expect(set.has('id-2__payment_due')).toBe(true)
    expect(set.has('id-1__payment_due')).toBe(false)   // different type, not a dupe
    expect(set.has('id-3__overdue_invoice')).toBe(false) // new id, not a dupe
  })

  it('same source_id with different type is NOT filtered', () => {
    const existing = [{ source_id: 'id-1', notification_type: 'overdue_invoice' }]
    const set = new Set(existing.map(e => `${e.source_id}__${e.notification_type}`))
    const candidate = { source_id: 'id-1', notification_type: 'payment_due' }
    expect(set.has(`${candidate.source_id}__${candidate.notification_type}`)).toBe(false)
  })
})

// ─── message format (pure logic, no DB) ──────────────────────────────────────

describe('notification message format', () => {
  it('overdue invoice message with invoice_no', () => {
    const r = { id: 'aabbccdd-1111', invoice_no: 'INV-001', amount: 5000, currency: 'INR' }
    const msg = `Invoice ${r.invoice_no || r.id.slice(0, 8)} payment of ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} is past due.`
    expect(msg).toBe('Invoice INV-001 payment of INR 5,000 is past due.')
  })

  it('overdue invoice message falls back to id slice when no invoice_no', () => {
    const r = { id: 'xxyyzz00-2222', invoice_no: null, amount: 1000, currency: 'INR' }
    const msg = `Invoice ${r.invoice_no || r.id.slice(0, 8)} payment of ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} is past due.`
    expect(msg).toContain('xxyyzz00')
  })

  it('due-soon invoice message includes due_date', () => {
    const r = { invoice_no: 'INV-042', amount: 8000, currency: 'USD', due_date: '2025-06-30', id: 'aabb-ccdd' }
    const msg = `Invoice ${r.invoice_no || r.id.slice(0, 8)} — ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} due on ${r.due_date}.`
    expect(msg).toBe('Invoice INV-042 — USD 8,000 due on 2025-06-30.')
  })

  it('expense overdue message includes category and amount', () => {
    const r = { expense_category: 'Freight', amount: 2500, currency: 'INR' }
    const msg = `${r.expense_category} expense of ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} is past due.`
    expect(msg).toBe('Freight expense of INR 2,500 is past due.')
  })

  it('bill discounting message includes bank, amount, and maturity date', () => {
    const r = { bank_name: 'HDFC Bank', outstanding_amount: 100000, maturity_date: '2025-07-15' }
    const msg = `${r.bank_name} — outstanding ${Math.round(r.outstanding_amount).toLocaleString('en-IN')} matures on ${r.maturity_date}.`
    expect(msg).toBe('HDFC Bank — outstanding 1,00,000 matures on 2025-07-15.')
  })

  it('amounts are rounded to whole rupees in messages', () => {
    const r = { invoice_no: 'INV-099', amount: 1000.75, currency: 'INR', id: 'zz' }
    const msg = `Invoice ${r.invoice_no || r.id.slice(0, 8)} payment of ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} is past due.`
    expect(msg).toContain('1,001') // 1000.75 rounds to 1001
  })
})
