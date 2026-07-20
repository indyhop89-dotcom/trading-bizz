/**
 * Kamakhya Loyalties document template — transcribed from a standalone
 * Zoho-style PI generator HTML tool shared for this entity (bordered A4
 * layout: thin grey/black rules throughout, no color-filled header bars,
 * one navy accent used only for headings/emphasis text).
 *
 * Genuinely different structure from every other family, not a recolor:
 *  - Header is a single 3-cell row — logo | company block | big doc-title
 *    text — rather than vananam's flex header or srpl's two-row grid.
 *  - A dedicated 2-column "meta" grid (Number/Date/Valid-Until-or-Due-Date
 *    on the left, Place of Supply/Payment Terms/Mode of Transport on the
 *    right) sits between the header and the Bill To/Ship To party grid —
 *    neither vananam nor srpl has this as a separate bordered block.
 *  - One combined "GST Amt" column per line (like srpl), not vananam's
 *    per-line CGST/SGST split.
 *  - Footer is a two-column "final block" (Total-in-words + Notes on the
 *    left, a bordered totals box + signature on the right) followed by a
 *    separate two-column Bank Details / Terms & Conditions strip below
 *    it — the reference tool's exact layout, distinct from srpl's stacked
 *    words-box+totals-grid+grand-bar+HSN-table+bank/sign sequence.
 *  - No HSN-wise GST summary table — the reference format doesn't have one
 *    (unlike vananam/srpl's Invoice-only summary).
 *
 * Pagination follows the same measured-height approach as
 * srplDocumentTemplate.js/kirtiDocumentTemplate.js: canvas.measureText() to
 * find real word-wrap points (a flat characters-per-line guess undercounts
 * badly — see those files' history), fixed mm overhead for the repeating
 * header (fullHeaderMm on page 1, a slim companyHeaderMm on continuation
 * pages, matching the reference's own "full header vs. compact continuation
 * header" split), and a footer reserve computed from the actual document
 * (tax-row count, notes/terms text length) so the last page is sized
 * backward from its real footer instead of guessed forward.
 */
import { fmtDate } from './dates'
import { esc, fmtN, numWords, addressLines } from './documentHelpers'

const KAMAKHYA_META = {
  PI:      { title: 'Proforma Invoice', numberLabel: 'PI No.',      dateLabel: 'Valid Until' },
  PO:      { title: 'Purchase Order',   numberLabel: 'PO No.',      dateLabel: 'Delivery By' },
  INVOICE: { title: 'Tax Invoice',      numberLabel: 'Invoice No.', dateLabel: 'Due Date' },
}

// Page geometry transcribed from the reference tool's CSS (190mm x 277mm
// page, sized to sit inside a 10mm print margin on A4).
const KAMAKHYA_PAGE_MM = 277
// First-page header: header-table row (28mm, fixed) + meta-table (a
// generous 20mm for up to 4 stacked label:value lines per column) +
// party-table row (31mm, fixed) + items thead (5mm).
const KAMAKHYA_HEADER_MM = 28 + 20 + 31 + 5
// Continuation pages use the reference's compact "company name | doc type +
// number" strip (12mm) instead of the full header.
const KAMAKHYA_CONT_HEADER_MM = 12 + 5
const KAMAKHYA_PAGENOTE_RESERVE_MM = 7
// Description column is 25% of the ~190mm items table, minus ~1.6mm of
// cell padding on each side.
const KAMAKHYA_DESC_COLUMN_WIDTH_MM = 190 * 0.25 - 1.6
const KAMAKHYA_ROW_PADDING_MM = 1.5 // .75mm top + .75mm bottom cell padding
const KAMAKHYA_ROW_LINE_HEIGHT_MM = 3.4 // 8.2pt font * 1.16 line-height, measured in mm
const MM_PER_PX = 25.4 / 96

let _kamakhyaMeasureCtx = null
function measureKamakhyaTextWidthPx(text) {
  if (typeof document === 'undefined') return String(text).length * 5.5 // non-browser fallback, shouldn't normally be hit
  if (!_kamakhyaMeasureCtx) _kamakhyaMeasureCtx = document.createElement('canvas').getContext('2d')
  _kamakhyaMeasureCtx.font = '10.9px Arial' // 8.2pt at 96dpi
  return _kamakhyaMeasureCtx.measureText(text).width
}

