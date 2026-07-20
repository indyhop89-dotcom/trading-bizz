import { describe, it, expect } from 'vitest'
import { buildDocumentHTML } from '../documentTemplate.js'
import { buildDocumentExcelXML } from '../documentExcel.js'

// Kamakhya Loyalties — bordered Zoho-style layout transcribed from a
// standalone PI generator HTML tool shared for this entity. See
// kamakhyaDocumentTemplate.js for the structural differences from
// vananam/srpl/tally.
//
// NOTE: 'PLACEHOLDER-KAMAKHYA-GSTIN' is a placeholder registry key in
// entityDocumentThemes.js pending the entity's real GSTIN — update both
// once it's provided.
const baseDoc = {
  docType: 'PI',
  docNo: 'KL/PI/26-27/001',
  docDate: '2026-07-20',
  validOrDueDate: '2026-08-19',
  paymentTerms: '90 Days from Date of Invoice',
  placeOfSupply: 'Karnataka',
  sellerEntity: { name: 'Kamakhya Loyalties', address: '1st Floor, MG Road', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560001', gstin: 'PLACEHOLDER-KAMAKHYA-GSTIN', pan: 'ABCDE1234F' },
  buyerEntity: { name: 'Vananam Retail Ventures Private Limited', address: 'No 90, 3rd Floor, 17th Cross Road', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560102', gstin: '29AAJCV0573F1Z4' },
  lines: [
    { description: 'Loyalty Cards', hsn_code: '491199', qty: 5000, unit: 'Nos', rate: 12.5, gst_rate: 18, taxable_amount: 62500, cgst_amount: 5625, sgst_amount: 5625, igst_amount: 0, total_amount: 73750 },
  ],
  totals: { taxable_amount: 62500, cgst_amount: 5625, sgst_amount: 5625, igst_amount: 0, round_off_amount: 0, total_amount: 73750 },
  interstate: false,
  bankDetails: { bank_name: 'HDFC Bank', bank_account_no: '50200012345678', bank_ifsc: 'HDFC0000123', bank_branch: 'MG Road' },
}

describe('Kamakhya template dispatch', () => {
  it('routes to the Kamakhya layout (not vananam/srpl/tally) based on the registered theme family', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('kam-doc-page')
    expect(html).not.toContain('class="po-page"')
    expect(html).not.toContain('srpl-doc-page')
  })

  it('renders the header, meta, and party blocks with the right fields', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('KAMAKHYA LOYALTIES')
    expect(html).toContain('PROFORMA INVOICE')
    expect(html).toContain('KL/PI/26-27/001')
    expect(html).toContain('Valid Until')
    expect(html).toContain('Karnataka')
    expect(html).toContain('90 Days from Date of Invoice')
    expect(html).toContain('Vananam Retail Ventures Private Limited')
    expect(html).toContain('Bill To')
  })

  it('shows a single combined GST Amt column per line, not per-line CGST/SGST split', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('GST Amt')
    expect(html).toContain('11,250.00') // combined 5625 + 5625
  })

  it('shows bank details and terms & conditions in the after-total strip', () => {
    const withTerms = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, terms_and_conditions: 'Goods once sold will not be taken back.' } })
    expect(withTerms).toContain('HDFC Bank')
    expect(withTerms).toContain('Goods once sold will not be taken back.')
    expect(withTerms).toContain('Terms &amp; Conditions')
  })

  it('renders notes and the amount in words', () => {
    const html = buildDocumentHTML({ ...baseDoc, notes: 'Looking forward for your business.' })
    expect(html).toContain('Looking forward for your business.')
    expect(html).toContain('Total In Words')
    expect(html).toContain('Rupees')
  })

  it('renders the seller\'s uploaded logo when logoSrc is set, and omits it otherwise', () => {
    const withLogo = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, logoSrc: 'blob:fake-logo' } })
    expect(withLogo).toContain('<img src="blob:fake-logo"')
    const withoutLogo = buildDocumentHTML(baseDoc)
    expect(withoutLogo).not.toContain('<img')
  })

  it('produces a valid SpreadsheetML workbook for Kamakhya too', () => {
    const xml = buildDocumentExcelXML(baseDoc)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('Kamakhya Loyalties')
    expect(xml).toContain('KL/PI/26-27/001')
  })
})

