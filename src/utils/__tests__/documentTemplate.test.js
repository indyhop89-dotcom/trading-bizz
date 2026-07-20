import { describe, it, expect } from 'vitest'
import { buildDocumentHTML, DOC_META } from '../documentTemplate.js'
import { buildDocumentExcelXML } from '../documentExcel.js'

const baseDoc = {
  docType: 'PI',
  docNo: 'PI/25-26/001',
  docDate: '2025-06-15',
  validOrDueDate: '2025-07-15',
  paymentTerms: 'Net 30 Days',
  sellerEntity: { name: 'Vananam Retail Ventures Pvt Ltd', address: 'Sector 4', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560102', gstin: '29AAJCV0573F1Z4' },
  buyerEntity: { name: 'Siddhi Trading Co', address: 'MG Road', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560001', gstin: '29AABCU9603R1ZM' },
  lines: [
    { description: 'T-Shirt Basic', hsn_code: '6109', qty: 10, unit: 'Nos', rate: 250, gst_rate: 12, taxable_amount: 2500, cgst_amount: 150, sgst_amount: 150, igst_amount: 0, total_amount: 2800 },
  ],
  totals: { taxable_amount: 2500, cgst_amount: 150, sgst_amount: 150, igst_amount: 0, round_off_amount: 0, total_amount: 2800 },
  interstate: false,
  bankDetails: { bank_name: 'IDFC First Bank', bank_account_no: '10181683960', bank_ifsc: 'IDFB0080185' },
}

describe('buildDocumentHTML', () => {
  it('renders seller/buyer names and doc number for a PI', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('Vananam Retail Ventures Pvt Ltd'.toUpperCase())
    expect(html).toContain('Siddhi Trading Co')
    expect(html).toContain('PI/25-26/001')
    expect(html).toContain(DOC_META.PI.title)
  })

  it('titles a PO the same layout as PI but with a different heading', () => {
    const poHtml = buildDocumentHTML({ ...baseDoc, docType: 'PO', docNo: 'PO/25-26/001' })
    expect(poHtml).toContain('Purchase Order')
    expect(poHtml).toContain('PO/25-26/001')
  })

  it('omits the logo <img> when sellerEntity has no logoSrc', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).not.toContain('<img')
  })

  it('includes the logo <img> when sellerEntity.logoSrc is set', () => {
    const html = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, logoSrc: 'blob:fake' } })
    expect(html).toContain('<img class="pi-logo" src="blob:fake"')
  })

  it('shows the GST computation table and e-way bill only for INVOICE, not PI/PO', () => {
    const piHtml = buildDocumentHTML(baseDoc)
    expect(piHtml).not.toContain('gst-comp-wrap')
    const invHtml = buildDocumentHTML({ ...baseDoc, docType: 'INVOICE', docNo: 'INV/25-26/001', ewayBill: { eway_bill_no: 'EWB123', vehicle_no: 'KA01AB1234' } })
    expect(invHtml).toContain('gst-comp-wrap')
    expect(invHtml).toContain('EWB123')
    expect(invHtml).toContain('KA01AB1234')
  })

  it('shows IGST instead of CGST/SGST when interstate', () => {
    const html = buildDocumentHTML({ ...baseDoc, interstate: true, lines: [{ ...baseDoc.lines[0], cgst_amount: 0, sgst_amount: 0, igst_amount: 300 }], totals: { ...baseDoc.totals, cgst_amount: 0, sgst_amount: 0, igst_amount: 300 } })
    expect(html).toContain('IGST:₹300.00')
    expect(html).not.toContain('CGST:₹')
  })

  it('paginates lines across multiple pages when there are many', () => {
    const manyLines = Array.from({ length: 40 }, (_, i) => ({ ...baseDoc.lines[0], description: `Item ${i + 1}` }))
    const html = buildDocumentHTML({ ...baseDoc, lines: manyLines })
    const pageCount = (html.match(/class="po-page"/g) || []).length
    expect(pageCount).toBeGreaterThan(1)
    expect(html).toContain('Item 40')
  })

  it('falls back to the buyer entity for Ship To when shipTo is not given', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('Siddhi Trading Co')
  })

  it('labels the counterparty "Vendor" (not "Bill To") for a PO, since PO\'s issuer is the buyer', () => {
    const poHtml = buildDocumentHTML({ ...baseDoc, docType: 'PO', docNo: 'PO/25-26/001' })
    expect(poHtml).toContain('>Vendor<')
    expect(poHtml).not.toContain('>Bill To<')
  })

  it('still labels the counterparty "Bill To" for PI/Invoice', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('>Bill To<')
  })

  it('ships a PO to the issuing buyer\'s own address by default, not the vendor\'s', () => {
    const poHtml = buildDocumentHTML({ ...baseDoc, docType: 'PO', docNo: 'PO/25-26/001' })
    // sellerEntity (the PO's issuer/buyer) address should appear in the Ship To block;
    // the vendor (buyerEntity) should only appear once, in the Vendor block, not twice.
    const shipToIdx = poHtml.indexOf('Ship To')
    expect(poHtml.slice(shipToIdx, shipToIdx + 300)).toContain('Vananam Retail Ventures Pvt Ltd')
  })

  it('still ships PI/Invoice to the buyer entity by default', () => {
    const html = buildDocumentHTML(baseDoc)
    const shipToIdx = html.indexOf('Ship To')
    expect(html.slice(shipToIdx, shipToIdx + 300)).toContain('Siddhi Trading Co')
  })

  it('refuses to generate for an entity with no registered document theme', () => {
    const unconfigured = { ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, name: 'Siddhi Trading Co', gstin: '29AABCU9603R1ZM' } }
    expect(() => buildDocumentHTML(unconfigured)).toThrow(/no document format has been configured for "siddhi trading co"/i)
  })

  it('refuses to generate when the seller entity has no gstin at all', () => {
    const noGstin = { ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, gstin: '' } }
    expect(() => buildDocumentHTML(noGstin)).toThrow(/no document format has been configured/i)
  })
})