function countKamakhyaWrappedLines(text, maxWidthPx) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  let lines = 1
  let lineWidthPx = 0
  const spaceWidthPx = measureKamakhyaTextWidthPx(' ')
  for (const word of words) {
    const wordWidthPx = measureKamakhyaTextWidthPx(word)
    const candidateWidthPx = lineWidthPx === 0 ? wordWidthPx : lineWidthPx + spaceWidthPx + wordWidthPx
    if (candidateWidthPx > maxWidthPx && lineWidthPx > 0) {
      lines++
      lineWidthPx = wordWidthPx
    } else {
      lineWidthPx = candidateWidthPx
    }
  }
  return lines
}

function estimateKamakhyaRowHeightMm(description) {
  const maxWidthPx = KAMAKHYA_DESC_COLUMN_WIDTH_MM / MM_PER_PX
  const wrappedLines = countKamakhyaWrappedLines(description, maxWidthPx)
  return KAMAKHYA_ROW_PADDING_MM + wrappedLines * KAMAKHYA_ROW_LINE_HEIGHT_MM
}

// Fixed content on the true last page, below the items table: the
// notes/words + totals/signature final block (~55mm base, generous against
// the reference's rendered box) + the bank/terms strip below it (~24mm
// fixed) + a per-tax-row allowance (1 row for IGST, 2 for CGST+SGST) + a
// rough per-wrapped-line allowance for Notes and for the entity's Terms &
// Conditions text (same class of estimate as the row-height heuristic
// above — full column width at this font, ~60 chars/line for the narrower
// notes column, ~95 for the full-width terms strip).
function estimateKamakhyaFooterReserveMm(interstate, notesText, termsText) {
  const base = 55 + 24
  const taxRows = interstate ? 1 : 2
  const notesLines = notesText ? Math.max(1, Math.ceil(String(notesText).length / 60)) : 0
  const termsLines = termsText ? Math.max(1, Math.ceil(String(termsText).length / 95)) : 0
  return base + taxRows * 4 + (notesText ? 4 + notesLines * 3.6 : 0) + (termsText ? 4 + termsLines * 3.6 : 0)
}

function paginateKamakhyaLines(lines, footerReserveMm) {
  const regularBudget = KAMAKHYA_PAGE_MM - KAMAKHYA_HEADER_MM - KAMAKHYA_PAGENOTE_RESERVE_MM
  const contBudget = KAMAKHYA_PAGE_MM - KAMAKHYA_CONT_HEADER_MM - KAMAKHYA_PAGENOTE_RESERVE_MM
  const lastBudgetFromFirst = KAMAKHYA_PAGE_MM - KAMAKHYA_HEADER_MM - footerReserveMm
  const lastBudgetFromCont = KAMAKHYA_PAGE_MM - KAMAKHYA_CONT_HEADER_MM - footerReserveMm

  if (!lines.length) return [[]]

  const heights = lines.map(l => estimateKamakhyaRowHeightMm(l.description))

  // Largest trailing run of lines that fits the true last page — its budget
  // depends on whether that last page is also page 1 (full header) or a
  // continuation (slim header), so try both and use whichever admits more
  // rows without exceeding either constraint.
  let lastPageStart = lines.length - 1
  let lastHeight = heights[lastPageStart]
  const fitsLast = (start, height) => height <= (start === 0 ? lastBudgetFromFirst : lastBudgetFromCont)
  while (lastPageStart > 0 && fitsLast(lastPageStart - 1, lastHeight + heights[lastPageStart - 1])) {
    lastPageStart--
    lastHeight += heights[lastPageStart]
  }

  const pages = []
  if (lastPageStart > 0) {
    let current = []
    let currentHeight = 0
    for (let i = 0; i < lastPageStart; i++) {
      const h = heights[i]
      const budget = pages.length === 0 ? regularBudget : contBudget
      if (current.length && currentHeight + h > budget) {
        pages.push(current)
        current = []
        currentHeight = 0
      }
      current.push(lines[i])
      currentHeight += h
    }
    pages.push(current)
  }
  pages.push(lines.slice(lastPageStart))

  return pages
}

