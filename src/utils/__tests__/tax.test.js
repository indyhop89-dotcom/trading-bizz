import { describe, it, expect } from 'vitest'
import { isInterstate, calcLineTax, calcInvoiceTotals } from '../tax.js'
import { round2 } from '../money.js'

// ─── isInterstate ─────────────────────────────────────────────────────────────

describe('isInterstate', () => {
  // Happy path
  it('returns true when seller and buyer state codes differ', () => {
    expect(isInterstate('29ABCDE1234F1Z5', '27XYZAB5678G2H6')).toBe(true)
  })

  it('returns false when seller and buyer state codes are the same', () => {
    expect(isInterstate('29ABCDE1234F1Z5', '29XYZAB5678G2H6')).toBe(false)
  })

  it('detects same state correctly regardless of rest of GSTIN', () => {
    expect(isInterstate('07AAAAA0000A1Z5', '07ZZZZZ9999Z9Z9')).toBe(false)
  })

  it('detects different state with numeric codes', () => {
    expect(isInterstate('01AAAAA0000A1Z5', '02AAAAA0000A1Z5')).toBe(true)
  })

  // Edge cases
  it('returns false when seller GSTIN is null', () => {
    expect(isInterstate(null, '29XYZAB5678G2H6')).toBe(false)
  })

  it('returns false when buyer GSTIN is null', () => {
    expect(isInterstate('29ABCDE1234F1Z5', null)).toBe(false)
  })

  it('returns false when both GSTINs are null', () => {
    expect(isInterstate(null, null)).toBe(false)
  })

  it('returns false when seller GSTIN is empty string', () => {
    expect(isInterstate('', '29XYZAB5678G2H6')).toBe(false)
  })

  it('returns false when buyer GSTIN is empty string', () => {
    expect(isInterstate('29ABCDE1234F1Z5', '')).toBe(false)
  })
})

// ─── calcLineTax ──────────────────────────────────────────────────────────────

describe('calcLineTax — interstate (IGST)', () => {
  it('calculates IGST at 18% on ₹1000', () => {
    const result = calcLineTax(1000, 18, true)
    expect(result.igst_rate).toBe(18)
    expect(result.igst_amount).toBe(180)
    expect(result.total_tax).toBe(180)
    expect(result.cgst_rate).toBe(0)
    expect(result.cgst_amount).toBe(0)
    expect(result.sgst_rate).toBe(0)
    expect(result.sgst_amount).toBe(0)
  })

  it('calculates IGST at 5% on ₹10000', () => {
    const result = calcLineTax(10000, 5, true)
    expect(result.igst_amount).toBe(500)
    expect(result.total_tax).toBe(500)
  })

  it('calculates IGST at 12% on ₹1500', () => {
    const result = calcLineTax(1500, 12, true)
    expect(result.igst_amount).toBe(180)
    expect(result.total_tax).toBe(180)
  })

  it('calculates IGST on a round taxable amount (₹100 at 18% = ₹18)', () => {
    const result = calcLineTax(100, 18, true)
    expect(result.igst_amount).toBe(18)
  })

  it('keeps 2dp precision on a fractional taxable amount (no whole-rupee rounding)', () => {
    // 1001 * 18% = 180.18 — kept at 2dp, not rounded to 180
    const result = calcLineTax(1001, 18, true)
    expect(result.igst_amount).toBe(180.18)
  })

  it('returns zero tax on zero taxable amount', () => {
    const result = calcLineTax(0, 18, true)
    expect(result.igst_amount).toBe(0)
    expect(result.total_tax).toBe(0)
  })

  it('returns zero tax on zero rate', () => {
    const result = calcLineTax(1000, 0, true)
    expect(result.igst_amount).toBe(0)
    expect(result.total_tax).toBe(0)
  })
})

describe('calcLineTax — local / intrastate (CGST + SGST)', () => {
  it('splits 18% GST equally into 9% CGST and 9% SGST on ₹1000', () => {
    const result = calcLineTax(1000, 18, false)
    expect(result.cgst_rate).toBe(9)
    expect(result.sgst_rate).toBe(9)
    expect(result.cgst_amount).toBe(90)
    expect(result.sgst_amount).toBe(90)
    expect(result.total_tax).toBe(180)
    expect(result.igst_rate).toBe(0)
    expect(result.igst_amount).toBe(0)
  })

  it('splits 5% GST into 2.5% each on ₹10000', () => {
    const result = calcLineTax(10000, 5, false)
    expect(result.cgst_rate).toBe(2.5)
    expect(result.sgst_rate).toBe(2.5)
    expect(result.cgst_amount).toBe(250)
    expect(result.sgst_amount).toBe(250)
    expect(result.total_tax).toBe(500)
  })

  it('keeps 2dp precision on each component independently (no whole-rupee rounding)', () => {
    // 1001 * 9% = 90.09 — kept at 2dp, not rounded to 90
    const result = calcLineTax(1001, 18, false)
    expect(result.cgst_amount).toBe(90.09)
    expect(result.sgst_amount).toBe(90.09)
    expect(result.total_tax).toBe(180.18)
  })

  it('returns zero tax on zero taxable amount', () => {
    const result = calcLineTax(0, 18, false)
    expect(result.cgst_amount).toBe(0)
    expect(result.sgst_amount).toBe(0)
    expect(result.total_tax).toBe(0)
  })

  it('returns zero tax on zero rate', () => {
    const result = calcLineTax(5000, 0, false)
    expect(result.cgst_amount).toBe(0)
    expect(result.sgst_amount).toBe(0)
    expect(result.total_tax).toBe(0)
  })

  it('handles 28% GST (luxury rate) split on ₹2000', () => {
    const result = calcLineTax(2000, 28, false)
    expect(result.cgst_rate).toBe(14)
    expect(result.cgst_amount).toBe(280)
    expect(result.sgst_amount).toBe(280)
    expect(result.total_tax).toBe(560)
  })
})

