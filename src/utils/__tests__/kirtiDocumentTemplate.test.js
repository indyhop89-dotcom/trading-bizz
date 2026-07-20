import { describe, it, expect } from 'vitest'
import { buildDocumentHTML } from '../documentTemplate.js'
import { buildDocumentExcelXML } from '../documentExcel.js'

// Kirti Sales and Services — ported from a standalone Tally-style HTML
// generator tool (see kirtiDocumentTemplate.js for the source).
const baseDoc = {
  docType: 'PI',
  docNo: '65-PI-2026-27',
  docDate: '2026-07-19',
  validOrDueDate: '2026-08-18',
  paymentTerms: '100% Advance',
  deliveryTimeline: '7-10 working days from confirmation',
  modeOfTransport: 'Road',
  sellerEntity: { name: 'Kirti Sales and Services', address: 'Old No. 38, New No. 30, 1st A Cross, Subramanyapura Main Road, Gowdanapalya', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560061', gstin: '29AKNPK1819J1ZR', pan: 'AKNPK1819J' },
  buyerEntity: { name: 'Vananam Retail Ventures Private Limited', address: 'No 90, 3rd Floor, 17th Cross Road', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560102', gstin: '29AAJCV0573F1Z4' },
  lines: [
    { description: 'Office Chair - High Back Mesh', hsn_code: '9401', qty: 10, unit: 'Nos', rate: 4500, gst_rate: 18, taxable_amount: 45000, cgst_amount: 4050, sgst_amount: 4050, igst_amount: 0, total_amount: 53100 },
  ],
  totals: { taxable_amount: 45000, cgst_amount: 4050, sgst_amount: 4050, igst_amount: 0, round_off_amount: 0, total_amount: 53100 },
  interstate: false,
  bankDetails: { bank_name: 'ICICI Bank Ltd', bank_account_no: '193751000023', bank_ifsc: 'ICIC0001937', bank_branch: 'K H Road, Bangalore' },
}

describe('Kirti template dispatch', () => {
  it('routes to the tally layout (not vananam/srpl) based on the registered theme family', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('tally-page')
    expect(html).not.toContain('srpl-page')
  })

  it('renders seller/buyer names, doc number and the Tally-standard field labels', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('Kirti Sales and Services')
    expect(html).toContain('Vananam Retail Ventures Private Limited')
    expect(html).toContain('65-PI-2026-27')
    expect(html).toContain('PROFORMA INVOICE')
    expect(html).toContain('Buyer (Bill to)')
    expect(html).toContain('Consignee (Ship to)')
    expect(html).toContain('Terms of Delivery')
  })

  it('splits the item description into a bold main line and italic sub line on " - "', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('tally-desc-main">Office Chair')
    expect(html).toContain('tally-desc-sub">High Back Mesh')
  })

  it('shows bank details and PAN for PI (not for PO)', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('ICICI Bank Ltd')
    expect(html).toContain('AKNPK1819J')
    const poHtml = buildDocumentHTML({ ...baseDoc, docType: 'PO', docNo: 'KSS/PO/26-27/001' })
    expect(poHtml).not.toContain('ICICI Bank Ltd')
  })

  it('labels the counterparty "Supplier (Bill From)" for a PO and ships to the issuer\'s own address', () => {
    const poHtml = buildDocumentHTML({ ...baseDoc, docType: 'PO', docNo: 'KSS/PO/26-27/001' })
    expect(poHtml).toContain('Supplier (Bill From)')
    expect(poHtml).toContain('PURCHASE ORDER')
    const shipIdx = poHtml.indexOf('Consignee (Ship to)')
    expect(poHtml.slice(shipIdx, shipIdx + 300)).toContain('Kirti Sales and Services')
  })

  it('shows the combined Invoice No. / e-Way Bill No. field only for a Tax Invoice', () => {
    const invDoc = { ...baseDoc, docType: 'INVOICE', docNo: 'KSS/INV/26-27/001', ewayBill: { eway_bill_no: '1234 5678 9012', vehicle_no: 'KA01AB1234' } }
    const html = buildDocumentHTML(invDoc)
    expect(html).toContain('TAX INVOICE')
    expect(html).toContain('e-Way Bill No.')
    expect(html).toContain('1234 5678 9012')
    const piHtml = buildDocumentHTML(baseDoc)
    expect(piHtml).not.toContain('e-Way Bill No.')
  })

  it('shows IGST instead of CGST/SGST when interstate', () => {
    const html = buildDocumentHTML({ ...baseDoc, interstate: true, lines: [{ ...baseDoc.lines[0], cgst_amount: 0, sgst_amount: 0, igst_amount: 8100 }], totals: { ...baseDoc.totals, cgst_amount: 0, sgst_amount: 0, igst_amount: 8100 } })
    expect(html).toContain('IGST OUTPUT')
    expect(html).not.toContain('CGST OUTPUT')
  })

  it('paginates lines across multiple pages when there are many', () => {
    const manyLines = Array.from({ length: 40 }, (_, i) => ({ ...baseDoc.lines[0], description: `Item ${i + 1}` }))
    const html = buildDocumentHTML({ ...baseDoc, lines: manyLines })
    const pageCount = (html.match(/class="po-page"/g) || []).length
    expect(pageCount).toBeGreaterThan(1)
    expect(html).toContain('Item 40')
  })

  it('produces a valid SpreadsheetML workbook', () => {
    const xml = buildDocumentExcelXML(baseDoc)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('Kirti Sales and Services')
    expect(xml).toContain('65-PI-2026-27')
  })
})