describe('Kamakhya Purchase Order layout', () => {
  const poDoc = {
    ...baseDoc,
    docType: 'PO',
    docNo: 'KL/PO/26-27/002',
    buyerEntity: { name: 'Some Supplier Pvt Ltd', address: 'Industrial Area', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560058', gstin: '29AAAAA0000A1Z5' },
  }

  it('labels the counterparty "Vendor" and omits bank details', () => {
    const html = buildDocumentHTML(poDoc)
    expect(html).toContain('Vendor')
    expect(html).toContain('Some Supplier Pvt Ltd')
    expect(html).not.toContain('HDFC Bank')
  })

  it('ships to the issuer\'s own address by default', () => {
    const html = buildDocumentHTML(poDoc)
    const shipIdx = html.indexOf('Ship To')
    expect(html.slice(shipIdx, shipIdx + 200)).toContain('Kamakhya Loyalties')
  })
})

describe('Kamakhya Tax Invoice layout', () => {
  it('shows Eway Bill No / Vehicle No in the meta grid when provided', () => {
    const invDoc = { ...baseDoc, docType: 'INVOICE', docNo: 'KL/INV/26-27/003', ewayBill: { eway_bill_no: '1424 6986 7647', vehicle_no: 'KA 01 AA 7060' } }
    const html = buildDocumentHTML(invDoc)
    expect(html).toContain('TAX INVOICE')
    expect(html).toContain('E-way Bill No.')
    expect(html).toContain('1424 6986 7647')
    expect(html).toContain('Vehicle No.')
    expect(html).toContain('KA 01 AA 7060')
  })

  it('shows IGST instead of CGST/SGST when interstate', () => {
    const html = buildDocumentHTML({ ...baseDoc, docType: 'INVOICE', interstate: true, totals: { ...baseDoc.totals, cgst_amount: 0, sgst_amount: 0, igst_amount: 11250 } })
    expect(html).toContain('>IGST<')
    expect(html).not.toContain('>CGST<')
  })
})

describe('Kamakhya pagination', () => {
  it('paginates many-line documents and only shows the final totals block on the last page', () => {
    const manyLines = Array.from({ length: 60 }, (_, i) => ({ ...baseDoc.lines[0], description: `Loyalty Card Batch ${i + 1} — premium finish, embossed number, magnetic stripe`, hsn_code: '491199' }))
    const html = buildDocumentHTML({ ...baseDoc, lines: manyLines })
    const pageCount = (html.match(/class="kam-doc-page"/g) || []).length
    expect(pageCount).toBeGreaterThan(1)
    expect(html).toContain('Continued on next page')
    expect((html.match(/Total In Words/g) || []).length).toBe(1)
  })
})

describe('dispatchInfo (Bill From/To, Ship From/To)', () => {
  it('shows only the populated rows and omits the block entirely when absent', () => {
    const html = buildDocumentHTML({ ...baseDoc, dispatchInfo: { billFrom: 'Warehouse A, Bengaluru', billTo: '', shipFrom: 'Warehouse B, Bengaluru', shipTo: '' } })
    expect(html).toContain('Bill From')
    expect(html).toContain('Warehouse A, Bengaluru')
    expect(html).toContain('Ship From')
    expect(html).toContain('Warehouse B, Bengaluru')
    expect(html).not.toContain('kam-doc-dispatch-row"><b>Bill To<')
    const noInfo = buildDocumentHTML(baseDoc)
    expect(noInfo).not.toContain('kam-doc-dispatch"')
  })
})
