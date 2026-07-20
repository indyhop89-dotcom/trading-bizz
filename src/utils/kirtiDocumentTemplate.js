/**
 * Kirti Sales and Services document template — replicated from the
 * standalone "Kirti Sales Tally Proforma Invoice Generator" HTML tool, which
 * itself mimics the stock Tally ERP sales-voucher print layout (the format
 * anyone who has printed an invoice from Tally recognizes on sight: dense
 * bordered grid header, item table with subtotal/tax rows baked into the
 * table body, black-on-white throughout).
 *
 * Genuinely different structure from both other families, not a recolor:
 *  - No color accents at all — pure black borders/text on white, because
 *    that's what a real Tally-generated document looks like. `theme.navy`/
 *    `theme.orange` are both '#000000' in entityDocumentThemes.js purely to
 *    satisfy the cross-entity uniqueness check; this module ignores them.
 *  - Fixed-mm (not px) box model transcribed field-for-field from Tally's
 *    own voucher layout: a 61.6/38.4 split header (company+party block left,
 *    a 2-column x 7-row meta grid right), most meta cells are Tally's
 *    standard voucher fields (Delivery Note, Reference No & Date, Other
 *    References, Buyer's Order No, Dispatch Doc No, Delivery Note Date) that
 *    this app doesn't track and are intentionally always left blank — same
 *    as the reference tool — purely for visual authenticity.
 *  - Subtotal / per-rate CGST+SGST (or IGST) / round-off / grand-total rows
 *    live inside the item table itself (tfoot-style), not a separate totals
 *    box below it.
 *  - A dynamic blank spacer row pads the table so the total row always sits
 *    at the true bottom of the page, exactly like Tally's own renderer.
 */
import { fmtDate } from './dates'
import { esc, fmtN, numWords } from './documentHelpers'
import { GST_STATES } from '../constants/states'

// Pagination: documentHelpers.js's paginateLines() defaults (12 rows first
// page, 18 rows after) are tuned for the vananam family's roomier layout —
// using them here left each page of this dense, small-font Tally-style
// table barely a third full before forcing a break (a real multi-hundred-
// line PI was landing 50+ pages, almost all blank space). This template
// gets its own height-based packer instead, same approach as
// srplDocumentTemplate.js's paginateSRPLLines: estimate each row's real
// rendered height (via canvas.measureText, so word-wrap is measured, not
// guessed from character count) and greedily fill each page to what it
// actually holds.
//
// Fixed overhead, verified against the live-rendered page rather than pure
// CSS arithmetic (real browser layout — grid row min-heights, border-box
// rounding, font metrics — measured noticeably taller than the naive box
// model: real title+top+table-head ran to 85mm, not the 76mm the CSS
// values alone suggested, and every non-final page rendered 8-10mm taller
// than intended as a result). Values below include a small safety margin
// on top of those live measurements — this repeats identically on every
// page (unlike some other families, this template always re-renders the
// full company/party/meta header on continuation pages too, matching
// Tally's own voucher printout).
const TALLY_PAGE_MM = 297
const TALLY_HEADER_MM = 86
const TALLY_CONTINUED_RESERVE_MM = 16 // "Continued on next page" row plus rounding/line-height slack — measured 11-16mm in practice, well past the CSS's nominal 1.8mm
const TALLY_DESC_COLUMN_WIDTH_MM = 190 * 0.55 - 1.3 // desc column is 55% of the 190mm table, minus .65mm cell padding each side
const TALLY_ROW_PADDING_MM = 2.2      // 1.5mm top + .7mm bottom cell padding
const TALLY_ROW_LINE_HEIGHT_MM = 4.0  // 8.4pt font * 1.35 line-height
const TALLY_SUB_LINE_RESERVE_MM = 0.2 // .tally-desc-sub margin-top
const MM_PER_PX = 25.4 / 96

let _tallyMeasureCtx = null
function measureTallyTextWidthPx(text) {
  if (typeof document === 'undefined') return String(text).length * 5.5 // non-browser fallback, shouldn't normally be hit
  if (!_tallyMeasureCtx) _tallyMeasureCtx = document.createElement('canvas').getContext('2d')
  _tallyMeasureCtx.font = '11.2px Arial' // 8.4pt at 96dpi
  return _tallyMeasureCtx.measureText(text).width
}

