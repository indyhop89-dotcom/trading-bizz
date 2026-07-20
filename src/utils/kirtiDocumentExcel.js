/**
 * Kirti Sales and Services' Excel export — same Excel-2003 SpreadsheetML
 * technique as documentExcel.js's "vananam" family builder, matching the
 * plain black-header style of the reference Tally-style generator tool
 * (see kirtiDocumentTemplate.js for the print layout this pairs with).
 */
import { fmtDate } from './dates'
import { DOC_META } from './documentTemplate'

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

export function buildKirtiDocumentExcelXML(doc) {
  const {
    docType, docNo, docDate,
    sellerEntity = {}, buyerEntity = {},
    lines = [], totals = {}, interstate = false,
    bankDetails = {},
  } = doc
  const meta = DOC_META[docType] || DOC_META.PI
  const sellerAddr = [sellerEntity.address, [sellerEntity.city, sellerEntity.state_name, sellerEntity.pincode].filter(Boolean).join(', ')].filter(Boolean).join(', ')

  let rows = ''
  rows += `<Row ss:Height="22"><Cell ss:MergeAcross="9" s="7"><Data ss:Type="String">${xesc(sellerEntity.name || '')} — ${xesc(meta.title.toUpperCase())}</Data></Cell></Row>`
  rows += `<Row ss:Height="13"><Cell ss:MergeAcross="9"><Data ss:Type="String">${xesc(sellerAddr)}${sellerEntity.gstin ? ' | GSTIN: ' + xesc(sellerEntity.gstin) : ''}</Data></Cell></Row>`
  rows += `<Row ss:Height="6"/>`
  const counterpartyLabel = docType === 'PO' ? 'Supplier' : 'Buyer'
  rows += `<Row>${cell(`${meta.short} No.`, true)}${cell(docNo || '')}${emptyCells(2)}${cell(`${meta.short} Date`, true)}${cell(fmtDate(docDate))}${emptyCells(4)}</Row>`
  rows += `<Row>${cell(counterpartyLabel, true)}${cell(buyerEntity.name || '')}${emptyCells(2)}${cell('GSTIN', true)}${cell(buyerEntity.gstin || '')}${emptyCells(4)}</Row>`
  rows += `<Row ss:Height="6"/>`

  const headers = ['Sl No.', 'Description of Goods', 'HSN/SAC', 'Qty', 'Unit', 'Rate', 'GST %', 'Taxable Amount', interstate ? 'IGST' : 'CGST+SGST', 'Amount']
  rows += `<Row ss:Height="18">${headers.map(h => cell(h, true, 'hdr')).join('')}</Row>`

  lines.forEach((l, i) => {
    const gstAmt = interstate ? (Number(l.igst_amount) || 0) : (Number(l.cgst_amount) || 0) + (Number(l.sgst_amount) || 0)
    rows += `<Row ss:Height="16">${cell(i + 1)}${cell(l.description || '')}${cell(l.hsn_code || '')}` +
      `<Cell><Data ss:Type="Number">${Number(l.qty) || 0}</Data></Cell>${cell(l.unit || 'Nos')}` +
      `<Cell><Data ss:Type="Number">${Number(l.rate) || 0}</Data></Cell>` +
      `<Cell><Data ss:Type="Number">${Number(l.gst_rate) || 0}</Data></Cell>` +
      `<Cell><Data ss:Type="Number">${Number(l.taxable_amount) || 0}</Data></Cell>` +
      `<Cell><Data ss:Type="Number">${gstAmt}</Data></Cell>` +
      `<Cell><Data ss:Type="Number">${Number(l.total_amount) || 0}</Data></Cell></Row>`
  })

  rows += `<Row ss:Height="6"/>`
  rows += `<Row>${emptyCells(7)}${cell('Taxable Amount', true)}${cell(Number(totals.taxable_amount) || 0, false, 'num')}${emptyCells(1)}</Row>`
  if (interstate) {
    rows += `<Row>${emptyCells(7)}${cell('IGST', true)}${cell(Number(totals.igst_amount) || 0, false, 'num')}${emptyCells(1)}</Row>`
  } else {
    rows += `<Row>${emptyCells(7)}${cell('CGST', true)}${cell(Number(totals.cgst_amount) || 0, false, 'num')}${emptyCells(1)}</Row>`
    rows += `<Row>${emptyCells(7)}${cell('SGST', true)}${cell(Number(totals.sgst_amount) || 0, false, 'num')}${emptyCells(1)}</Row>`
  }
  rows += `<Row>${emptyCells(7)}${cell('Round Off', true)}${cell(Number(totals.round_off_amount) || 0, false, 'num')}${emptyCells(1)}</Row>`
  rows += `<Row>${emptyCells(7)}${cell('Grand Total', true)}${cell(Number(totals.total_amount) || 0, true, 'total')}${emptyCells(1)}</Row>`
  rows += `<Row ss:Height="6"/>`
  if (docType !== 'PO' && (bankDetails.bank_name || bankDetails.bank_account_no)) {
    rows += `<Row>${cell(`Bank: ${bankDetails.bank_name || '—'}  |  A/C: ${bankDetails.bank_account_no || '—'}  |  IFSC: ${bankDetails.bank_ifsc || '—'}`)}${emptyCells(9)}</Row>`
  }

  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles>` +
    `<Style ss:ID="Default"/><Style ss:ID="1"><Font ss:Bold="1"/></Style>` +
    `<Style ss:ID="4"><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="5"><Font ss:Bold="1"/><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="6"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#000000" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="7"><Font ss:Bold="1" ss:Size="13"/></Style>` +
    `<Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#000000" ss:Pattern="Solid"/></Style>` +
    `</Styles><Worksheet ss:Name="${xesc(meta.title)}"><Table ss:DefaultColumnWidth="80" ss:DefaultRowHeight="16">` +
    `<Column ss:Width="28"/><Column ss:Width="200"/><Column ss:Width="68"/><Column ss:Width="48"/><Column ss:Width="48"/><Column ss:Width="70"/><Column ss:Width="48"/><Column ss:Width="88"/><Column ss:Width="88"/><Column ss:Width="88"/>` +
    `${rows}</Table></Worksheet></Workbook>`
}