// ─── calcLineTax — rounding convention (round total first, then split) ────────
//
// These lock in the "match Excel calculations" fix: the line's total is
// rounded once from the precise value, then CGST/SGST are each derived from
// that already-rounded total — instead of rounding taxable*rate/200
// independently per component. Verified against real rows pulled from a
// user-supplied bulk-upload CSV whose own cgst/sgst/total_amount columns
// were computed this same way.

describe('calcLineTax — rounds the total first, then derives CGST/SGST from it', () => {
  it('matches a verified real-data row where independent-component rounding would differ (taxable=11173.6, 18%)', () => {
    // taxable*1.18 = 13184.848 → total rounds to 13184.85; half of the
    // resulting 2011.25 tax is 1005.625, which rounds up to 1005.63 — the
    // old convention (round2(11173.6 * 9/100) = round2(1005.624)) also gives
    // 1005.62, one paisa short of the source data's stated 1005.63.
    const result = calcLineTax(11173.6, 18, false)
    expect(result.cgst_amount).toBe(1005.63)
    expect(result.sgst_amount).toBe(1005.63)
    expect(result.total_tax).toBe(2011.25)
  })

  it('matches a verified real-data row (taxable=9014.04, 18%)', () => {
    const result = calcLineTax(9014.04, 18, false)
    expect(result.cgst_amount).toBe(811.27)
    expect(result.sgst_amount).toBe(811.27)
    expect(result.total_tax).toBe(1622.53)
  })

  it('matches a verified real-data row at 5% GST (taxable=10443.4)', () => {
    const result = calcLineTax(10443.4, 5, false)
    expect(result.cgst_amount).toBe(261.09)
    expect(result.sgst_amount).toBe(261.09)
  })

  it('derives total_amount (taxable + total_tax) exactly, even when cgst+sgst lands a paisa off total_tax', () => {
    // 11173.6 + 2011.25 = 13184.85 — matches the source row's total_amount
    // even though cgst_amount + sgst_amount (1005.63*2 = 2011.26) is one
    // paisa more than total_tax (2011.25). total_amount is always derived
    // from total_tax directly (see computeLine in LineItemsEditor.jsx), so
    // it stays exact regardless of that split-level rounding artifact.
    const result = calcLineTax(11173.6, 18, false)
    expect(round2(11173.6 + result.total_tax)).toBe(13184.85)
  })
})

// ─── calcInvoiceTotals ────────────────────────────────────────────────────────

describe('calcInvoiceTotals', () => {
  it('sums a single line correctly', () => {
    const lines = [{
      taxable_amount: 1000,
      cgst_amount: 90,
      sgst_amount: 90,
      igst_amount: 0,
      total_amount: 1180,
    }]
    const result = calcInvoiceTotals(lines)
    expect(result.taxable_amount).toBe(1000)
    expect(result.cgst_amount).toBe(90)
    expect(result.sgst_amount).toBe(90)
    expect(result.igst_amount).toBe(0)
    expect(result.total_amount).toBe(1180)
  })

  it('sums multiple lines correctly', () => {
    const lines = [
      { taxable_amount: 1000, cgst_amount: 90,  sgst_amount: 90,  igst_amount: 0,   total_amount: 1180 },
      { taxable_amount: 2000, cgst_amount: 0,   sgst_amount: 0,   igst_amount: 360, total_amount: 2360 },
      { taxable_amount: 500,  cgst_amount: 12,  sgst_amount: 12,  igst_amount: 0,   total_amount: 524  },
    ]
    const result = calcInvoiceTotals(lines)
    expect(result.taxable_amount).toBe(3500)
    expect(result.cgst_amount).toBe(102)
    expect(result.sgst_amount).toBe(102)
    expect(result.igst_amount).toBe(360)
    expect(result.total_amount).toBe(4064)
  })

  it('returns all zeros for an empty array', () => {
    const result = calcInvoiceTotals([])
    expect(result.taxable_amount).toBe(0)
    expect(result.cgst_amount).toBe(0)
    expect(result.sgst_amount).toBe(0)
    expect(result.igst_amount).toBe(0)
    expect(result.total_amount).toBe(0)
  })

  it('handles null/undefined field values gracefully (treats as 0)', () => {
    const lines = [{ taxable_amount: null, cgst_amount: undefined, sgst_amount: null, igst_amount: undefined, total_amount: null }]
    const result = calcInvoiceTotals(lines)
    expect(result.taxable_amount).toBe(0)
    expect(result.total_amount).toBe(0)
  })

  it('handles string amounts that coerce to numbers', () => {
    const lines = [{ taxable_amount: '1000', cgst_amount: '90', sgst_amount: '90', igst_amount: '0', total_amount: '1180' }]
    const result = calcInvoiceTotals(lines)
    expect(result.taxable_amount).toBe(1000)
    expect(result.total_amount).toBe(1180)
  })
})
