import { describe, it, expect } from 'vitest'
import { formatINR, toNum, roundRupees, round2 } from '../money.js'

// ─── formatINR ────────────────────────────────────────────────────────────────

describe('formatINR', () => {
  // Happy path
  it('formats a whole number with Indian comma style', () => {
    expect(formatINR(1250)).toBe('₹1,250')
  })

  it('formats a large number with crore-level commas', () => {
    expect(formatINR(10000000)).toBe('₹1,00,00,000')
  })

  it('formats zero as ₹0', () => {
    expect(formatINR(0)).toBe('₹0')
  })

  it('rounds a decimal to nearest whole rupee before display', () => {
    expect(formatINR(1250.60)).toBe('₹1,251')
  })

  it('rounds down when decimal < 0.5', () => {
    expect(formatINR(1250.40)).toBe('₹1,250')
  })

  it('formats a string number correctly', () => {
    expect(formatINR('5000')).toBe('₹5,000')
  })

  // NOTE: toLocaleString('en-IN') places ₹ before the minus sign → '₹-500'
  it('formats a negative amount (symbol before minus per en-IN locale)', () => {
    expect(formatINR(-500)).toBe('₹-500')
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
  // NOTE: IEEE 754 float: 1.005 * 100 = 100.4999... → Math.round → 100 → 1.00
  // round2 uses Math.round on floating-point intermediates; not banker's rounding.
  it('documents float precision: 1.005 rounds to 1.00 due to IEEE 754', () => {
    expect(round2(1.005)).toBe(1.00)
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

  // NOTE: -5.555 * 100 = -555.4999... → Math.round → -555 → -5.55 (float precision)
  it('documents float precision: -5.555 rounds to -5.55', () => {
    expect(round2(-5.555)).toBe(-5.55)
  })
})
