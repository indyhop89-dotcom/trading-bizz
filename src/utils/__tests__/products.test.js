import { describe, it, expect } from 'vitest'
import { cleanProductName, productKey, findProductByName } from '../products'

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

describe('findProductByName', () => {
  const products = [
    { id: '1', name: 'Polo T-Shirt' },
    { id: '2', name: 'T-Shirt Basic Round Neck' },
  ]
  it('matches an exact name', () => {
    expect(findProductByName(products, 'Polo T-Shirt')?.id).toBe('1')
  })
  it('matches case-insensitively and ignores trailing junk', () => {
    expect(findProductByName(products, 'polo t-shirt))')?.id).toBe('1')
  })
  it('returns null when nothing matches', () => {
    expect(findProductByName(products, 'Nonexistent Widget')).toBeNull()
  })
  it('returns null for a blank name', () => {
    expect(findProductByName(products, '')).toBeNull()
    expect(findProductByName(products, '   ')).toBeNull()
  })
})
