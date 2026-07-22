import { describe, it, expect, vi, afterEach } from 'vitest'
import { fmtDate, toInputDate, today, currentFYLabel, currentFYCode, fyOptions } from '../dates.js'

// ─── fmtDate ──────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('formats an ISO date string to "DD Mon YYYY"', () => {
    const result = fmtDate('2025-06-15')
    expect(result).toMatch(/15/)
    expect(result).toMatch(/Jun/)
    expect(result).toMatch(/2025/)
  })

  it('formats a Date object', () => {
    const result = fmtDate(new Date('2024-04-01'))
    expect(result).toMatch(/Apr/)
    expect(result).toMatch(/2024/)
  })

  it('returns — for null', () => {
    expect(fmtDate(null)).toBe('—')
  })

  it('returns — for undefined', () => {
    expect(fmtDate(undefined)).toBe('—')
  })

  it('returns — for empty string', () => {
    expect(fmtDate('')).toBe('—')
  })

  it('formats March (FY end month)', () => {
    const result = fmtDate('2025-03-31')
    expect(result).toMatch(/Mar/)
    expect(result).toMatch(/2025/)
  })
})

// ─── toInputDate ──────────────────────────────────────────────────────────────

describe('toInputDate', () => {
  it('converts an ISO date string to YYYY-MM-DD', () => {
    expect(toInputDate('2025-06-15T10:30:00Z')).toBe('2025-06-15')
  })

  it('passes through a plain YYYY-MM-DD string', () => {
    expect(toInputDate('2024-04-01')).toBe('2024-04-01')
  })

  it('returns empty string for null', () => {
    expect(toInputDate(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(toInputDate(undefined)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(toInputDate('')).toBe('')
  })
})

// ─── today ────────────────────────────────────────────────────────────────────

describe('today', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    const result = today()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('matches the current date', () => {
    const expected = new Date().toISOString().split('T')[0]
    expect(today()).toBe(expected)
  })
})

// ─── currentFYLabel ───────────────────────────────────────────────────────────

describe('currentFYLabel', () => {
  afterEach(() => vi.useRealTimers())

  it('returns "FY 2025-26" when date is in April 2025 (FY start)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-04-01'))
    expect(currentFYLabel()).toBe('FY 2025-26')
  })

  it('returns "FY 2025-26" when date is in March 2026 (FY end)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-31'))
    expect(currentFYLabel()).toBe('FY 2025-26')
  })

  it('returns "FY 2024-25" when date is in January 2025 (still previous FY)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-15'))
    expect(currentFYLabel()).toBe('FY 2024-25')
  })

  it('returns label matching "FY YYYY-YY" pattern', () => {
    expect(currentFYLabel()).toMatch(/^FY \d{4}-\d{2}$/)
  })
})

// ─── currentFYCode ────────────────────────────────────────────────────────────

describe('currentFYCode', () => {
  afterEach(() => vi.useRealTimers())

  it('returns "2526" for FY 2025-26', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-07-01'))
    expect(currentFYCode()).toBe('2526')
  })

  it('returns "2425" for FY 2024-25 (January 2025)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01'))
    expect(currentFYCode()).toBe('2425')
  })

  it('returns a 4-character string', () => {
    expect(currentFYCode()).toHaveLength(4)
  })
})

// ─── fyOptions ────────────────────────────────────────────────────────────────

describe('fyOptions', () => {
  afterEach(() => vi.useRealTimers())

  it('returns 3 items by default', () => {
    expect(fyOptions()).toHaveLength(3)
  })

  it('returns requested count', () => {
    expect(fyOptions(5)).toHaveLength(5)
  })

  it('first item is the current FY', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-07-01'))
    const opts = fyOptions()
    expect(opts[0].label).toBe('FY 2025-26')
  })

  it('each item has the expected shape', () => {
    const opts = fyOptions(1)
    const item = opts[0]
    expect(item).toHaveProperty('label')
    expect(item).toHaveProperty('start')
    expect(item).toHaveProperty('end')
    expect(item).toHaveProperty('code')
  })

  it('start date is April 1 of the FY start year', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-07-01'))
    const opts = fyOptions(1)
    expect(opts[0].start).toBe('2025-04-01')
  })

  it('end date is March 31 of the FY end year', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-07-01'))
    const opts = fyOptions(1)
    expect(opts[0].end).toBe('2026-03-31')
  })

  it('items are in descending FY order (most recent first)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-07-01'))
    const opts = fyOptions(3)
    expect(opts[0].label).toBe('FY 2025-26')
    expect(opts[1].label).toBe('FY 2024-25')
    expect(opts[2].label).toBe('FY 2023-24')
  })

  it('code is 4 chars for each item', () => {
    fyOptions(3).forEach(o => expect(o.code).toHaveLength(4))
  })
})
