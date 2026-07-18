import { describe, it, expect } from 'vitest'
import { resolveEntityTheme } from '../entityDocumentThemes.js'

describe('resolveEntityTheme', () => {
  it('resolves the registered VRVPL theme by GSTIN', () => {
    const theme = resolveEntityTheme('29AAJCV0573F1Z4')
    expect(theme).toBeTruthy()
    expect(theme.label).toBe('VRVPL')
    expect(theme.navy).toBe('#2D3272')
    expect(theme.orange).toBe('#E8843A')
  })

  it('is case- and whitespace-insensitive on the GSTIN', () => {
    expect(resolveEntityTheme('  29aajcv0573f1z4  ')).toBeTruthy()
  })

  it('returns null for an entity with no registered theme', () => {
    expect(resolveEntityTheme('29AABCU9603R1ZM')).toBeNull()
  })

  it('returns null for a missing/blank GSTIN', () => {
    expect(resolveEntityTheme('')).toBeNull()
    expect(resolveEntityTheme(null)).toBeNull()
    expect(resolveEntityTheme(undefined)).toBeNull()
  })
})