function countTallyWrappedLines(text, maxWidthPx) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  let lines = 1
  let lineWidthPx = 0
  const spaceWidthPx = measureTallyTextWidthPx(' ')
  for (const word of words) {
    const wordWidthPx = measureTallyTextWidthPx(word)
    const candidateWidthPx = lineWidthPx === 0 ? wordWidthPx : lineWidthPx + spaceWidthPx + wordWidthPx
    if (candidateWidthPx > maxWidthPx && lineWidthPx > 0) { lines++; lineWidthPx = wordWidthPx }
    else lineWidthPx = candidateWidthPx
  }
  return lines
}

// Same main/sub description split rowHTML() uses below (kept as one shared
// helper so pagination measures exactly what actually gets rendered).
function splitTallyDescription(description) {
  const parts = String(description || '').split(/\n|\s+-\s+/)
  const main = parts.shift() || ''
  return { main, sub: parts.join(' - ') }
}

function estimateTallyRowHeightMm(description) {
  const { main, sub } = splitTallyDescription(description)
  const maxWidthPx = TALLY_DESC_COLUMN_WIDTH_MM / MM_PER_PX
  let h = TALLY_ROW_PADDING_MM + countTallyWrappedLines(main, maxWidthPx) * TALLY_ROW_LINE_HEIGHT_MM
  if (sub) h += TALLY_SUB_LINE_RESERVE_MM + countTallyWrappedLines(sub, maxWidthPx) * TALLY_ROW_LINE_HEIGHT_MM
  return h
}

// Height (mm) the in-table footer rows (gap + subtotal + per-rate tax lines
// + round-off + grand-total row) take, excluding the spacer row itself —
// the spacer is what absorbs whatever's left, not a fixed cost. Includes a
// small safety margin per row (live-measured slightly taller than the CSS
// box model alone suggested, same rounding/line-height slack as
// TALLY_CONTINUED_RESERVE_MM above).
function withinTableFooterMm(taxLineCount) {
  return 3 + 5 + taxLineCount * 5 + 5 + 6
}

// Fixed content below the items table on the true last page: the "Amount
// Chargeable (in words)" box (~8mm) + PAN/declaration/bank/signature block
// (23.5mm, fixed height) + "Computer Generated" footer line (~3mm) = ~34.5mm
// baseline, plus a safety margin, plus the GST computation table (grows
// with distinct HSN count) and the optional dispatch-info / entity Terms &
// Conditions blocks — same class of estimate as
// srplDocumentTemplate.js's estimateSRPLFooterReserveMm.
function estimateTallyFooterReserveMm(lines, dispatchInfo, termsText) {
  const base = 44
  const distinctHSNCount = new Set(lines.map(l => l.hsn_code || '—')).size
  const gstCompMm = 5.5 + (distinctHSNCount + 1) * 3.2 + 5.5
  const dispatchCount = dispatchInfo ? Object.values(dispatchInfo).filter(Boolean).length : 0
  const dispatchMm = dispatchCount ? 2 + Math.ceil(dispatchCount / 2) * 4 : 0
  const termsLines = termsText ? Math.max(1, Math.ceil(String(termsText).length / 100)) : 0
  const termsMm = termsText ? 2 + termsLines * 3.8 : 0
  return base + gstCompMm + dispatchMm + termsMm
}

