import { describe, it, expect, vi, beforeEach } from 'vitest'
import { downloadCSV, downloadTemplate, TEMPLATES } from '../csvTemplate.js'

// ─── Browser API mocks ────────────────────────────────────────────────────────
// Blob must be a real class (Vitest rejects arrow-function constructors).

function setupBrowserMocks() {
  const state = { content: '', link: null }

  class MockBlob {
    constructor(parts) {
      state.content = parts.join('')
    }
  }
  global.Blob = MockBlob

  global.URL = {
    createObjectURL: vi.fn(() => 'blob:mock-url'),
    revokeObjectURL: vi.fn(),
  }

  const mockLink = { href: '', download: '', click: vi.fn() }
  state.link = mockLink

  global.document = {
    createElement: vi.fn(() => mockLink),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  }

  return {
    getContent: () => state.content,
    getLink: () => state.link,
  }
}

// ─── downloadCSV ──────────────────────────────────────────────────────────────

describe('downloadCSV — CSV content generation', () => {
  let mocks

  beforeEach(() => { mocks = setupBrowserMocks() })

  it('produces a header row as first line', () => {
    downloadCSV('test.csv', ['name', 'qty'], [])
    expect(mocks.getContent()).toMatch(/^name,qty/)
  })

  it('produces one data row per object', () => {
    downloadCSV('test.csv', ['name', 'qty'], [
      { name: 'Widget', qty: 10 },
      { name: 'Gadget', qty: 20 },
    ])
    const lines = mocks.getContent().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('Widget,10')
    expect(lines[2]).toBe('Gadget,20')
  })

  it('outputs only columns listed in headers (ignores extra fields)', () => {
    downloadCSV('test.csv', ['name'], [{ name: 'Widget', qty: 10, extra: 'ignored' }])
    const lines = mocks.getContent().split('\n')
    expect(lines[1]).toBe('Widget')
  })

  it('outputs empty string for missing fields', () => {
    downloadCSV('test.csv', ['name', 'qty'], [{ name: 'Widget' }])
    const lines = mocks.getContent().split('\n')
    expect(lines[1]).toBe('Widget,')
  })

  it('wraps values containing commas in double quotes', () => {
    downloadCSV('test.csv', ['desc'], [{ desc: 'hello, world' }])
    const lines = mocks.getContent().split('\n')
    expect(lines[1]).toBe('"hello, world"')
  })

  it('escapes double quotes inside values', () => {
    downloadCSV('test.csv', ['desc'], [{ desc: 'say "hi"' }])
    const lines = mocks.getContent().split('\n')
    expect(lines[1]).toBe('"say ""hi"""')
  })

  it('wraps values containing newlines in double quotes', () => {
    downloadCSV('test.csv', ['desc'], [{ desc: 'line1\nline2' }])
    expect(mocks.getContent()).toContain('"line1\nline2"')
  })

  it('outputs empty string for null values', () => {
    downloadCSV('test.csv', ['name'], [{ name: null }])
    const lines = mocks.getContent().split('\n')
    expect(lines[1]).toBe('')
  })

  it('outputs empty string for undefined values', () => {
    downloadCSV('test.csv', ['name'], [{ name: undefined }])
    const lines = mocks.getContent().split('\n')
    expect(lines[1]).toBe('')
  })

  it('handles numeric values by converting to string', () => {
    downloadCSV('test.csv', ['rate'], [{ rate: 1250 }])
    const lines = mocks.getContent().split('\n')
    expect(lines[1]).toBe('1250')
  })

  it('produces only a header line when rows array is empty', () => {
    downloadCSV('test.csv', ['name', 'qty'], [])
    const lines = mocks.getContent().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('name,qty')
  })

  it('sets the correct filename on the download link', () => {
    downloadCSV('my_export.csv', ['name'], [])
    expect(mocks.getLink().download).toBe('my_export.csv')
  })

  it('calls link.click() to trigger download', () => {
    downloadCSV('test.csv', ['name'], [])
    expect(mocks.getLink().click).toHaveBeenCalledOnce()
  })

  it('calls URL.revokeObjectURL to clean up', () => {
    downloadCSV('test.csv', ['name'], [])
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })
})

// ─── TEMPLATES — shape & integrity ────────────────────────────────────────────

describe('TEMPLATES', () => {
  const expectedKeys = ['products', 'opening_stock', 'hsn_master', 'pi', 'po', 'invoices', 'entities']

  it('exports all expected template keys', () => {
    expectedKeys.forEach(key => expect(TEMPLATES).toHaveProperty(key))
  })

  it('every template has filename, headers, and rows', () => {
    Object.entries(TEMPLATES).forEach(([key, t]) => {
      expect(t, `${key} missing filename`).toHaveProperty('filename')
      expect(t, `${key} missing headers`).toHaveProperty('headers')
      expect(t, `${key} missing rows`).toHaveProperty('rows')
      expect(Array.isArray(t.headers), `${key} headers not array`).toBe(true)
      expect(Array.isArray(t.rows), `${key} rows not array`).toBe(true)
    })
  })

  it('every template filename ends in .csv', () => {
    Object.entries(TEMPLATES).forEach(([key, t]) => {
      expect(t.filename, `${key} filename`).toMatch(/\.csv$/)
    })
  })

  it('every template has at least one header', () => {
    Object.entries(TEMPLATES).forEach(([key, t]) => {
      expect(t.headers.length, `${key} has no headers`).toBeGreaterThan(0)
    })
  })

  it('every template has at least one sample row', () => {
    Object.entries(TEMPLATES).forEach(([key, t]) => {
      expect(t.rows.length, `${key} has no sample rows`).toBeGreaterThan(0)
    })
  })

  it('every sample row contains at least the first header key', () => {
    Object.entries(TEMPLATES).forEach(([key, t]) => {
      t.rows.forEach((row, i) => {
        expect(row, `${key} row ${i} missing first header key`).toHaveProperty(t.headers[0])
      })
    })
  })

  it('products template has correct headers', () => {
    expect(TEMPLATES.products.headers).toEqual(['name', 'hsn_code', 'gst_rate', 'unit', 'default_rate', 'description', 'category'])
  })

  it('entities template has gstin field', () => {
    expect(TEMPLATES.entities.headers).toContain('gstin')
  })

  it('pi template has is_interstate field', () => {
    expect(TEMPLATES.pi.headers).toContain('is_interstate')
  })

  it('invoices template has invoice_type field', () => {
    expect(TEMPLATES.invoices.headers).toContain('invoice_type')
  })
})

// ─── downloadTemplate ─────────────────────────────────────────────────────────

describe('downloadTemplate', () => {
  beforeEach(() => {
    setupBrowserMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
  })

  it('triggers download for a valid key', () => {
    downloadTemplate('products')
    expect(global.URL.createObjectURL).toHaveBeenCalled()
  })

  it('does nothing for an unknown key', () => {
    downloadTemplate('nonexistent_key')
    expect(global.URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('does nothing for null key', () => {
    downloadTemplate(null)
    expect(global.URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('logs notes to console for templates that have notes', () => {
    downloadTemplate('opening_stock') // has notes
    expect(console.log).toHaveBeenCalled()
  })

  it('does not log notes for templates without notes', () => {
    downloadTemplate('products') // no notes field
    expect(console.log).not.toHaveBeenCalled()
  })
})
