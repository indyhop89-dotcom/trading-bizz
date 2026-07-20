import { describe, it, expect } from 'vitest'
import { formatINR, toNum, roundRupees, round2 } from '../money.js'

// ─── formatINR ────────────────────────────────────────────────────────────────

describe('formatINR', () => {
  // Happy path
  it('formats a whole number with Indian comma style and 2dp', () => {
    expect(formatINR(1250)).toBe('₹1,250.00')
  })

  it('formats a large number with crore-level commas', () => {
    expect(formatINR(10000000)).toBe('₹1,00,00,000.00')
  })

  it('formats zero as ₹0.00', () => {
    expect(formatINR(0)).toBe('₹0.00')
  })

  it('displays the exact 2dp value rather than rounding to a whole rupee', () => {
    expect(formatINR(1250.60)).toBe('₹1,250.60')
  })

  it('preserves 2dp values under 0.5 as well', () => {
    expect(formatINR(1250.40)).toBe('₹1,250.40')
  })

  it('formats a string number correctly', () => {
    expect(formatINR('5000')).toBe('₹5,000.00')
  })

  // NOTE: toLocaleString('en-IN') places ₹ before the minus sign → '₹-500.00'
  it('formats a negative amount (symbol before minus per en-IN locale)', () => {
    expect(formatINR(-500)).toBe('₹-500.00')
  })

  // Edge / null cases → em-dash
  it('returns — for null', () => {
    expect(formatINR(null)).toBe('—')
  })

  it('returns — for undefined', () => {
    expect(formatINR(undefined)).toBe('—')
  })

  it('returns — for empty string', () => {
    expect(formatINR('')).toBe('—')
  })

  it('returns — for a non-numeric string', () => {
    expect(formatINR('abc')).toBe('—')
  })
})

// ─── toNum ────────────────────────────────────────────────────────────────────

describe('toNum', () => {
  // Happy path
  it('parses a plain number string', () => {
    expect(toNum('1250')).toBe(1250)
  })

  it('strips commas from Indian-formatted string', () => {
    expect(toNum('1,250.50')).toBe(1250.50)
  })

  it('handles a number input directly', () => {
    expect(toNum(5000)).toBe(5000)
  })

  it('handles a decimal string', () => {
    expect(toNum('99.99')).toBe(99.99)
  })

  // Edge / null cases → 0
  it('returns 0 for null', () => {
    expect(toNum(null)).toBe(0)
  })

  it('returns 0 for undefined', () => {
    expect(toNum(undefined)).toBe(0)
  })

  it('returns 0 for empty string', () => {
    expect(toNum('')).toBe(0)
  })

  it('returns 0 for a non-numeric string', () => {
    expect(toNum('abc')).toBe(0)
  })

  it('returns 0 for zero', () => {
    expect(toNum(0)).toBe(0)
  })
})

// ─── roundRupees ──────────────────────────────────────────────────────────────

describe('roundRupees', () => {
  it('rounds 0.5 up', () => {
    expect(roundRupees(1250.5)).toBe(1251)
  })

  it('rounds 0.4 down', () => {
    expect(roundRupees(1250.4)).toBe(1250)
  })

  it('leaves a whole number unchanged', () => {
    expect(roundRupees(1000)).toBe(1000)
  })

  it('returns 0 for null', () => {
    expect(roundRupees(null)).toBe(0)
  })

  it('returns 0 for undefined', () => {
    expect(roundRupees(undefined)).toBe(0)
  })

  it('handles a string number', () => {
    expect(roundRupees('250.6')).toBe(251)
  })

  it('handles negative values', () => {
    expect(roundRupees(-100.7)).toBe(-101)
  })
})

// ─── round2 ───────────────────────────────────────────────────────────────────

describe('round2', () => {
  // round2 goes through toFixed(4) before Math.round specifically to avoid the
  // classic IEEE 754 trap (1.005*100 === 100.4999...999 in raw float math) —
  // this keeps half-up rounding consistent, matching Excel/Tally convention.
  it('rounds a value exactly on a 2dp boundary up, despite float representation noise', () => {
    expect(round2(1.005)).toBe(1.01)
  })

  it('leaves 2dp values unchanged', () => {
    expect(round2(9.99)).toBe(9.99)
  })

  it('handles whole numbers', () => {
    expect(round2(100)).toBe(100)
  })

  it('returns 0 for null', () => {
    expect(round2(null)).toBe(0)
  })

  it('returns 0 for undefined', () => {
    expect(round2(undefined)).toBe(0)
  })

  it('handles a string number', () => {
    expect(round2('3.14159')).toBe(3.14)
  })

  it('rounds a negative value toward zero at the 2dp boundary consistently', () => {
    expect(round2(-5.555)).toBe(-5.55)
  })
})