// Determines the true last page FIRST, working backward from the end, then
// fills everything before it forward against the larger regularBudget.
//
// An earlier version tried "greedily fill every page to regularBudget, then
// shrink whatever page lands last to fit the footer" — real failure mode:
// whenever the natural remainder happened to land close to a FULL
// regularBudget page, shrinking it peeled a big chunk into a new trailing
// page, leaving the second-to-last page badly under-filled (large blank
// gap). A follow-up lookahead version ("does everything remaining fit on
// one last page? if not, fill this page to regularBudget and keep going")
// still had the same hole: if that regularBudget fill happened to consume
// every remaining line, the resulting page became the true last page
// without ever being checked against the smaller lastBudget — verified
// live in the browser to silently overflow a page by ~90mm (footer content
// pushed well past the physical page onto what would print as a second
// sheet). Building the last page from the end backward guarantees it is
// always sized against lastBudget, full stop.
function paginateTallyLines(lines, footerReserveMm) {
  const regularBudget = TALLY_PAGE_MM - TALLY_HEADER_MM - TALLY_CONTINUED_RESERVE_MM
  const lastBudget = TALLY_PAGE_MM - TALLY_HEADER_MM - footerReserveMm

  if (!lines.length) return [[]]

  const heights = lines.map(l => estimateTallyRowHeightMm(l.description))

  // Largest trailing run of lines whose total height fits within
  // lastBudget — always at least 1 line, even if that one row alone
  // exceeds lastBudget (can't show zero lines on the last page).
  let lastPageStart = lines.length - 1
  let lastHeight = heights[lastPageStart]
  while (lastPageStart > 0 && lastHeight + heights[lastPageStart - 1] <= lastBudget) {
    lastPageStart--
    lastHeight += heights[lastPageStart]
  }

  // Everything before the last page is spread across BALANCED boundaries,
  // not greedily packed to regularBudget one page at a time — greedy
  // packing (even against a slightly lower shared cap) still dumps
  // whatever's left over onto the final regular page right before the true
  // last page, and that leftover can land anywhere from "nearly full" down
  // to "just a couple of rows on an otherwise blank page" purely by how the
  // running total happened to divide against the cap. Instead: figure out
  // the minimum number of regular pages this content needs, then place
  // each page boundary at the cumulative-height point closest to its even
  // share (1/N, 2/N, ... of the total) — every regular page ends up close
  // to the same height instead of one arbitrarily short one.
  const pages = []
  // Nothing precedes the last page at all (a short document that fits
  // entirely within lastBudget on its own) — skip the balancing below
  // entirely, or it would still emit an empty leading page.
  if (lastPageStart > 0) {
    const totalHeightBeforeLast = heights.slice(0, lastPageStart).reduce((s, h) => s + h, 0)
    const numRegularPages = Math.max(1, Math.ceil(totalHeightBeforeLast / regularBudget))
    const targetPerPage = totalHeightBeforeLast / numRegularPages

    const cumulative = new Array(lastPageStart + 1).fill(0)
    for (let k = 0; k < lastPageStart; k++) cumulative[k + 1] = cumulative[k] + heights[k]

    let start = 0
    for (let pageNum = 1; pageNum < numRegularPages; pageNum++) {
      const targetCumulative = pageNum * targetPerPage
      let end = start
      while (end < lastPageStart && cumulative[end + 1] <= targetCumulative) end++
      end = Math.max(end, start + 1) // always at least 1 row per page
      pages.push(lines.slice(start, end))
      start = end
    }
    pages.push(lines.slice(start, lastPageStart))
  }
  pages.push(lines.slice(lastPageStart))

  return pages
}

const KIRTI_META = {
  PI:      { title: 'PROFORMA INVOICE', numberLabel: 'PI No.' },
  PO:      { title: 'PURCHASE ORDER',   numberLabel: 'PO No.' },
  INVOICE: { title: 'TAX INVOICE',      numberLabel: 'Invoice No.' },
}

function stateCodeFromGSTIN(gstin) {
  const m = String(gstin || '').match(/^\d{2}/)
  return m ? m[0] : ''
}

function stateCodeForEntity(entity) {
  const fromGstin = stateCodeFromGSTIN(entity?.gstin)
  if (fromGstin) return fromGstin
  const found = GST_STATES.find(s => s.name.toLowerCase() === String(entity?.state_name || '').toLowerCase())
  return found ? found.code : ''
}

function partyBlockHTML(entity) {
  const addr = [entity?.address, [entity?.city, entity?.state_name, entity?.pincode].filter(Boolean).join(', ')].filter(Boolean)
  const stateCode = stateCodeForEntity(entity)
  return `<div class="tally-name">${esc(entity?.name)}</div>` +
    addr.map(l => `<div>${esc(l)}</div>`).join('') +
    (entity?.gstin ? `<div>GSTIN/UIN : ${esc(entity.gstin)}</div>` : '') +
    (entity?.state_name || stateCode ? `<div>State Name : ${esc(entity?.state_name || '')}${stateCode ? `, Code : ${esc(stateCode)}` : ''}</div>` : '')
}