function rowHTML(l, sl) {
  return `<tr>
    <td class="c-sl">${sl}</td>
    <td class="c-desc"><div class="kam-doc-desc-main">${esc(l.description).replace(/\n/g, '<br>')}</div></td>
    <td class="c-hsn">${esc(l.hsn_code) || '—'}</td>
    <td class="c-qty">${fmtN(l.qty)}</td>
    <td class="c-unit">${esc(l.unit) || 'Nos'}</td>
    <td class="c-rate">${fmtN(l.rate)}</td>
    <td class="c-gstp">${fmtN(l.gst_rate)}%</td>
    <td class="c-gsta">${fmtN((Number(l.cgst_amount) || 0) + (Number(l.sgst_amount) || 0) + (Number(l.igst_amount) || 0))}</td>
    <td class="c-amt">${fmtN(l.taxable_amount)}</td>
  </tr>`
}

export function buildKamakhyaDocumentHTML(doc) {
  const {
    docType, docNo, docDate, validOrDueDate,
    paymentTerms, modeOfTransport = 'Road', placeOfSupply,
    sellerEntity = {}, buyerEntity = {}, shipTo,
    lines = [], totals = {}, interstate = false,
    bankDetails = {}, notes, ewayBill, dispatchInfo,
  } = doc
  const meta = KAMAKHYA_META[docType] || KAMAKHYA_META.PI
  const isPO = docType === 'PO'
  const isInvoice = docType === 'INVOICE'
  // Same reversed-roles convention used everywhere else in this app for a
  // PO: sellerEntity is the issuing buyer, buyerEntity is the vendor being
  // ordered from, and goods ship to the issuer's own address by default.
  const ship = shipTo || (isPO ? sellerEntity : buyerEntity)
  const counterpartyLabel = isPO ? 'Vendor' : 'Bill To'

  const footerReserveMm = estimateKamakhyaFooterReserveMm(interstate, notes, sellerEntity.terms_and_conditions)
  const pages = paginateKamakhyaLines(lines, footerReserveMm)
  const totalPages = pages.length

  function metaTableHTML() {
    const leftRows = [
      [meta.numberLabel, esc(docNo)],
      ['Date', fmtDate(docDate)],
      [meta.dateLabel, fmtDate(validOrDueDate)],
    ]
    if (isInvoice && ewayBill?.eway_bill_no) leftRows.push(['E-way Bill No.', esc(ewayBill.eway_bill_no)])
    const rightRows = [
      ['Place of Supply', esc(placeOfSupply || buyerEntity.state_name || '—')],
      ['Payment Terms', esc(paymentTerms || '—')],
      ['Mode of Transport', esc(modeOfTransport)],
    ]
    if (isInvoice && ewayBill?.vehicle_no) rightRows.push(['Vehicle No.', esc(ewayBill.vehicle_no)])
    const col = rows => rows.map(([l, v]) => `<div class="kam-doc-meta-line"><span class="kam-doc-meta-key">${l}</span><span class="kam-doc-meta-val">: ${v}</span></div>`).join('')
    return `<table class="kam-doc-meta"><tr><td>${col(leftRows)}</td><td>${col(rightRows)}</td></tr></table>`
  }

  function fullHeaderHTML() {
    return `<table class="kam-doc-header">
      <tr>
        <td class="kam-doc-logo-cell">${sellerEntity.logoSrc ? `<img src="${sellerEntity.logoSrc}" alt="${esc(sellerEntity.name)}">` : '<div class="kam-doc-logo-ph">Company Logo</div>'}</td>
        <td class="kam-doc-company-cell">
          <div class="kam-doc-company-name">${esc((sellerEntity.name || '').toUpperCase())}</div>
          <div>${addressLines(sellerEntity)}</div>
          ${sellerEntity.gstin ? `<div>GSTIN: ${esc(sellerEntity.gstin)}</div>` : ''}
        </td>
        <td class="kam-doc-title-cell">${esc(meta.title.toUpperCase())}</td>
      </tr>
    </table>
    ${metaTableHTML()}
    <table class="kam-doc-party">
      <tr>
        <td>
          <div class="kam-doc-party-head">${esc(counterpartyLabel)}</div>
          <div class="kam-doc-party-body"><b>${esc(buyerEntity.name)}</b><br>${addressLines(buyerEntity)}${buyerEntity.gstin ? `<br>GSTIN: ${esc(buyerEntity.gstin)}` : ''}</div>
        </td>
        <td>
          <div class="kam-doc-party-head">Ship To</div>
          <div class="kam-doc-party-body"><b>${esc(ship.name)}</b><br>${addressLines(ship)}</div>
        </td>
      </tr>
    </table>`
  }

  function continuationHeaderHTML() {
    return `<table class="kam-doc-cont-head"><tr>
      <td class="kam-doc-cont-brand">${esc(sellerEntity.name || '')}</td>
      <td class="kam-doc-cont-meta">${esc(meta.title)} &nbsp;|&nbsp; No. ${esc(docNo)}</td>
    </tr></table>`
  }

  // Free-text overrides captured per-document (dispatch location can differ
  // from the seller's registered address) — same shape/placement (footer,
  // last page only) as srplDocumentTemplate.js/kirtiDocumentTemplate.js.
  function dispatchInfoHTML() {
    if (!dispatchInfo) return ''
    const { billFrom, billTo, shipFrom, shipTo: shipToNote } = dispatchInfo
    const rows = [
      ['Bill From', billFrom], ['Bill To', billTo],
      ['Ship From', shipFrom], ['Ship To', shipToNote],
    ].filter(([, v]) => v)
    if (!rows.length) return ''
    return `<div class="kam-doc-dispatch">
      ${rows.map(([label, value]) => `<div class="kam-doc-dispatch-row"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('')}
    </div>`
  }

  function finalBlockHTML() {
    const taxRows = interstate
      ? `<tr><td class="lbl">IGST</td><td class="val">₹ ${fmtN(totals.igst_amount)}</td></tr>`
      : `<tr><td class="lbl">CGST</td><td class="val">₹ ${fmtN(totals.cgst_amount)}</td></tr><tr><td class="lbl">SGST</td><td class="val">₹ ${fmtN(totals.sgst_amount)}</td></tr>`
    return `<div class="kam-doc-final">
      <div class="kam-doc-notes">
        <div class="kam-doc-words-title">Total In Words</div>
        <div class="kam-doc-words">${numWords(totals.total_amount)}</div>
        ${dispatchInfoHTML()}
        ${notes ? `<div class="kam-doc-note-title">Notes</div><div class="kam-doc-note-line">${esc(notes).replace(/\n/g, '<br>')}</div>` : ''}
      </div>
      <div class="kam-doc-summary">
        <table class="kam-doc-totals">
          <tr><td class="lbl">Sub Total</td><td class="val">₹ ${fmtN(totals.taxable_amount)}</td></tr>
          ${taxRows}
          <tr><td class="lbl">Round Off</td><td class="val">₹ ${fmtN(totals.round_off_amount)}</td></tr>
          <tr class="grand"><td class="lbl">Total</td><td class="val">₹ ${fmtN(totals.total_amount)}</td></tr>
        </table>
        <div class="kam-doc-sign">Authorized Signature</div>
      </div>
    </div>
    <table class="kam-doc-after-total"><tr>
      <td class="kam-doc-bank">
        ${!isPO ? `<div class="kam-doc-section-title">Banking Details</div>
        <div class="kam-doc-bank-row">Bank Name: <b>${esc(bankDetails.bank_name) || '—'}</b></div>
        <div class="kam-doc-bank-row">A/c No.: <b>${esc(bankDetails.bank_account_no) || '—'}</b></div>
        <div class="kam-doc-bank-row">IFSC: <b>${esc(bankDetails.bank_ifsc) || '—'}</b></div>
        ${bankDetails.bank_branch ? `<div class="kam-doc-bank-row">Branch: <b>${esc(bankDetails.bank_branch)}</b></div>` : ''}` : ''}
      </td>
      <td class="kam-doc-terms">
        <div class="kam-doc-section-title">Terms &amp; Conditions</div>
        <div class="kam-doc-terms-text">${sellerEntity.terms_and_conditions ? esc(sellerEntity.terms_and_conditions).replace(/\n/g, '<br>') : '—'}</div>
      </td>
    </tr></table>`
  }

  function pageHTML(chunk, num, isLast, startSl) {
    const rowsHTML = chunk.map((l, i) => rowHTML(l, startSl + i)).join('')
    return `<div class="kam-doc-page">
      ${num === 1 ? fullHeaderHTML() : continuationHeaderHTML()}
      <table class="kam-doc-items">
        <thead><tr>
          <th class="c-sl">#</th><th class="c-desc">Item &amp; Description</th>
          <th class="c-hsn">HSN/SAC</th><th class="c-qty">Qty</th><th class="c-unit">Unit</th>
          <th class="c-rate">Rate</th><th class="c-gstp">GST %</th><th class="c-gsta">GST Amt</th><th class="c-amt">Amount</th>
        </tr></thead>
        <tbody>${rowsHTML}${!isLast ? `<tr class="kam-doc-pagenote-row"><td colspan="9">Continued on next page — Page ${num} of ${totalPages}</td></tr>` : ''}</tbody>
      </table>
      ${isLast ? finalBlockHTML() : ''}
      <div class="kam-doc-pageno">${num} / ${totalPages}</div>
    </div>`
  }

  let sl = 1
  return pages.map((chunk, i) => {
    const html = pageHTML(chunk, i + 1, i === pages.length - 1, sl)
    sl += chunk.length
    return html
  }).join('')
}

export function getKamakhyaDocumentStyles(theme) {
  const navy = theme?.navy || '#0b2b6b'
  return `
* , *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: A4; margin: 10mm; }
body { background: #eef1f4; font-family: Arial, Helvetica, sans-serif; font-size: 8.2pt; line-height: 1.18; color: #111827; }
.kam-doc-page { width: 190mm; min-height: 277mm; margin: 0 auto 8mm; background: #fff; border: .45px solid #9ca3af; position: relative; overflow: hidden; page-break-after: always; }
.kam-doc-page:last-child { page-break-after: avoid; margin-bottom: 0; }
@media print { body { background: #fff; } .kam-doc-page { margin: 0 auto; box-shadow: none; } }
table.kam-doc-header, table.kam-doc-meta, table.kam-doc-party, table.kam-doc-items, table.kam-doc-totals, table.kam-doc-cont-head, table.kam-doc-after-total { width: 100%; border-collapse: collapse; table-layout: fixed; }
.kam-doc-header td { vertical-align: middle; border-bottom: .45px solid #a9adb1; height: 28mm; }
.kam-doc-logo-cell { width: 16%; text-align: center; padding: 2mm; }
.kam-doc-logo-cell img { max-width: 25mm; max-height: 20mm; }
.kam-doc-logo-ph { color: #666; font-size: 7pt; }
.kam-doc-company-cell { width: 50%; padding: 2.7mm 1.5mm 2mm; }
.kam-doc-company-name { font-size: 11.5pt; font-weight: 700; margin-bottom: 1mm; color: ${navy}; }
.kam-doc-company-cell div { line-height: 1.2; overflow-wrap: anywhere; }
.kam-doc-title-cell { width: 34%; font-size: 17pt; text-align: center; vertical-align: bottom !important; padding: 0 2.5mm 2.2mm; font-weight: 700; color: ${navy}; overflow-wrap: anywhere; }
.kam-doc-meta td { height: 10mm; vertical-align: top; padding: 1.1mm 1.3mm; border-bottom: .45px solid #a9adb1; }
.kam-doc-meta td:first-child { width: 50%; border-right: .45px solid #a9adb1; }
.kam-doc-meta-line { display: table; width: 100%; margin: 0 0 .7mm; }
.kam-doc-meta-line:last-child { margin-bottom: 0; }
.kam-doc-meta-key, .kam-doc-meta-val { display: table-cell; vertical-align: top; }
.kam-doc-meta-key { width: 40%; font-size: 7.4pt; color: #475569; }
.kam-doc-meta-val { font-weight: 700; font-size: 7.8pt; overflow-wrap: anywhere; }
.kam-doc-party td { width: 50%; height: 31mm; vertical-align: top; padding: 0; border-bottom: .45px solid #a9adb1; }
.kam-doc-party td:first-child { border-right: .45px solid #a9adb1; }
.kam-doc-party-head { background: #f1f1f1; font-weight: 700; padding: .7mm 1.2mm; border-bottom: .45px solid #b6b9bc; font-size: 7.8pt; color: ${navy}; }
.kam-doc-party-body { padding: 1.2mm 1.4mm; line-height: 1.25; overflow-wrap: anywhere; }
.kam-doc-party-body b { font-size: 8.9pt; }
.kam-doc-cont-head td { height: 12mm; border-bottom: .45px solid #a9adb1; padding: 1.2mm 1.5mm; }
.kam-doc-cont-brand { font-weight: 700; font-size: 10pt; color: ${navy}; }
.kam-doc-cont-meta { text-align: right; font-size: 7.8pt; }
table.kam-doc-items th, table.kam-doc-items td { border-right: .45px solid #a9adb1; border-bottom: .45px solid #a9adb1; padding: .75mm .8mm; vertical-align: top; line-height: 1.16; }
table.kam-doc-items th:last-child, table.kam-doc-items td:last-child { border-right: 0; }
table.kam-doc-items th { background: #f1f1f1; text-align: center; font-size: 7.5pt; font-weight: 700; padding: .65mm .5mm; }
table.kam-doc-items tbody tr { page-break-inside: avoid; }
.c-sl { width: 5%; text-align: center; } .c-desc { width: 25%; } .c-hsn { width: 10%; text-align: center; }
.c-qty { width: 9%; text-align: right; } .c-unit { width: 7%; text-align: center; } .c-rate { width: 10%; text-align: right; }
.c-gstp { width: 8%; text-align: center; } .c-gsta { width: 11%; text-align: right; } .c-amt { width: 15%; text-align: right; }
.kam-doc-desc-main { font-weight: 700; overflow-wrap: anywhere; }
.kam-doc-pagenote-row td { text-align: center; font-size: 9px; color: #6b7280; font-style: italic; padding: 2mm 0; }
.kam-doc-final { display: table; width: 100%; table-layout: fixed; border-collapse: collapse; }
.kam-doc-notes { display: table-cell; width: 56%; vertical-align: top; padding: 1.4mm 1.5mm; border-bottom: .45px solid #a9adb1; }
.kam-doc-summary { display: table-cell; width: 44%; vertical-align: top; border-left: .45px solid #a9adb1; border-bottom: .45px solid #a9adb1; }
.kam-doc-words-title, .kam-doc-note-title { font-size: 7.5pt; margin-bottom: .55mm; color: #475569; }
.kam-doc-words { font-weight: 700; font-style: italic; font-size: 8.8pt; line-height: 1.18; margin-bottom: 2.8mm; }
.kam-doc-note-title { margin-top: 1mm; }
.kam-doc-note-line { margin-top: .6mm; }
.kam-doc-dispatch { display: flex; flex-wrap: wrap; gap: 1mm 6mm; margin: 1.5mm 0; font-size: 7.2pt; background: #f9fafb; border: .45px solid #a9adb1; border-radius: 2px; padding: 1mm 1.2mm; }
.kam-doc-dispatch-row { display: flex; gap: 1.5mm; }
.kam-doc-dispatch-row b { text-transform: uppercase; font-size: 6.8pt; color: #374151; letter-spacing: .3px; }
table.kam-doc-totals td { padding: .9mm 1.8mm; }
table.kam-doc-totals .lbl { text-align: right; color: #475569; }
table.kam-doc-totals .val { text-align: right; width: 38%; }
table.kam-doc-totals tr.grand td { border-top: .45px solid #b4b6b8; font-weight: 700; font-size: 8.8pt; color: ${navy}; }
.kam-doc-sign { height: 16mm; text-align: center; vertical-align: bottom; padding-bottom: 1mm; font-weight: 600; display: flex; align-items: flex-end; justify-content: center; }
.kam-doc-after-total td { vertical-align: top; padding: 1.5mm; border-right: .45px solid #a9adb1; border-bottom: .45px solid #a9adb1; font-size: 7.5pt; line-height: 1.25; }
.kam-doc-after-total td:last-child { border-right: 0; }
.kam-doc-bank { width: 42%; } .kam-doc-terms { width: 58%; }
.kam-doc-section-title { font-weight: 700; margin-bottom: .8mm; color: ${navy}; }
.kam-doc-bank-row { margin: .45mm 0; }
.kam-doc-terms-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.kam-doc-pageno { position: absolute; right: 1.5mm; bottom: 1.2mm; color: #666; font-size: 7.2pt; }
`
}
