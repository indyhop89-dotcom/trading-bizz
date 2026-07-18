import { describe, it, expect } from 'vitest'
import { buildDocumentHTML } from '../documentTemplate.js'
import { buildDocumentExcelXML } from '../documentExcel.js'

// SRPL = Siddhidhatri Retail Private Limited, transcribed from real
// PO/PI/Tax Invoice PDFs — see srplDocumentTemplate.js for the source.
const baseDoc = {
  docType: 'PI',
  docNo: 'SR/PI/26-27/006',
  docDate: '2026-06-27',
  sellerEntity: { name: 'Siddhidhatri Retail Private Limited', address: '1st Floor, No.17, Shivashakti Layout', city: 'Bengaluru', pincode: '562130', gstin: '29ABLCS7994J1Z7', pan: 'ABLCS7994J' },
  buyerEntity: { name: 'Vananam Retail Ventures Private Limited', address: 'No 90, 3rd Floor, 17th Cross Road', city: 'Bengaluru', pincode: '560102', gstin: '29AAJCV0573F1Z4' },
  lines: [
    { description: 'Suitings', hsn_code: '540752', qty: 14283, unit: 'Nos', rate: 570.52, gst_rate: 5, taxable_amount: 8148737.16, cgst_amount: 203718.43, sgst_amount: 203718.43, igst_amount: 0, total_amount: 8556174.02 },
  ],
  totals: { taxable_amount: 8148737.16, cgst_amount: 203718.43, sgst_amount: 203718.43, igst_amount: 0, round_off_amount: 0, total_amount: 8556174 },
  interstate: false,
  bankDetails: { bank_name: 'Kotak Mahindra Bank', bank_account_no: '1951337399', bank_ifsc: 'KKBK0008167', bank_branch: 'Kadugodi Bangalore' },
}

describe('SRPL template dispatch', () => {
  it('routes to the SRPL layout (not vananam) based on the registered theme family', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('srpl-page')
    expect(html).not.toContain('po-page')
  })

  it('renders SRPL-specific field labels transcribed from the reference PDFs', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('PI Number')
    expect(html).toContain('Terms of delivery')
    expect(html).toContain('Siddhidhatri Retail Private Limited')
    expect(html).toContain('Vananam Retail Ventures Private Limited')
  })

  it('shows bank details and PAN for PI (SRPL only shows these on PI/Invoice, not PO)', () => {
    const html = buildDocumentHTML(baseDoc)
    expect(html).toContain('Kotak Mahindra Bank')
    expect(html).toContain('ABLCS7994J')
    expect(html).toContain('E. &amp; O.E')
  })

  it('omits bank details and the extra self-referencing "Bill To" label for a PO — but does show the Supplier block', () => {
    const poDoc = { ...baseDoc, docType: 'PO', docNo: 'SRPL/PO/26-27/009' }
    const html = buildDocumentHTML(poDoc)
    expect(html).not.toContain('Kotak Mahindra Bank')
    expect(html).toContain('Bill To')
    expect(html).toContain('Supplier (Bill From)')
    expect(html).toContain('PO Number')
    expect(html).toContain('Terms of Payment')
  })

  it('shows Eway Bill No / Vehicle No for a Tax Invoice, not Terms of delivery', () => {
    const invDoc = { ...baseDoc, docType: 'INVOICE', docNo: 'SR/26-27/007', ewayBill: { eway_bill_no: '1424 6986 7647', vehicle_no: 'KA 01 AA 7060' } }
    const html = buildDocumentHTML(invDoc)
    expect(html).toContain('Invoice No')
    expect(html).toContain('Eway Bill No')
    expect(html).toContain('1424 6986 7647')
    expect(html).toContain('KA 01 AA 7060')
  })

  it('produces a valid SpreadsheetML workbook for SRPL too', () => {
    const xml = buildDocumentExcelXML(baseDoc)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('Siddhidhatri Retail Private Limited')
    expect(xml).toContain('SR/PI/26-27/006')
  })
})