describe('buildDocumentExcelXML', () => {
  it('produces a valid SpreadsheetML workbook containing the doc number and totals', () => {
    const xml = buildDocumentExcelXML(baseDoc)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('PI/25-26/001')
    expect(xml).toContain('Siddhi Trading Co')
    expect(xml).toContain('2800')
  })

  it('uses IGST column when interstate, CGST/SGST when not', () => {
    const local = buildDocumentExcelXML(baseDoc)
    expect(local).toContain('CGST')
    const inter = buildDocumentExcelXML({ ...baseDoc, interstate: true })
    expect(inter).toContain('IGST')
  })

  it('refuses to generate for an entity with no registered document theme', () => {
    const unconfigured = { ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, name: 'Siddhi Trading Co', gstin: '29AABCU9603R1ZM' } }
    expect(() => buildDocumentExcelXML(unconfigured)).toThrow(/no document format has been configured for "siddhi trading co"/i)
  })
})

describe('dispatchInfo (Bill From/To, Ship From/To)', () => {
  it('shows only the populated Bill/Ship From/To rows, omitting blank ones', () => {
    const html = buildDocumentHTML({ ...baseDoc, dispatchInfo: { billFrom: 'VVGTL, Panvel', billTo: '', shipFrom: 'DHL Warehouse, Panvel', shipTo: '' } })
    expect(html).toContain('Bill From')
    expect(html).toContain('VVGTL, Panvel')
    expect(html).toContain('Ship From')
    expect(html).toContain('DHL Warehouse, Panvel')
    // The dispatch-info block itself only renders the populated rows — the
    // pre-existing addr-grid "Bill To" label (a different feature) is
    // expected to still be present, so check specifically for the absence
    // of a dispatch-row for the blank fields, not "Bill To" anywhere at all.
    expect(html).not.toContain('dispatch-lbl">Bill To<')
    expect(html).not.toContain('dispatch-lbl">Ship To<')
  })

  it('omits the whole block when dispatchInfo is absent or all fields are blank', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).not.toContain('dispatch-info')
    const blank = buildDocumentHTML({ ...baseDoc, dispatchInfo: { billFrom: '', billTo: '', shipFrom: '', shipTo: '' } })
    expect(blank).not.toContain('dispatch-info')
  })
})

describe('entity-level Terms & Conditions', () => {
  it('renders the seller entity\'s configured terms, only when set', () => {
    const withTerms = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, terms_and_conditions: 'Goods once sold will not be taken back.' } })
    expect(withTerms).toContain('Goods once sold will not be taken back.')
    const without = buildDocumentHTML(baseDoc)
    expect(without).not.toContain('tv-extra')
  })

  it('preserves line breaks in the terms text', () => {
    const html = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, terms_and_conditions: 'Line one.\nLine two.' } })
    expect(html).toContain('Line one.<br>Line two.')
  })
})