export function buildKirtiDocumentHTML(doc) {
  const {
    docType, docNo, docDate,
    paymentTerms, deliveryTimeline, modeOfTransport = 'Road',
    sellerEntity = {}, buyerEntity = {}, shipTo,
    lines = [], totals = {}, interstate = false,
    bankDetails = {}, ewayBill, dispatchInfo,
  } = doc
  const meta = KIRTI_META[docType] || KIRTI_META.PI
  const isPO = docType === 'PO'
  // Same reversed-roles convention as the other two families' PO handling —
  // sellerEntity is the issuing buyer, buyerEntity is the vendor being
  // ordered from, and goods ship to the issuer's own address by default.
  const ship = shipTo || (isPO ? sellerEntity : buyerEntity)
  const counterpartyLabel = isPO ? 'Supplier (Bill From)' : 'Buyer (Bill to)'

  function metaGridHTML() {
    const numberValue = docType === 'INVOICE' && ewayBill?.eway_bill_no
      ? `${esc(docNo)} &nbsp;&nbsp; ${esc(ewayBill.eway_bill_no)}`
      : esc(docNo)
    const numberLabel = docType === 'INVOICE'
      ? `${meta.numberLabel} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; e-Way Bill No.`
      : meta.numberLabel
    return `<div class="tally-meta">
      <div class="tally-meta-cell"><div class="tally-meta-label">${numberLabel}</div><div class="tally-meta-value">${numberValue}</div></div>
      <div class="tally-meta-cell"><div class="tally-meta-label">Dated</div><div class="tally-meta-value">${fmtDate(docDate)}</div></div>
      <div class="tally-meta-cell"><div class="tally-meta-label">Delivery Note</div><div class="tally-meta-value"></div></div>
      <div class="tally-meta-cell"><div class="tally-meta-label">Mode/Terms of Payment</div><div class="tally-meta-value">${esc(paymentTerms || '')}</div></div>
      <div class="tally-meta-cell"><div class="tally-meta-label">Reference No. &amp; Date.</div></div><div class="tally-meta-cell"><div class="tally-meta-label">Other References</div></div>
      <div class="tally-meta-cell"><div class="tally-meta-label">Buyer's Order No.</div></div><div class="tally-meta-cell"><div class="tally-meta-label">Dated</div></div>
      <div class="tally-meta-cell"><div class="tally-meta-label">Dispatch Doc No.</div></div><div class="tally-meta-cell"><div class="tally-meta-label">Delivery Note Date</div></div>
      <div class="tally-meta-cell"><div class="tally-meta-label">Dispatched through</div><div class="tally-meta-value">${esc(modeOfTransport)}</div></div><div class="tally-meta-cell"><div class="tally-meta-label">Destination</div><div class="tally-meta-value">${esc(ship?.city)}</div></div>
      <div class="tally-meta-cell wide"><div class="tally-meta-label">Terms of Delivery</div><div class="tally-meta-value">${esc(deliveryTimeline || '')}</div></div>
    </div>`
  }

  function rowHTML(l, sl) {
    const { main, sub } = splitTallyDescription(l.description)
    return `<tr class="item-row">
      <td class="sl">${sl}</td>
      <td class="desc"><div class="tally-desc-main">${esc(main)}</div>${sub ? `<div class="tally-desc-sub">${esc(sub)}</div>` : ''}</td>
      <td class="hsn">${esc(l.hsn_code) || '—'}</td>
      <td class="qty"><b>${fmtN(l.qty)}</b> ${esc(l.unit) || 'Nos'}</td>
      <td class="rate">${fmtN(l.rate)}</td>
      <td class="per">${esc(l.unit) || 'Nos'}</td>
      <td class="amount"><b>${fmtN(l.taxable_amount)}</b></td>
    </tr>`
  }

  // GST computation table + per-rate tax rows inside the item table — both
  // grouped the same way Tally itself groups them (by HSN for the
  // computation table, by rate for the in-table CGST/SGST rows).
  const gstByHSN = new Map()
  const gstByRate = new Map()
  for (const l of lines) {
    const hKey = l.hsn_code || '—'
    if (!gstByHSN.has(hKey)) gstByHSN.set(hKey, { taxable: 0, cgst: 0, sgst: 0, igst: 0, rate: Number(l.gst_rate) || 0 })
    const h = gstByHSN.get(hKey)
    h.taxable += Number(l.taxable_amount) || 0
    h.cgst += Number(l.cgst_amount) || 0
    h.sgst += Number(l.sgst_amount) || 0
    h.igst += Number(l.igst_amount) || 0

    const rKey = String(Number(l.gst_rate) || 0)
    if (!gstByRate.has(rKey)) gstByRate.set(rKey, { rate: Number(l.gst_rate) || 0, cgst: 0, sgst: 0, igst: 0 })
    const r = gstByRate.get(rKey)
    r.cgst += Number(l.cgst_amount) || 0
    r.sgst += Number(l.sgst_amount) || 0
    r.igst += Number(l.igst_amount) || 0
  }
  const taxLineCount = gstByRate.size * (interstate ? 1 : 2) + 1

  // Computed only now (not right after destructuring `doc`, above) because
  // the true last page's row budget depends on taxLineCount/distinct-HSN
  // count, both derived from the grouping just above.
  const footerReserveMm = withinTableFooterMm(taxLineCount) + estimateTallyFooterReserveMm(lines, dispatchInfo, sellerEntity.terms_and_conditions)
  const pages = paginateTallyLines(lines, footerReserveMm)
  const totalPages = pages.length

  function taxLinesHTML() {
    return [...gstByRate.values()].sort((a, b) => a.rate - b.rate).map(g => interstate
      ? `<tr class="tally-tax-line"><td></td><td class="desc" style="text-align:right">IGST OUTPUT @ ${fmtN(g.rate)}%</td><td></td><td></td><td class="rate">${fmtN(g.rate)}</td><td class="per">%</td><td class="amount">${fmtN(g.igst)}</td></tr>`
      : `<tr class="tally-tax-line"><td></td><td class="desc" style="text-align:right">CGST OUTPUT @ ${fmtN(g.rate / 2)}%</td><td></td><td></td><td class="rate">${fmtN(g.rate / 2)}</td><td class="per">%</td><td class="amount">${fmtN(g.cgst)}</td></tr><tr class="tally-tax-line"><td></td><td class="desc" style="text-align:right">SGST OUTPUT @ ${fmtN(g.rate / 2)}%</td><td></td><td></td><td class="rate">${fmtN(g.rate / 2)}</td><td class="per">%</td><td class="amount">${fmtN(g.sgst)}</td></tr>`
    ).join('')
  }

  function gstCompTableHTML() {
    const rows = [...gstByHSN.entries()].map(([hsn, g]) => interstate
      ? `<tr><td class="left">${esc(hsn)}</td><td>${fmtN(g.taxable)}</td><td>${fmtN(g.rate)}%</td><td>${fmtN(g.igst)}</td><td>${fmtN(g.igst)}</td></tr>`
      : `<tr><td class="left">${esc(hsn)}</td><td>${fmtN(g.taxable)}</td><td>${fmtN(g.rate / 2)}%</td><td>${fmtN(g.cgst)}</td><td>${fmtN(g.rate / 2)}%</td><td>${fmtN(g.sgst)}</td><td>${fmtN(g.cgst + g.sgst)}</td></tr>`
    ).join('')
    const taxTotal = interstate ? (Number(totals.igst_amount) || 0) : (Number(totals.cgst_amount) || 0) + (Number(totals.sgst_amount) || 0)
    const totalRow = interstate
      ? `<tr class="total"><td class="left">Total</td><td>${fmtN(totals.taxable_amount)}</td><td></td><td>${fmtN(totals.igst_amount)}</td><td>${fmtN(taxTotal)}</td></tr>`
      : `<tr class="total"><td class="left">Total</td><td>${fmtN(totals.taxable_amount)}</td><td></td><td>${fmtN(totals.cgst_amount)}</td><td></td><td>${fmtN(totals.sgst_amount)}</td><td>${fmtN(taxTotal)}</td></tr>`
    const head = interstate
      ? `<tr><th rowspan="2" class="left">HSN/SAC</th><th rowspan="2">Taxable<br>Value</th><th colspan="2">Integrated Tax</th><th rowspan="2">Total<br>Tax Amount</th></tr><tr><th>Rate</th><th>Amount</th></tr>`
      : `<tr><th rowspan="2" class="left">HSN/SAC</th><th rowspan="2">Taxable<br>Value</th><th colspan="2">CGST</th><th colspan="2">SGST/UTGST</th><th rowspan="2">Total<br>Tax Amount</th></tr><tr><th>Rate</th><th>Amount</th><th>Rate</th><th>Amount</th></tr>`
    return `<table class="tally-tax"><thead>${head}</thead><tbody>${rows}${totalRow}</tbody></table>
    <div class="tally-taxwords">Tax Amount (in words) : &nbsp; <b>${numWords(taxTotal)}</b></div>`
  }

  function bottomHTML() {
    const showBank = docType !== 'PO'
    return `<div class="tally-bottom">
      <div class="tally-decl">
        ${sellerEntity.pan ? `<div class="tally-pan">Company's PAN &nbsp;&nbsp;&nbsp;&nbsp;: <b>${esc(sellerEntity.pan)}</b></div>` : ''}
        <div class="tally-decl-title">Declaration</div>
        <div>We declare that this ${esc(meta.title.toLowerCase())} shows the actual price of the goods described and that all particulars are true and correct.</div>
      </div>
      <div class="tally-bank">
        ${showBank ? `<div style="text-align:center">Company's Bank Details</div>
        <div>Bank Name &nbsp;&nbsp;&nbsp;: <b>${esc(bankDetails.bank_name) || '—'}</b></div>
        <div>A/c No. &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: <b>${esc(bankDetails.bank_account_no) || '—'}</b></div>
        <div>Branch &amp; IFS Code: <b>${esc([bankDetails.bank_branch, bankDetails.bank_ifsc].filter(Boolean).join(' & ')) || '—'}</b></div>` : ''}
        <div class="tally-sign-company">for ${esc(sellerEntity.name || '')}</div>
        <div class="tally-sign-space"></div>
        <div class="tally-sign">Authorised Signatory</div>
      </div>
    </div>`
  }

  // Free-text overrides captured per-document (dispatch location can differ
  // from the seller's registered address) — rendered only on the last page,
  // alongside the rest of the footer.
  function dispatchInfoHTML() {
    if (!dispatchInfo) return ''
    const { billFrom, billTo, shipFrom, shipTo: shipToNote } = dispatchInfo
    const rows = [
      ['Bill From', billFrom], ['Bill To', billTo],
      ['Ship From', shipFrom], ['Ship To', shipToNote],
    ].filter(([, v]) => v)
    if (!rows.length) return ''
    return `<div class="tally-dispatch">
      ${rows.map(([label, value]) => `<div class="tally-dispatch-row"><span class="tally-dispatch-lbl">${esc(label)}</span><span class="tally-dispatch-val">${esc(value)}</span></div>`).join('')}
    </div>`
  }

  // Entity-level Terms & Conditions (Settings > Entities) — same free text
  // on every PI/PO/Tax Invoice this entity issues, all families. Rendered
  // only when the entity has one configured.
  function termsHTML() {
    if (!sellerEntity.terms_and_conditions) return ''
    return `<div class="tally-terms"><b>Terms &amp; Conditions</b><div>${esc(sellerEntity.terms_and_conditions).replace(/\n/g, '<br>')}</div></div>`
  }

  function footerHTML(chunk, qtyTotal) {
    // Same footerReserveMm the pagination above used to decide how many rows
    // could land on this (the true last) page — so this is exactly the
    // leftover height once real item rows + the fixed footer are accounted
    // for, never negative by construction.
    const itemsHeightMm = chunk.reduce((s, l) => s + estimateTallyRowHeightMm(l.description), 0)
    const spacerMm = Math.max(10, TALLY_PAGE_MM - TALLY_HEADER_MM - itemsHeightMm - footerReserveMm)
    return `
      <tr class="tally-gap-row"><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
      <tr class="tally-subtotal-line"><td></td><td></td><td></td><td></td><td></td><td></td><td class="amount">${fmtN(totals.taxable_amount)}</td></tr>
      ${taxLinesHTML()}
      <tr class="tally-tax-line"><td></td><td class="desc" style="text-align:right">Round Off</td><td></td><td></td><td></td><td></td><td class="amount">${fmtN(totals.round_off_amount)}</td></tr>
      <tr class="tally-spacer" style="--spacer-height:${spacerMm}mm"><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
    </tbody><tfoot><tr class="tally-total-row"><td></td><td style="text-align:right">Total</td><td></td><td class="qty">${fmtN(qtyTotal)} nos</td><td></td><td></td><td class="amount">₹ ${fmtN(totals.total_amount)}</td></tr></tfoot>`
  }

  function pageHTML(chunk, num, isLast, startSl) {
    const rowsHTML = chunk.map((l, i) => rowHTML(l, startSl + i)).join('')
    const qtyTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)
    return `<div class="po-page"><div class="tally-page">
      <div class="tally-title">${esc(meta.title)}${totalPages > 1 ? '' : ' <span class="tally-copy">(ORIGINAL FOR RECIPIENT)</span>'}</div>
      <div class="tally-top"><div class="tally-left">
        <div class="tally-company${sellerEntity.logoSrc ? ' has-logo' : ''}">${sellerEntity.logoSrc ? `<img class="tally-seller-logo" src="${sellerEntity.logoSrc}" alt="${esc(sellerEntity.name)}">` : ''}${partyBlockHTML(sellerEntity)}</div>
        <div class="tally-party ship"><div class="tally-label">Consignee (Ship to)</div>${partyBlockHTML(ship)}</div>
        <div class="tally-party"><div class="tally-label">${esc(counterpartyLabel)}</div>${partyBlockHTML(buyerEntity)}</div>
      </div>${metaGridHTML()}</div>
      <table class="tally-items"><thead><tr><th class="sl">Sl<br>No.</th><th class="desc">Description of Goods</th><th class="hsn">HSN/SAC</th><th class="qty">Quantity</th><th class="rate">Rate</th><th class="per">per</th><th class="amount">Amount</th></tr></thead>
      <tbody>${rowsHTML}${!isLast ? `<tr class="tally-gap-row"><td colspan="7" style="text-align:center;font-style:italic;padding:2mm 0">Continued on next page — Page ${num} of ${totalPages}</td></tr>` : ''}${isLast ? footerHTML(chunk, qtyTotal) : '</tbody>'}</table>
      ${isLast ? `
      <div class="tally-words"><div class="tally-words-label">Amount Chargeable (in words)</div><div class="tally-words-value">${numWords(totals.total_amount)}</div><span class="tally-eoe">E. &amp; O.E</span></div>
      ${gstCompTableHTML()}
      ${dispatchInfoHTML()}
      ${termsHTML()}
      ${bottomHTML()}
      <div class="tally-footer">This is a Computer Generated ${esc(meta.title)}</div>` : ''}
    </div></div>`
  }

  let sl = 1
  return pages.map((chunk, i) => {
    const html = pageHTML(chunk, i + 1, i === pages.length - 1, sl)
    sl += chunk.length
    return html
  }).join('')
}

export function getKirtiDocumentStyles() {
  // No `theme` parameter used — the reference Tally layout is intentionally
  // monochrome (see module docstring), unlike the vananam/srpl families.
  return `
* , *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: A4; margin: 0; }
body { background: #f0f1f8; font-family: Arial, Helvetica, sans-serif; font-size: 8.8pt; color: #000; }
.po-page { width: 794px; min-height: 1123px; margin: 0 auto 32px; background: #fff; display: flex; flex-direction: column; page-break-after: always; }
.po-page:last-child { page-break-after: avoid; margin-bottom: 0; }
@media print { body { background: #fff; } .po-page { margin: 0; box-shadow: none; } }
.tally-page{ width:190mm; margin:0 auto; background:#fff; color:#000; font-family:Arial,Helvetica,sans-serif; font-size:8.8pt; line-height:1.08; padding:6mm 10mm; box-sizing:border-box; flex: 1; }
.tally-page *{box-sizing:border-box}
.tally-page table{width:100%;table-layout:fixed}
.tally-title{position:relative;text-align:center;font-size:10pt;font-weight:700;height:5mm;padding:.8mm 0 0;line-height:1;border:0}
.tally-copy{position:absolute;right:1mm;top:.8mm;font-size:7.2pt;font-style:italic;font-weight:400}
.tally-top{display:grid;grid-template-columns:61.6% 38.4%;border:0.75pt solid #000;align-items:stretch}
.tally-left{border-right:0.75pt solid #000;min-height:64.5mm}
.tally-company,.tally-party{padding:.55mm 1mm;line-height:1.08}
.tally-company{position:relative;border-bottom:0.75pt solid #000;min-height:17mm}
.tally-company.has-logo{padding-left:27mm}
.tally-seller-logo{position:absolute;left:1mm;top:1mm;width:24mm;height:14.5mm;object-fit:contain;background:#fff}
.tally-party.ship{min-height:19.5mm}
.tally-party:not(.ship){min-height:28mm}
.tally-party.ship{border-bottom:0.75pt solid #000}
.tally-name{font-weight:700;font-size:9.2pt;line-height:1.04}
.tally-label{font-size:8pt;margin-bottom:.2mm}
.tally-meta{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat(6,7.4mm) minmax(20.1mm,1fr);min-height:64.5mm}
.tally-meta-cell{border-bottom:0.75pt solid #000;border-right:0.75pt solid #000;padding:.45mm .8mm;line-height:1.05;overflow:hidden}
.tally-meta-cell:nth-child(2n){border-right:0}
.tally-meta-cell.wide{grid-column:1/3;border-right:0;border-bottom:0}
.tally-meta-label{font-size:7.5pt}
.tally-meta-value{font-weight:700;font-size:8.2pt;line-height:1;margin-top:.1mm;white-space:nowrap}
.tally-items{border-collapse:collapse;border-left:0.75pt solid #000;border-right:0.75pt solid #000}
.tally-items th,.tally-items td{border-right:0.75pt solid #000;padding:.3mm .65mm;vertical-align:top;line-height:1.04;font-size:8.4pt}
.tally-items th:last-child,.tally-items td:last-child{border-right:0}
.tally-items thead th{height:6.5mm;border-bottom:0.75pt solid #000;text-align:center;font-weight:400;font-size:7.6pt;vertical-align:middle;padding:.2mm .35mm}
.tally-items .sl{width:2.2%;text-align:center}.tally-items .desc{width:55%}.tally-items .hsn{width:7%;text-align:center}.tally-items .qty{width:9%;text-align:right;white-space:nowrap}.tally-items .rate{width:9%;text-align:right}.tally-items .per{width:3.4%;text-align:center}.tally-items .amount{width:14.4%;text-align:right;white-space:nowrap}
.tally-items tbody tr.item-row td{height:auto!important;padding-top:1.5mm;padding-bottom:.7mm;line-height:1.35}
.tally-desc-main{font-weight:700}.tally-desc-sub{font-style:italic;margin-left:2mm;margin-top:.2mm}
.tally-gap-row td{height:1.8mm!important;padding:0!important}
.tally-subtotal-line td{height:4mm!important;padding-top:.45mm;padding-bottom:.25mm;vertical-align:middle;font-weight:400;font-style:normal}
.tally-subtotal-line .amount{border-top:0.75pt solid #000;font-weight:400}
.tally-tax-line td{height:4mm!important;font-weight:700;font-style:italic;padding-top:.35mm;padding-bottom:.2mm;vertical-align:middle}
.tally-tax-line .amount{font-style:normal}
.tally-spacer td{padding:0!important;height:var(--spacer-height,80mm)!important}
.tally-total-row td{height:5mm;border-top:0.75pt solid #000;border-bottom:0.75pt solid #000;font-weight:700;vertical-align:middle;padding:.3mm .7mm}
.tally-words{border:0.75pt solid #000;border-top:0;padding:.45mm 1mm;position:relative;min-height:8mm}
.tally-words-label{font-size:6.7pt}.tally-words-value{font-weight:700;font-size:8.4pt;margin-top:.2mm}.tally-eoe{position:absolute;right:1mm;top:.45mm;font-style:italic;font-size:7pt}
.tally-tax{border-collapse:collapse;border-left:0.75pt solid #000;border-right:0.75pt solid #000;border-bottom:0.75pt solid #000;font-size:7.15pt}
.tally-tax th,.tally-tax td{border-right:0.75pt solid #000;border-top:0.75pt solid #000;padding:.12mm .45mm;text-align:right;line-height:1}.tally-tax th:last-child,.tally-tax td:last-child{border-right:0}.tally-tax .left{text-align:left}.tally-tax .total{font-weight:700}
.tally-taxwords{border:0.75pt solid #000;border-top:0;padding:.5mm 1mm;font-size:7.1pt;min-height:5.5mm}.tally-taxwords b{font-size:8pt}
.tally-dispatch{display:flex;flex-wrap:wrap;gap:.8mm 5mm;padding:1mm;font-size:7.2pt;border:0.75pt solid #000;border-top:0;background:#f9fafb}
.tally-dispatch-row{display:flex;gap:1.2mm}
.tally-dispatch-lbl{font-weight:700;text-transform:uppercase;font-size:6.8pt;color:#374151}
.tally-terms{padding:1mm;font-size:7.2pt;border:0.75pt solid #000;border-top:0;line-height:1.5}
.tally-terms b{text-transform:uppercase;font-size:6.8pt;letter-spacing:.3px;display:block;margin-bottom:.5mm}
.tally-bottom{display:grid;grid-template-columns:58% 42%;border:0.75pt solid #000;border-top:0;height:23.5mm;overflow:hidden}
.tally-decl{border-right:0.75pt solid #000;padding:.55mm 1mm;position:relative}.tally-bank{padding:.4mm 1mm;position:relative}.tally-pan{margin-bottom:1mm}.tally-decl-title{text-decoration:underline}.tally-sign-company{text-align:right;font-weight:700;margin-top:.4mm}.tally-sign-space{height:5mm}.tally-sign{text-align:right}
.tally-footer{text-align:center;font-size:6.5pt;padding-top:.6mm}
`
}
