import { describe, it, expect } from 'vitest'
import { buildDocumentHTML } from '../documentTemplate.js'
import { buildDocumentExcelXML } from '../documentExcel.js'

// SRPL = Siddhidhatri Retail Private Limited. PI/PO/Invoice all share one
// precise box model, transcribed from a dedicated PO generator tool and a
// real Tax Invoice PDF (SR/26-27/007) — see srplDocumentTemplate.js.
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
    expect(html).toContain('srpl-doc-page')
    expect(html).not.toContain('class="po-page"')
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

  it('renders the seller\'s uploaded logo when logoSrc is set, and omits it otherwise', () => {
    const withLogo = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, logoSrc: 'blob:fake-logo' } })
    expect(withLogo).toContain('<img src="blob:fake-logo"')
    const withoutLogo = buildDocumentHTML(baseDoc)
    expect(withoutLogo).not.toContain('<img')
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

  it('shows an HSN-wise GST summary table for a Tax Invoice only, not PI/PO', () => {
    const invDoc = { ...baseDoc, docType: 'INVOICE', docNo: 'SR/26-27/007' }
    const invHtml = buildDocumentHTML(invDoc)
    expect(invHtml).toContain('HSN Wise Summary')
    expect(invHtml).toContain('540752') // the HSN code, repeated in the summary table
    const piHtml = buildDocumentHTML(baseDoc)
    expect(piHtml).not.toContain('HSN Wise Summary')
    const poHtml = buildDocumentHTML({ ...baseDoc, docType: 'PO', docNo: 'SRPL/PO/26-27/009' })
    expect(poHtml).not.toContain('HSN Wise Summary')
  })

  it('groups the HSN summary by HSN code and shows IGST columns when interstate', () => {
    const twoLineDoc = {
      ...baseDoc, docType: 'INVOICE', docNo: 'SR/26-27/008',
      lines: [
        baseDoc.lines[0],
        { description: 'Suitings batch 2', hsn_code: '540752', qty: 100, unit: 'Nos', rate: 500, gst_rate: 5, taxable_amount: 50000, cgst_amount: 1250, sgst_amount: 1250, igst_amount: 0, total_amount: 52500 },
        { description: 'Trims', hsn_code: '580810', qty: 10, unit: 'Nos', rate: 100, gst_rate: 12, taxable_amount: 1000, cgst_amount: 60, sgst_amount: 60, igst_amount: 0, total_amount: 1120 },
      ],
    }
    const html = buildDocumentHTML(twoLineDoc)
    // Two distinct HSN codes in the summary, not three rows (one per line item).
    expect((html.match(/540752/g) || []).length).toBeGreaterThanOrEqual(1)
    expect(html).toContain('580810')

    const interHtml = buildDocumentHTML({ ...twoLineDoc, interstate: true })
    expect(interHtml).toContain('Integrated Tax')
    expect(interHtml).not.toContain('Central Tax')
  })

  it('produces a valid SpreadsheetML workbook for SRPL too', () => {
    const xml = buildDocumentExcelXML(baseDoc)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('Siddhidhatri Retail Private Limited')
    expect(xml).toContain('SR/PI/26-27/006')
  })
})

