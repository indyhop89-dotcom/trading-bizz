import { describe, it, expect } from 'vitest'
import { cleanProductName, productKey, productMatchKey } from '../products'

describe('cleanProductName', () => {
  it('strips trailing ) and )) junk', () => {
    expect(cleanProductName('Braided Jute Spiral Sun Placemats Set of 4))')).toBe('Braided Jute Spiral Sun Placemats Set of 4')
    expect(cleanProductName('Lace Embellished Mauve Cushion Cover)')).toBe('Lace Embellished Mauve Cushion Cover')
  })
  it('trims and collapses internal whitespace', () => {
    expect(cleanProductName('  Foo   Bar  ')).toBe('Foo Bar')
  })
  it('leaves a clean name unchanged', () => {
    expect(cleanProductName('Polo T-Shirt')).toBe('Polo T-Shirt')
  })
  it('handles null/undefined safely', () => {
    expect(cleanProductName(null)).toBe('')
    expect(cleanProductName(undefined)).toBe('')
  })
})

describe('productKey', () => {
  it('makes clean and dirty variants of the same name match', () => {
    expect(productKey('Foo Set of 4')).toBe(productKey('Foo Set of 4))'))
    expect(productKey('foo set of 4')).toBe(productKey('Foo Set of 4'))
  })
  it('keeps genuinely different products distinct', () => {
    // an opening '(' is preserved, so (A) and (B) don't collapse together
    expect(productKey('Rug (A)')).not.toBe(productKey('Rug (B)'))
    expect(productKey('Polo T-Shirt')).not.toBe(productKey('Basic T-Shirt'))
  })
})

describe('productMatchKey', () => {
  it('matches when name (incl. junk variants), HSN, rate, and GST all agree', () => {
    const a = { name: 'Foo Set of 4', hsn_code: '6109', rate: '250', gst_rate: '18' }
    const b = { name: 'Foo Set of 4))', hsn_code: '6109', rate: 250, gst_rate: 18 }
    expect(productMatchKey(a)).toBe(productMatchKey(b))
  })
  it('treats two products with the SAME name but different rate as different products', () => {
    // real-world case: a source export labels many distinct designs with one
    // generic name ("Embroidered Cotton Cushion Cover") at different rates —
    // these must never be merged into one product.
    const a = { name: 'Embroidered Cotton Cushion Cover', hsn_code: '63049289', rate: 410.73, gst_rate: 5 }
    const b = { name: 'Embroidered Cotton Cushion Cover', hsn_code: '63049289', rate: 289.62, gst_rate: 5 }
    expect(productMatchKey(a)).not.toBe(productMatchKey(b))
  })
  it('treats same name + rate but different HSN as different products', () => {
    const a = { name: 'Widget', hsn_code: '1111', rate: 100, gst_rate: 18 }
    const b = { name: 'Widget', hsn_code: '2222', rate: 100, gst_rate: 18 }
    expect(productMatchKey(a)).not.toBe(productMatchKey(b))
  })
  it('treats same name + HSN + rate but different GST as different products', () => {
    const a = { name: 'Widget', hsn_code: '1111', rate: 100, gst_rate: 5 }
    const b = { name: 'Widget', hsn_code: '1111', rate: 100, gst_rate: 18 }
    expect(productMatchKey(a)).not.toBe(productMatchKey(b))
  })
  it('tolerates float/formatting noise in rate and gst_rate', () => {
    const a = { name: 'Widget', hsn_code: '1111', rate: '410.7', gst_rate: '18.00' }
    const b = { name: 'Widget', hsn_code: '1111', rate: 410.70, gst_rate: 18 }
    expect(productMatchKey(a)).toBe(productMatchKey(b))
  })
})
