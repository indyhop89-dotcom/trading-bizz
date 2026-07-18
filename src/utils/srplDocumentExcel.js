/**
 * SRPL's Excel export — same Excel-2003 SpreadsheetML technique as
 * documentExcel.js's "vananam" family builder, but matching SRPL's own
 * column set (one combined GST Amount column, no CGST/SGST split per line)
 * and field labels (see srplDocumentTemplate.js for the source PDFs this
 * was transcribed from).
 */
import { fmtDate } from './dates'

function xesc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function cell(v, bold = false, numFmt = '') {
  let s = bold ? 's="1"' : ''
  if (numFmt === 'num')   s = bold ? 's="5"' : 's="4"'
  if (numFmt === 'total') s = 's="6"'
  if (numFmt === 'hdr')   s = 's="hdr"'
  const isNum = typeof v === 'number'
  return `<Cell ${s}><Data ss:Type="${isNum ? 'Number' : 'String'}">${isNum ? v : xesc(v)}</Data></Cell>`
}

function emptyCells(n = 1) {
  return '<Cell/>'.repeat(n)
}

const SRPL_TITLES = { PI: 'Proforma Invoice', PO: 'Purchase Order', INVOICE: 'Tax Invoice' }
const SRPL_NUMBER_LABELS = { PI: 'PI Number', PO: 'PO Number', INVOICE: 'Invoice No' }

export function buildSRPLDocumentExcelXML(doc) {
  const {
    docType, docNo, docDate,
    sellerEntity = {}, buyerEntity = {},
    lines = [], totals = {}, interstate = false,
  } = doc
  const isPO = docType === 'PO'
  const counterpartyLabel = isPO ? 'Supplier (Bill From)' : 'Bill To'
  const title = SRPL_TITLES[docType] || 'Document'
  const sellerAddr = [sellerEntity.address, [sellerEntity.city, sellerEntity.state_name, sellerEntity.pincode].filter(Boolean).join(', ')].filter(Boolean).join(', ')

  let rows = ''
  rows += `<Row ss:Height="22"><Cell ss:MergeAcross="7" s="7"><Data ss:Type="String">${xesc(sellerEntity.name || '')} — ${xesc(title.toUpperCase())}</Data></Cell></Row>`
  rows += `<Row ss:Height="13"><Cell ss:MergeAcross="7"><Data ss:Type="String">${xesc(sellerAddr)}${sellerEntity.gstin ? ' | GST: ' + xesc(sellerEntity.gstin) : ''}</Data></Cell></Row>`
  rows += `<Row ss:Height="6"/>`
  rows += `<Row>${cell(SRPL_NUMBER_LABELS[docType] || 'Doc No', true)}${cell(docNo || '')}${emptyCells(1)}${cell('Date', true)}${cell(fmtDate(docDate))}${emptyCells(3)}</Row>`
  rows += `<Row>${cell(counterpartyLabel, true)}${cell(buyerEntity.name || '')}${emptyCells(1)}${cell('GSTIN', true)}${cell(buyerEntity.gstin || '')}${emptyCells(3)}</Row>`
  rows += `<Row ss:Height="6"/>`

  const headers = ['SL. NO.', 'Description', 'HSN NO.', 'QTY', 'Unit', 'Rate', 'GST %', 'Taxable Amount', 'GST Amount']
  rows += `<Row ss:Height="18">${headers.map(h => cell(h, true, 'hdr')).join('')}</Row>`

  lines.forEach((l, i) => {
    const gstAmt = (Number(l.cgst_amount) || 0) + (Number(l.sgst_amount) || 0) + (Number(l.igst_amount) || 0)
    rows += `<Row ss:Height="16">${cell(i + 1)}${cell(l.description || '')}${cell(l.hsn_code || '')}` +
      `<Cell><Data ss:Type="Number">${Number(l.qty) || 0}</Data></Cell>${cell(l.unit || 'Nos')}` +
      `<Cell><Data ss:Type="Number">${Number(l.rate) || 0}</Data></Cell>` +
      `<Cell><Data ss:Type="Number">${Number(l.gst_rate) || 0}</Data></Cell>` +
      `<Cell><Data ss:Type="Number">${Number(l.taxable_amount) || 0}</Data></Cell>` +
      `<Cell><Data ss:Type="Number">${gstAmt}</Data></Cell></Row>`
  })

  rows += `<Row ss:Height="6"/>`
  rows += `<Row>${emptyCells(6)}${cell('TAXABLE AMOUNT', true)}${cell(Number(totals.taxable_amount) || 0, false, 'num')}</Row>`
  if (interstate) {
    rows += `<Row>${emptyCells(6)}${cell('IGST', true)}${cell(Number(totals.igst_amount) || 0, false, 'num')}</Row>`
  } else {
    rows += `<Row>${emptyCells(6)}${cell('CGST', true)}${cell(Number(totals.cgst_amount) || 0, false, 'num')}</Row>`
    rows += `<Row>${emptyCells(6)}${cell('SGST', true)}${cell(Number(totals.sgst_amount) || 0, false, 'num')}</Row>`
  }
  rows += `<Row>${emptyCells(6)}${cell('ROUND OFF', true)}${cell(Number(totals.round_off_amount) || 0, false, 'num')}</Row>`
  rows += `<Row>${emptyCells(6)}${cell('TOTAL AMOUNT', true)}${cell(Number(totals.total_amount) || 0, true, 'total')}</Row>`

  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles>` +
    `<Style ss:ID="Default"/><Style ss:ID="1"><Font ss:Bold="1"/></Style>` +
    `<Style ss:ID="4"><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="5"><Font ss:Bold="1"/><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="6"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1A1A1A" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="7"><Font ss:Bold="1" ss:Size="13"/></Style>` +
    `<Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#F0F0F0" ss:Pattern="Solid"/></Style>` +
    `</Styles><Worksheet ss:Name="${xesc(title)}"><Table ss:DefaultColumnWidth="80" ss:DefaultRowHeight="16">` +
    `<Column ss:Width="34"/><Column ss:Width="200"/><Column ss:Width="60"/><Column ss:Width="48"/><Column ss:Width="40"/><Column ss:Width="70"/><Column ss:Width="40"/><Column ss:Width="95"/><Column ss:Width="95"/>` +
    `${rows}</Table></Worksheet></Workbook>`
}