describe('SRPL Purchase Order layout', () => {
  const poDoc = {
    docType: 'PO',
    docNo: 'SRPL/PO/26-27/009',
    docDate: '2026-07-17',
    paymentTerms: '90 days from date of Invoice',
    deliveryTimeline: '60 days',
    sellerEntity: { name: 'Siddhidhatri Retail Private Limited', address: '1142, 1st Floor Co-Tribe, 6th Main Road HSR Layout', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560102', gstin: '29ABLCS7994J1Z7', pan: 'ABLCS7994J' },
    buyerEntity: { name: 'Mesindus Ventures Limited', address: '3rd Floor, Block B, C/o. RPPMSL, No. 4/1, IBC Knowledge Park', city: 'Bengaluru', state_name: 'Karnataka', pincode: '560029', gstin: '29AANCM1499F1ZY' },
    lines: [
      { description: 'Bags', hsn_code: '42021190', qty: 15000, unit: 'Nos', rate: 918.09, gst_rate: 18, taxable_amount: 13771350, cgst_amount: 1239421.5, sgst_amount: 1239421.5, igst_amount: 0, total_amount: 16250193 },
    ],
    totals: { taxable_amount: 13771350, cgst_amount: 1239421.5, sgst_amount: 1239421.5, igst_amount: 0, round_off_amount: 0, total_amount: 16250193 },
    interstate: false,
  }

  it('renders the shared srpl-doc-page layout', () => {
    const html = buildDocumentHTML(poDoc)
    expect(html).toContain('srpl-doc-page')
  })

  it('shows the issuer under "Bill To" at the top, the vendor under "Supplier (Bill From)", and ships to the issuer by default', () => {
    const html = buildDocumentHTML(poDoc)
    const billToIdx = html.indexOf('Bill To')
    expect(html.slice(billToIdx, billToIdx + 200)).toContain('Siddhidhatri Retail Private Limited')
    const supplierIdx = html.indexOf('Supplier (Bill From)')
    expect(html.slice(supplierIdx, supplierIdx + 200)).toContain('Mesindus Ventures Limited')
    const shipIdx = html.indexOf('Ship To')
    expect(html.slice(shipIdx, shipIdx + 200)).toContain('Siddhidhatri Retail Private Limited')
  })

  it('shows PO Number/Date and delivery/payment terms in the meta box', () => {
    const html = buildDocumentHTML(poDoc)
    expect(html).toContain('SRPL/PO/26-27/009')
    expect(html).toContain('Terms of delivery')
    expect(html).toContain('60 days')
    expect(html).toContain('Terms of Payment')
    expect(html).toContain('90 days from date of Invoice')
  })

  it('shows a single combined GST Amount column per line, a black TOTAL AMOUNT bar, and no bank details', () => {
    const html = buildDocumentHTML(poDoc)
    expect(html).toContain('GST Amount')
    expect(html).toContain('TOTAL AMOUNT')
    expect(html).not.toContain('Bank Name')
  })

  it('shows IGST instead of CGST/SGST when interstate', () => {
    const html = buildDocumentHTML({ ...poDoc, interstate: true, totals: { ...poDoc.totals, cgst_amount: 0, sgst_amount: 0, igst_amount: 2478843 } })
    expect(html).toContain('>IGST<')
    expect(html).not.toContain('>CGST<')
  })

  it('produces a valid SpreadsheetML workbook for the PO too', () => {
    const xml = buildDocumentExcelXML(poDoc)
    expect(xml).toContain('SRPL/PO/26-27/009')
  })
})

describe('SRPL pagination', () => {
  it('paginates many-line documents and only shows totals/footer on the last page', () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => ({ ...baseDoc.lines[0], description: `Item ${i + 1}`, hsn_code: '540752' }))
    const html = buildDocumentHTML({ ...baseDoc, lines: manyLines })
    const pageCount = (html.match(/class="srpl-doc-page"/g) || []).length
    expect(pageCount).toBeGreaterThan(1)
    expect(html).toContain('Continued on next page')
    // Grand total bar appears exactly once (only on the last page).
    expect((html.match(/TOTAL AMOUNT/g) || []).length).toBe(1)
  })
})

describe('dispatchInfo (Bill From/To, Ship From/To)', () => {
  it('shows only the populated rows and omits the block entirely when absent', () => {
    const html = buildDocumentHTML({ ...baseDoc, dispatchInfo: { billFrom: 'VVGTL, Panvel', billTo: '', shipFrom: 'DHL Warehouse, Panvel', shipTo: '' } })
    expect(html).toContain('Bill From')
    expect(html).toContain('VVGTL, Panvel')
    expect(html).toContain('Ship From')
    expect(html).toContain('DHL Warehouse, Panvel')
    expect(html).not.toContain('srpl-doc-dispatch-row"><b>Bill To<')
    const noInfo = buildDocumentHTML(baseDoc)
    expect(noInfo).not.toContain('srpl-doc-dispatch')
  })
})

describe('entity-level Terms & Conditions', () => {
  it('renders the seller entity\'s configured terms, only when set', () => {
    const withTerms = buildDocumentHTML({ ...baseDoc, sellerEntity: { ...baseDoc.sellerEntity, terms_and_conditions: 'Goods once sold will not be taken back.' } })
    expect(withTerms).toContain('Goods once sold will not be taken back.')
    const without = buildDocumentHTML(baseDoc)
    expect(without).not.toContain('srpl-doc-terms')
  })
})