// MVL (Mesindus Ventures Limited) shares Kirti's exact "tally" family —
// same template, different entity data — per product request to mirror
// Kirti's format for MVL.
describe('MVL uses the same tally-family template as Kirti', () => {
  const mvlDoc = {
    ...baseDoc,
    docNo: 'MVL/PI/26-27/001',
    sellerEntity: { name: 'Mesindus Ventures Limited', address: '3rd Floor, Block B, C/o. RPPMSL, No. 4/1, IBC Knowledge Park', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560029', gstin: '29AANCM1499F1ZY', pan: 'AANCM1499F' },
  }

  it('renders the tally-page layout for MVL, with MVL\'s own entity details', () => {
    const html = buildDocumentHTML(mvlDoc)
    expect(html).toContain('tally-page')
    expect(html).toContain('Mesindus Ventures Limited')
    expect(html).toContain('29AANCM1499F1ZY')
    expect(html).not.toContain('Kirti Sales and Services')
  })

  it('produces a valid SpreadsheetML workbook for MVL too', () => {
    const xml = buildDocumentExcelXML(mvlDoc)
    expect(xml).toContain('Mesindus Ventures Limited')
    expect(xml).toContain('MVL/PI/26-27/001')
  })
})

describe('dispatchInfo (Bill From/To, Ship From/To)', () => {
  it('shows only the populated rows and omits the block entirely when absent', () => {
    const html = buildDocumentHTML({ ...baseDoc, dispatchInfo: { billFrom: 'VVGTL, Panvel', billTo: '', shipFrom: 'DHL Warehouse, Panvel', shipTo: '' } })
    expect(html).toContain('Bill From')
    expect(html).toContain('VVGTL, Panvel')
    expect(html).toContain('Ship From')
    expect(html).toContain('DHL Warehouse, Panvel')
    expect(html).not.toContain('tally-dispatch-row"><span class="tally-dispatch-lbl">Bill To<')
    const noInfo = buildDocumentHTML(baseDoc)
    expect(noInfo).not.toContain('tally-dispatch')
  })
})

describe('entity-level Terms & Conditions', () => {
  it('renders the seller entity\'s configured terms, only when set', () => {
    const withTerms = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, terms_and_conditions: 'Goods once sold will not be taken back.' } })
    expect(withTerms).toContain('Goods once sold will not be taken back.')
    const without = buildDocumentHTML(baseDoc)
    expect(without).not.toContain('tally-terms')
  })
})
