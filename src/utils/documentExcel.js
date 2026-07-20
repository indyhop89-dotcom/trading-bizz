/**
 * Shared Excel export for Proforma Invoice / Purchase Order / Tax Invoice
 * documents — ported from the standalone Vananam generator tools' Excel
 * builder: a hand-written Excel-2003 SpreadsheetML XML string, downloaded
 * as a .xls Blob. No xlsx/exceljs dependency needed. Parametrized off the
 * same `doc` shape documentTemplate.js's buildDocumentHTML() takes.
 *
 * Like the PDF template, the header color comes from the issuing entity's
 * registered theme (entityDocumentThemes.js) — refuses to generate for an
 * entity with no theme configured rather than using a generic color.
 *
 * This module owns the "vananam" family's Excel export only — a theme with
 * a different `family` dispatches to its own Excel builder (see the
 * exported buildDocumentExcelXML below), same split as documentTemplate.js.
 */
import { DOC_META, resolveThemeOrThrow } from './documentTemplate'
import { buildSRPLDocumentExcelXML } from './srplDocumentExcel'
import { buildKirtiDocumentExcelXML } from './kirtiDocumentExcel'
import { buildKamakhyaDocumentExcelXML } from './kamakhyaDocumentExcel'

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

function buildVananamExcelXML(doc, theme) {
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
  // PO's counterparty is the vendor being ordered from, not a bill-to buyer
  // — see the matching comment in documentTemplate.js's buildDocumentHTML.
  const counterpartyLabel = docType === 'PO' ? 'Vendor' : 'Bill To'
  rows += `<Row>${cell(`${meta.short} Number`, true)}${cell(docNo || '')}${emptyCells(2)}${cell(`${meta.short} Date`, true)}${cell(docDate || '')}${emptyCells(4)}</Row>`
  rows += `<Row>${cell(counterpartyLabel, true)}${cell(buyerEntity.name || '')}${emptyCells(2)}${cell('GSTIN', true)}${cell(buyerEntity.gstin || '')}${emptyCells(4)}</Row>`
  rows += `<Row ss:Height="6"/>`

  const headers = interstate
    ? ['#', 'Product / Description', 'HSN/SAC', 'Qty', 'Unit', 'Rate (₹)', 'GST %', 'Taxable (₹)', 'IGST (₹)', 'Total (₹)']
    : ['#', 'Product / Description', 'HSN/SAC', 'Qty', 'Unit', 'Rate (₹)', 'GST %', 'Taxable (₹)', 'GST Amt (₹)', 'Total (₹)']
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
  rows += `<Row>${emptyCells(6)}${cell('Taxable Amount', true)}${cell(Number(totals.taxable_amount) || 0, false, 'num')}${emptyCells(2)}</Row>`
  if (interstate) {
    rows += `<Row>${emptyCells(6)}${cell('IGST', true)}${cell(Number(totals.igst_amount) || 0, false, 'num')}${emptyCells(2)}</Row>`
  } else {
    rows += `<Row>${emptyCells(6)}${cell('CGST', true)}${cell(Number(totals.cgst_amount) || 0, false, 'num')}${emptyCells(2)}</Row>`
    rows += `<Row>${emptyCells(6)}${cell('SGST', true)}${cell(Number(totals.sgst_amount) || 0, false, 'num')}${emptyCells(2)}</Row>`
  }
  rows += `<Row>${emptyCells(6)}${cell('Round Off', true)}${cell(Number(totals.round_off_amount) || 0, false, 'num')}${emptyCells(2)}</Row>`
  rows += `<Row>${emptyCells(6)}${cell('Grand Total (₹)', true)}${cell(Number(totals.total_amount) || 0, true, 'total')}${emptyCells(2)}</Row>`
  rows += `<Row ss:Height="6"/>`
  if (bankDetails.bank_name || bankDetails.bank_account_no) {
    rows += `<Row>${cell(`Bank: ${bankDetails.bank_name || '—'}  |  A/C: ${bankDetails.bank_account_no || '—'}  |  IFSC: ${bankDetails.bank_ifsc || '—'}`)}${emptyCells(9)}</Row>`
  }

  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles>` +
    `<Style ss:ID="Default"/><Style ss:ID="1"><Font ss:Bold="1"/></Style>` +
    `<Style ss:ID="4"><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="5"><Font ss:Bold="1"/><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="6"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="${theme.navy}" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00"/></Style>` +
    `<Style ss:ID="7"><Font ss:Bold="1" ss:Size="13"/></Style>` +
    `<Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="${theme.navy}" ss:Pattern="Solid"/></Style>` +
    `</Styles><Worksheet ss:Name="${xesc(meta.title)}"><Table ss:DefaultColumnWidth="80" ss:DefaultRowHeight="16">` +
    `<Column ss:Width="28"/><Column ss:Width="200"/><Column ss:Width="68"/><Column ss:Width="48"/><Column ss:Width="48"/><Column ss:Width="80"/><Column ss:Width="48"/><Column ss:Width="88"/><Column ss:Width="88"/><Column ss:Width="88"/>` +
    `${rows}</Table></Worksheet></Workbook>`
}

export function buildDocumentExcelXML(doc) {
  const theme = resolveThemeOrThrow(doc.sellerEntity)
  if (theme.family === 'srpl') return buildSRPLDocumentExcelXML(doc)
  if (theme.family === 'tally') return buildKirtiDocumentExcelXML(doc)
  if (theme.family === 'kamakhya') return buildKamakhyaDocumentExcelXML(doc, theme)
  return buildVananamExcelXML(doc, theme)
}

export function downloadDocumentExcel(doc) {
  const meta = DOC_META[doc.docType] || DOC_META.PI
  const xml = buildDocumentExcelXML(doc)
  const filename = `${(doc.docNo || meta.short).replace(/\//g, '-')}_${meta.short}.xls`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
