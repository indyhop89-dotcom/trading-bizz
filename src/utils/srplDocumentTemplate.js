/**
 * SRPL (Siddhidhatri Retail Private Limited / "Siddhi") document template —
 * one precise box model shared by PI, PO, and Tax Invoice, transcribed from
 * two real reference sources: a dedicated standalone PO generator tool
 * (exact mm-unit box model) and a real Tax Invoice PDF (SR/26-27/007). PI
 * shares the same structure as the other two — no separate reference for it
 * yet, so it follows the Invoice layout minus the Invoice-only fields noted
 * below.
 *
 * Two differences from the reference sources by design, to stay consistent
 * with how every other template in this app handles per-entity assets: the
 * company logo comes from the issuing entity's `logoSrc` (uploaded
 * per-entity elsewhere in the app, not a hardcoded base64 image), and the
 * signature panel is left blank for physical signing rather than embedding
 * a specific person's signature image baked into source code.
 *
 * Genuinely different structure from documentTemplate.js's "vananam"
 * family, not a recolor of it:
 *  - Single accent color (navy) plus neutral black for borders/emphasis —
 *    no second "orange" accent color at all.
 *  - Bordered, understated table style instead of solid color-filled
 *    header bars.
 *  - PO uniquely repeats the issuer's own name under a "Bill To" label at
 *    the very top, IN ADDITION to the "Supplier (Bill From)" / "Ship To"
 *    pair below it — three address mentions, not two.
 *  - One combined "GST Amount" column per line (no per-line CGST/SGST
 *    split) — CGST/SGST are only broken out in the totals block and the
 *    HSN-wise summary table.
 *  - A single, full-width black "TOTAL AMOUNT" bar instead of a bordered
 *    totals box.
 *  - "E. & O.E", bank details, and the HSN-wise GST summary table appear on
 *    PI/Invoice only, not PO. Eway Bill No/Vehicle No appear on Invoice only.
 *
 * Pagination: the header block (title/top/party-grid/GSTIN row) repeats on
 * every page and uses fixed mm heights sized generously against real
 * addresses — `min-height` + no `overflow:hidden`, not `height`, so a
 * longer-than-expected address grows the box instead of silently clipping
 * off the GSTIN/state line (see kirtiDocumentTemplate.js's history for why
 * that matters — it's a compliance-data-loss bug, not just cosmetic). The
 * items table is never itself flex-grown (that stretches row heights, not
 * the page — the bug this file's previous version had); instead a plain
 * empty `.srpl-doc-spacer` flex-grows to push the footer to the true bottom
 * of the page on short documents.
 */
import { fmtDate } from './dates'
import { esc, fmtN, numWords, addressLines } from './documentHelpers'

const SRPL_META = {
  PI:      { title: 'Proforma Invoice', numberLabel: 'PI Number' },
  PO:      { title: 'Purchase Order',   numberLabel: 'PO Number' },
  INVOICE: { title: 'Tax Invoice',      numberLabel: 'Invoice No' },
}

function rowHTML(l, sl) {
  return `<tr>
    <td class="tc">${sl}</td>
    <td>${esc(l.description).replace(/\n/g, '<br>')}</td>
    <td class="tc">${esc(l.hsn_code) || '—'}</td>
    <td class="tc">${l.qty} ${esc(l.unit) || 'Nos'}</td>
    <td class="tr">${fmtN(l.rate)}</td>
    <td class="tc">${l.gst_rate}%</td>
    <td class="tr">${fmtN(l.taxable_amount)}</td>
    <td class="tr">${fmtN((Number(l.cgst_amount) || 0) + (Number(l.sgst_amount) || 0) + (Number(l.igst_amount) || 0))}</td>
  </tr>`
}

// Per-line height estimate + dynamic per-page bucketing (mm), replacing an
// earlier flat row-count cap. SRPL's rows vary a lot in height (1 vs.
// multiple wrapped description lines) — a flat cap either overflows the
// page (too generous) or leaves a lot of a page's real estate unused (safe
// enough not to overflow on the worst-case row, wasteful on any page whose
// rows happen to be mostly short). This packs each page to what its actual
// content needs instead.
//
// Fixed overhead, measured directly against the rendered page: title 14mm
// + top 51mm + party-grid 30mm + GSTIN row 5mm + table head 5mm = 105mm
// header, repeated on every page. A "regular" (non-last) page only
// additionally reserves room for the small "Continued on next page" note
// (~7mm); the true LAST page instead needs room for the full footer
// (totals/HSN summary/bank/signature/footer bar) — reserved per-document
// below since its height depends on doc type and, for an Invoice, how many
// distinct HSN codes are on it.
const SRPL_PAGE_MM = 281
const SRPL_HEADER_MM = 105
const SRPL_PAGENOTE_RESERVE_MM = 7
// Description column is ~20% of 194mm minus 2×1mm cell padding ≈ 36.8mm.
const SRPL_DESC_COLUMN_WIDTH_MM = 36.8
const SRPL_ROW_PADDING_MM = 2   // 1mm top + 1mm bottom cell padding
const SRPL_ROW_LINE_HEIGHT_MM = 3.75 // measured per wrapped text line at this font/line-height
const MM_PER_PX = 25.4 / 96

// A flat characters-per-line estimate undercounted badly: word-wrap doesn't
// scale linearly with character count (long/short words break at different
// points), and an early version of this using that approach still
// overflowed real pages by ~9mm at high row counts. Since this module only
// ever runs client-side (this whole app is a browser SPA — there's no
// server-rendering path), canvas.measureText() is available and gives the
// real rendered width of each word at this exact font, which is what
// actually determines where the browser wraps the line — far more accurate
// than guessing from character count.
let _srplMeasureCtx = null
function measureSRPLTextWidthPx(text) {
  if (typeof document === 'undefined') return String(text).length * 5.5 // non-browser fallback, shouldn't normally be hit
  if (!_srplMeasureCtx) _srplMeasureCtx = document.createElement('canvas').getContext('2d')
  _srplMeasureCtx.font = '9.87px Arial' // 7.4pt at 96dpi
  return _srplMeasureCtx.measureText(text).width
}

function countWrappedLines(text, maxWidthPx) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  let lines = 1
  let lineWidthPx = 0
  const spaceWidthPx = measureSRPLTextWidthPx(' ')
  for (const word of words) {
    const wordWidthPx = measureSRPLTextWidthPx(word)
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

function estimateSRPLRowHeightMm(description) {
  const maxWidthPx = SRPL_DESC_COLUMN_WIDTH_MM / MM_PER_PX
  const wrappedLines = countWrappedLines(description, maxWidthPx)
  return SRPL_ROW_PADDING_MM + wrappedLines * SRPL_ROW_LINE_HEIGHT_MM
}

// Measured against rendered footers: ~68mm base (TOTAL row + words/PAN box
// + totals grid + grand total + signature block + footer bar, including
// bank details when shown) + ~14mm fixed table-head/total-row overhead and
// ~5mm per distinct HSN code for the Invoice-only HSN summary table, + ~5mm
// per populated Bill/Ship From/To row when dispatchInfo is set, + a rough
// ~4mm per wrapped line of the entity's Terms & Conditions text (full page
// width at this font, ~95 chars/line — same class of estimate as the row
// height heuristic above, not pixel-exact).
function estimateSRPLFooterReserveMm(lines, isInvoice, dispatchInfo, termsText) {
  const dispatchRows = dispatchInfo ? Object.values(dispatchInfo).filter(Boolean).length : 0
  const termsLines = termsText ? Math.max(1, Math.ceil(String(termsText).length / 95)) : 0
  const base = 68 + dispatchRows * 5 + (termsText ? 6 + termsLines * 4 : 0)
  if (!isInvoice) return base
  const distinctHSNCount = new Set(lines.map(l => l.hsn_code || '—')).size
  return base + 14 + distinctHSNCount * 5
}

function paginateSRPLLines(lines, footerReserveMm) {
  const regularBudget = SRPL_PAGE_MM - SRPL_HEADER_MM - SRPL_PAGENOTE_RESERVE_MM
  const lastBudget = SRPL_PAGE_MM - SRPL_HEADER_MM - footerReserveMm

  const pages = []
  let current = []
  let currentHeight = 0
  for (const l of lines) {
    const h = estimateSRPLRowHeightMm(l.description)
    if (current.length && currentHeight + h > regularBudget) {
      pages.push(current)
      current = []
      currentHeight = 0
    }
    current.push(l)
    currentHeight += h
  }
  pages.push(current) // always at least one page, even for zero lines

  // The footer only ever lands on the true last page — if that page (as
  // greedily filled above, which only reserved pagenote-sized headroom) is
  // too full to also fit the footer, peel rows off its end into a new
  // trailing page until it fits.
  const last = pages[pages.length - 1]
  let lastHeight = last.reduce((s, l) => s + estimateSRPLRowHeightMm(l.description), 0)
  const overflow = []
  while (lastHeight > lastBudget && last.length > 1) {
    const moved = last.pop()
    overflow.unshift(moved)
    lastHeight -= estimateSRPLRowHeightMm(moved)
  }
  if (overflow.length) pages.push(overflow)

  return pages
}

// HSN-wise GST summary table — Invoice only, matching the equivalent table
// in documentTemplate.js's vananam family (per product request: "add HSN
// wise summary like we have in VRVPL invoice"). Grouped by HSN code, same
// as vananam's version, adapted to SRPL's bordered style.
function hsnSummaryHTML(lines, totals, interstate) {
  const groups = new Map()
  for (const l of lines) {
    const key = l.hsn_code || '—'
    if (!groups.has(key)) groups.set(key, { hsn: key, rate: Number(l.gst_rate) || 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 })
    const g = groups.get(key)
    g.taxable += Number(l.taxable_amount) || 0
    g.cgst += Number(l.cgst_amount) || 0
    g.sgst += Number(l.sgst_amount) || 0
    g.igst += Number(l.igst_amount) || 0
  }
  const rows = [...groups.values()].map(g => interstate
    ? `<tr><td class="left">${esc(g.hsn)}</td><td>${fmtN(g.taxable)}</td><td>${g.rate}%</td><td>${fmtN(g.igst)}</td><td>${fmtN(g.igst)}</td></tr>`
    : `<tr><td class="left">${esc(g.hsn)}</td><td>${fmtN(g.taxable)}</td><td>${g.rate / 2}%</td><td>${fmtN(g.cgst)}</td><td>${g.rate / 2}%</td><td>${fmtN(g.sgst)}</td><td>${fmtN(g.cgst + g.sgst)}</td></tr>`
  ).join('')
  const totalTax = interstate ? (Number(totals.igst_amount) || 0) : (Number(totals.cgst_amount) || 0) + (Number(totals.sgst_amount) || 0)
  const totalRow = interstate
    ? `<tr class="total"><td class="left">Total</td><td>${fmtN(totals.taxable_amount)}</td><td></td><td>${fmtN(totals.igst_amount)}</td><td>${fmtN(totalTax)}</td></tr>`
    : `<tr class="total"><td class="left">Total</td><td>${fmtN(totals.taxable_amount)}</td><td></td><td>${fmtN(totals.cgst_amount)}</td><td></td><td>${fmtN(totals.sgst_amount)}</td><td>${fmtN(totalTax)}</td></tr>`
  const head = interstate
    ? `<tr><th rowspan="2" class="left">HSN/SAC</th><th rowspan="2">Taxable<br>Value</th><th colspan="2">Integrated Tax</th><th rowspan="2">Total<br>Tax Amount</th></tr><tr><th>Rate</th><th>Amount</th></tr>`
    : `<tr><th rowspan="2" class="left">HSN/SAC</th><th rowspan="2">Taxable<br>Value</th><th colspan="2">Central Tax</th><th colspan="2">State Tax</th><th rowspan="2">Total<br>Tax Amount</th></tr><tr><th>Rate</th><th>Amount</th><th>Rate</th><th>Amount</th></tr>`
  return `<div class="srpl-doc-hsn-wrap">
    <div class="srpl-doc-hsn-head">HSN Wise Summary</div>
    <table class="srpl-doc-hsn-table"><thead>${head}</thead><tbody>${rows}${totalRow}</tbody></table>
  </div>`
}

export function buildSRPLDocumentHTML(doc) {
  const {
    docType, docNo, docDate, paymentTerms, deliveryTimeline,
    sellerEntity = {}, buyerEntity = {}, shipTo,
    lines = [], totals = {}, interstate = false,
    bankDetails = {}, ewayBill, dispatchInfo,
  } = doc
  const meta = SRPL_META[docType] || SRPL_META.PI
  const isPO = docType === 'PO'
  const isInvoice = docType === 'INVOICE'
  // Same reversed-roles convention used everywhere else in this app for
  // POs: sellerEntity is the issuer (SRPL itself — the buyer, for a PO),
  // buyerEntity is the counterparty (the vendor being ordered from, for a
  // PO; the customer, for PI/Invoice). Ship To defaults to the issuer's own
  // address for a PO (goods ship to the buyer), to the counterparty for
  // PI/Invoice.
  const ship = shipTo || (isPO ? sellerEntity : buyerEntity)
  const counterpartyLabel = isPO ? 'Supplier (Bill From)' : 'BILL TO'
  // Each doc type keeps its own reference's exact label casing — the PO
  // generator tool used title case ("Ship To"), the real Tax Invoice PDF
  // used caps ("SHIP TO").
  const shipLabel = isPO ? 'Ship To' : 'SHIP TO'

  const pages = paginateSRPLLines(lines, estimateSRPLFooterReserveMm(lines, isInvoice, dispatchInfo, sellerEntity.terms_and_conditions))
  const totalPages = pages.length

  function metaRowsHTML() {
    if (isInvoice) {
      return `
        <div class="srpl-doc-meta-row"><b>Invoice No</b><span>${esc(docNo)}</span></div>
        <div class="srpl-doc-meta-row"><b>Invoice Date</b><span>${fmtDate(docDate)}</span></div>
        <div class="srpl-doc-meta-row"><b>Eway Bill No</b><span>${esc(ewayBill?.eway_bill_no) || ''}</span></div>
        <div class="srpl-doc-meta-row"><b>Vehicle No</b><span>${esc(ewayBill?.vehicle_no) || ''}</span></div>`
    }
    const rows = [
      [meta.numberLabel, esc(docNo)],
      [isPO ? 'PO Date' : 'PI Date', fmtDate(docDate)],
      ['Terms of delivery', esc(deliveryTimeline) || ''],
    ]
    if (isPO) rows.push(['Terms of Payment', esc(paymentTerms) || ''])
    return rows.map(([l, v]) => `<div class="srpl-doc-meta-row"><b>${l}</b><span>${v}</span></div>`).join('')
  }

  // Free-text overrides captured per-document (dispatch location can differ
  // from the seller's registered address) — rendered only on the last page
  // (alongside the rest of the footer) rather than in the repeating header,
  // so it doesn't need its own reserved slice of the per-page row budget
  // (see paginateSRPLLines above — that budget is tuned tightly against the
  // fixed header's real measured height).
  function dispatchInfoHTML() {
    if (!dispatchInfo) return ''
    const { billFrom, billTo, shipFrom, shipTo: shipToNote } = dispatchInfo
    const rows = [
      ['Bill From', billFrom], ['Bill To', billTo],
      ['Ship From', shipFrom], ['Ship To', shipToNote],
    ].filter(([, v]) => v)
    if (!rows.length) return ''
    return `<div class="srpl-doc-dispatch">
      ${rows.map(([label, value]) => `<div class="srpl-doc-dispatch-row"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('')}
    </div>`
  }

  // Entity-level Terms & Conditions (Settings > Entities) — same free text
  // on every PI/PO/Tax Invoice this entity issues, all families. Rendered
  // only when the entity has one configured.
  function termsHTML() {
    if (!sellerEntity.terms_and_conditions) return ''
    return `<div class="srpl-doc-terms"><b>Terms &amp; Conditions</b><div>${esc(sellerEntity.terms_and_conditions).replace(/\n/g, '<br>')}</div></div>`
  }

  function footerHTML() {
    const qtyTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)
    const gstTotalRows = interstate
      ? `<div class="srpl-doc-totals-row"><b>IGST</b><span>Rs. ${fmtN(totals.igst_amount)}</span></div>`
      : `<div class="srpl-doc-totals-row"><b>CGST</b><span>Rs. ${fmtN(totals.cgst_amount)}</span></div><div class="srpl-doc-totals-row"><b>SGST</b><span>Rs. ${fmtN(totals.sgst_amount)}</span></div>`
    return `
      <table class="srpl-doc-totalrow-table">
        <colgroup><col class="sl"><col class="desc"><col class="hsn"><col class="qty"><col class="rate"><col class="gst"><col class="taxable"><col class="gstamt"></colgroup>
        <tbody><tr><td colspan="3">TOTAL</td><td>${fmtN(qtyTotal).replace('.00', '')}</td><td></td><td></td><td>${fmtN(totals.taxable_amount)}</td><td>${fmtN((Number(totals.cgst_amount) || 0) + (Number(totals.sgst_amount) || 0) + (Number(totals.igst_amount) || 0))}</td></tr></tbody>
      </table>
      ${dispatchInfoHTML()}
      ${termsHTML()}
      <div class="srpl-doc-bottom">
        <div class="srpl-doc-words-box">
          Amount (in words) : ${numWords(totals.total_amount)}<br>
          Company's PAN : ${esc(sellerEntity.pan) || '—'}
          ${!isPO ? '<div class="srpl-doc-eoe">E. &amp; O.E</div>' : ''}
        </div>
        <div class="srpl-doc-totals-grid">
          <div class="srpl-doc-totals-row"><b>TAXABLE AMOUNT</b><span>Rs. ${fmtN(totals.taxable_amount)}</span></div>
          ${gstTotalRows}
          <div class="srpl-doc-totals-row"><b>ROUND OFF</b><span>Rs. ${fmtN(totals.round_off_amount)}</span></div>
        </div>
      </div>
      <div class="srpl-doc-grand"><b>TOTAL AMOUNT</b><span>Rs. ${fmtN(totals.total_amount)}</span></div>
      ${isInvoice ? hsnSummaryHTML(lines, totals, interstate) : ''}
      <div class="srpl-doc-sign">
        <div class="srpl-doc-bank">${!isPO ? `<b>Company's Bank Details</b><br>
          Bank Name : ${esc(bankDetails.bank_name) || '—'}<br>
          A/c No. : ${esc(bankDetails.bank_account_no) || '—'}<br>
          Branch &amp; IFS Code : ${esc(bankDetails.bank_branch) || '—'}${bankDetails.bank_ifsc ? ' &amp; ' + esc(bankDetails.bank_ifsc) : ''}` : ''}</div>
        <div class="srpl-doc-signature-panel">
          <div class="srpl-doc-signature-image"></div>
          <div class="srpl-doc-sign-company">${esc(sellerEntity.name)}</div>
          <div class="srpl-doc-sign-label">Authorized Sign.</div>
        </div>
      </div>
      <div class="srpl-doc-footer">This is computer generated no signature required</div>`
  }

  function pageHTML(chunk, num, isLast, startSl) {
    const rowsHTML = chunk.map((l, i) => rowHTML(l, startSl + i)).join('')
    return `<div class="srpl-doc-page">
      <div class="srpl-doc-title">${esc(meta.title)}</div>
      <div class="srpl-doc-top">
        <div class="srpl-doc-bill">
          ${isPO ? '<div class="kicker">Bill To</div>' : ''}
          <div class="company">${esc(sellerEntity.name)}</div>
          <div class="address">${addressLines(sellerEntity)}</div>
          <div class="gst">GST : ${esc(sellerEntity.gstin) || '—'}</div>
        </div>
        <div class="srpl-doc-brand">
          <div class="srpl-doc-logo">${sellerEntity.logoSrc ? `<img src="${sellerEntity.logoSrc}" alt="${esc(sellerEntity.name)}">` : ''}</div>
          <div class="srpl-doc-meta">${metaRowsHTML()}</div>
        </div>
      </div>
      <div class="srpl-doc-party-grid">
        <div class="srpl-doc-party-box">
          <div class="srpl-doc-party-head">${counterpartyLabel}</div>
          <div class="srpl-doc-party-body"><b>${esc(buyerEntity.name)}</b><br>${addressLines(buyerEntity)}</div>
        </div>
        <div class="srpl-doc-party-box">
          <div class="srpl-doc-party-head">${shipLabel}</div>
          <div class="srpl-doc-party-body"><b>${esc(ship.name)}</b><br>${addressLines(ship)}</div>
        </div>
      </div>
      <div class="srpl-doc-supplier-gst">GSTIN : ${esc(buyerEntity.gstin) || '—'}</div>
      <table class="srpl-doc-items">
        <colgroup><col class="sl"><col class="desc"><col class="hsn"><col class="qty"><col class="rate"><col class="gst"><col class="taxable"><col class="gstamt"></colgroup>
        <thead><tr><th>SL. NO.</th><th>DESCRIPTION</th><th>HSN NO.</th><th>QTY in Nos</th><th>Rate/Nos</th><th>GST%</th><th>Taxable Amount</th><th>GST Amount</th></tr></thead>
        <tbody>${rowsHTML}</tbody>
      </table>
      ${!isLast ? `<div class="srpl-doc-pagenote">Continued on next page — Page ${num} of ${totalPages}</div>` : `<div class="srpl-doc-spacer"></div>${footerHTML()}`}
    </div>`
  }

  let sl = 1
  return pages.map((chunk, i) => {
    const html = pageHTML(chunk, i + 1, i === pages.length - 1, sl)
    sl += chunk.length
    return html
  }).join('')
}

export function getSRPLDocumentStyles() {
  // No `theme` parameter used — this layout's colors (navy header text,
  // black borders/bars) are fixed, transcribed directly from the real
  // reference PDF rather than themed per entity.
  return `
* , *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: A4; margin: 8mm; }
body { background: #f0f1f8; font-family: Arial, Helvetica, sans-serif; font-size: 8.25pt; color: #08265f; }
/* 194mm wide — sized to fit inside an 8mm page margin on an A4 sheet
   (210x297mm), matching the reference generator tool. Only the LAST page
   (the one with a footer to pin to the bottom) is forced to the full
   281mm — a continuation page has no footer, so forcing it to full height
   too just left a large bordered-but-empty box below its last item row on
   every page but the last. A continuation page now sizes to its own
   content and ends there; the physical printed sheet still fills to A4 via
   page-break-after, it just does so as blank margin instead of a rendered
   border box. min-height (not a fixed height) on the last page + flex-column
   lets it still grow if content genuinely needs more room (e.g. many HSN
   groups in the summary table) instead of clipping it. */
.srpl-doc-page{width:194mm;margin:0 auto 32px;background:#fff;border:1.2pt solid #000;display:flex;flex-direction:column;overflow:hidden;page-break-after:always}
.srpl-doc-page:last-child{min-height:281mm;page-break-after:avoid;margin-bottom:0}
@media print{body{background:#fff}.srpl-doc-page{margin:0}}
/* Pushes the footer to the true bottom of the last page WITHOUT stretching
   the items table's own rows — the bug an earlier version of this file had
   (table.srpl-items{flex:1} stretched every row to fill the page). Only
   ever rendered on the last page (see pageHTML above). */
.srpl-doc-spacer{flex:1}
.srpl-doc-title{min-height:14mm;text-align:center;font-size:23pt;font-weight:700;line-height:14mm;color:#0b2b6b}
.srpl-doc-top{min-height:51mm;display:grid;grid-template-columns:58% 42%;border-bottom:1pt solid #000;align-items:stretch}
.srpl-doc-bill{padding:1.5mm 1.2mm}.srpl-doc-bill .kicker{font-size:9pt;margin-bottom:1.2mm}.srpl-doc-bill .company{font-size:17pt;line-height:1.1;margin-bottom:2.2mm}.srpl-doc-bill .address{font-size:7.4pt;line-height:1.55}.srpl-doc-bill .gst{font-size:7.4pt;font-weight:700;margin-top:2.2mm}
.srpl-doc-brand{display:flex;flex-direction:column;justify-content:space-between}.srpl-doc-logo{min-height:29mm;display:flex;align-items:center;justify-content:center;padding:1mm}.srpl-doc-logo img{max-height:24mm;max-width:95%}
/* border-left scoped to just the meta box (PI/PO/Invoice Number, Date,
   etc.), not the whole .srpl-doc-brand column — putting it on the column
   ran the line through the logo box above too, which is empty for most
   entities (no uploaded logo), so it looked like a stray vertical line
   running through blank space with nothing on either side of it. */
.srpl-doc-meta{border-top:1pt solid #000;border-left:1pt solid #000}.srpl-doc-meta-row{display:grid;grid-template-columns:48% 52%;min-height:5.2mm;border-bottom:.8pt solid #000}.srpl-doc-meta-row:last-child{border-bottom:none}.srpl-doc-meta-row b,.srpl-doc-meta-row span{padding:.8mm 1mm;line-height:1.2}.srpl-doc-meta-row b{border-right:.8pt solid #000}
.srpl-doc-party-grid{min-height:30mm;display:grid;grid-template-columns:1fr 1fr;border-bottom:1pt solid #000;align-items:stretch}.srpl-doc-party-box:first-child{border-right:1pt solid #000}.srpl-doc-party-head{min-height:5mm;border-bottom:.8pt solid #000;font-weight:700;padding:.8mm 1mm}.srpl-doc-party-body{padding:1mm;font-size:7.4pt;line-height:1.45}.srpl-doc-party-body b{font-size:7.7pt}
.srpl-doc-supplier-gst{min-height:5mm;border-bottom:1pt solid #000;padding:.8mm 1mm;font-weight:700}
table.srpl-doc-items,table.srpl-doc-totalrow-table{width:100%;border-collapse:collapse;table-layout:fixed}
/* Closes off the table's column lines cleanly on every page (not just the
   last, which already gets a closing border from the TOTAL row right after
   it) — otherwise the vertical borders just stop dead after the last row,
   which reads as a broken/unfinished table on a continuation page. */
table.srpl-doc-items{border-bottom:1pt solid #000}
table.srpl-doc-items th,table.srpl-doc-items td,table.srpl-doc-totalrow-table td{border-right:1pt solid #000}
table.srpl-doc-items th:last-child,table.srpl-doc-items td:last-child,table.srpl-doc-totalrow-table td:last-child{border-right:none}
table.srpl-doc-items thead th{height:5mm;border-bottom:1pt solid #000;border-top:1pt solid #000;text-align:center;font-size:7.2pt;padding:.6mm;font-weight:400}
table.srpl-doc-items tbody td{text-align:center;padding:1mm;vertical-align:top;font-size:7.4pt}
table.srpl-doc-items .desc,table.srpl-doc-totalrow-table .desc{text-align:left}
table.srpl-doc-totalrow-table td{height:5mm;border-top:1pt solid #000;border-bottom:1pt solid #000;font-weight:700;padding:.7mm 1mm;font-size:7.4pt}
.srpl-doc-items col.sl,.srpl-doc-totalrow-table col.sl{width:8%}.srpl-doc-items col.desc,.srpl-doc-totalrow-table col.desc{width:20%}.srpl-doc-items col.hsn,.srpl-doc-totalrow-table col.hsn{width:13%}.srpl-doc-items col.qty,.srpl-doc-totalrow-table col.qty{width:11%}.srpl-doc-items col.rate,.srpl-doc-totalrow-table col.rate{width:11%}.srpl-doc-items col.gst,.srpl-doc-totalrow-table col.gst{width:9%}.srpl-doc-items col.taxable,.srpl-doc-totalrow-table col.taxable{width:16%}.srpl-doc-items col.gstamt,.srpl-doc-totalrow-table col.gstamt{width:12%}
.tr{text-align:right}.tc{text-align:center}
.srpl-doc-pagenote{text-align:center;font-size:9px;color:#6b7280;padding:8px;border-top:1pt solid #000}
.srpl-doc-dispatch{display:flex;flex-wrap:wrap;gap:1mm 6mm;padding:1.5mm 1mm;font-size:7.2pt;background:#f9fafb;border-top:1pt solid #000}
.srpl-doc-dispatch-row{display:flex;gap:1.5mm}
.srpl-doc-dispatch-row b{color:#374151;text-transform:uppercase;font-size:6.8pt;letter-spacing:.3px}
.srpl-doc-terms{padding:1.5mm 1mm;font-size:7.2pt;border-top:1pt solid #000;line-height:1.5}
.srpl-doc-terms b{text-transform:uppercase;font-size:6.8pt;letter-spacing:.3px;display:block;margin-bottom:.6mm}
.srpl-doc-bottom{display:grid;grid-template-columns:36% 64%;border-top:1pt solid #000}
.srpl-doc-words-box{border-right:1pt solid #000;padding:1mm;font-size:7.2pt;font-weight:700;line-height:1.55}
.srpl-doc-eoe{font-weight:700;margin-top:2mm;font-style:italic}
.srpl-doc-totals-grid{display:flex;flex-direction:column}
.srpl-doc-totals-row{display:grid;grid-template-columns:45% 55%;border-bottom:.8pt solid #000}
.srpl-doc-totals-row:last-child{border-bottom:none}
.srpl-doc-totals-row b,.srpl-doc-totals-row span{padding:.8mm 1mm}
.srpl-doc-totals-row b{border-right:.8pt solid #000}
.srpl-doc-totals-row span{text-align:right;font-weight:700}
/* Bold navy text on a bordered white row, not a black background bar — a
   background-color bar only prints correctly when the print driver has
   "background graphics" enabled (many don't by default, especially office
   network printers), which silently turned this into unreadable grey-on-
   white in practice. Matches the blue used throughout the rest of the
   document (labels, PI/PO number box) instead of being the one black
   element on the page. border-top also closes off the totals-grid box
   above it, instead of that box's last row (ROUND OFF) just ending with no
   border beneath it. */
.srpl-doc-grand{min-height:6mm;display:grid;grid-template-columns:36% 64%;font-weight:700;border-top:1.2pt solid #000;color:#0b2b6b}
.srpl-doc-grand b{padding:1.1mm 1mm;font-size:9pt;border-right:.8pt solid #000}
.srpl-doc-grand span{padding:1.1mm 1mm;font-size:9pt;text-align:right}
.srpl-doc-hsn-wrap{border:1pt solid #000;border-top:none;font-size:7.15pt}
.srpl-doc-hsn-head{background:#f3f4f6;font-weight:700;padding:.8mm 1mm;border-bottom:1pt solid #000;color:#0b2b6b}
table.srpl-doc-hsn-table{width:100%;border-collapse:collapse}
table.srpl-doc-hsn-table th,table.srpl-doc-hsn-table td{border-right:.8pt solid #000;border-top:.8pt solid #000;padding:.5mm .8mm;text-align:right;line-height:1.2}
table.srpl-doc-hsn-table th:last-child,table.srpl-doc-hsn-table td:last-child{border-right:none}
table.srpl-doc-hsn-table .left{text-align:left}
table.srpl-doc-hsn-table tr.total td{font-weight:700;background:#f9fafb}
.srpl-doc-sign{display:grid;grid-template-columns:58% 42%;border-top:1pt solid #000;min-height:20mm}
.srpl-doc-bank{padding:1mm;font-size:7.2pt;line-height:1.6}
.srpl-doc-signature-panel{border-left:1pt solid #000;display:flex;flex-direction:column;justify-content:flex-end}
.srpl-doc-signature-image{min-height:14mm}
.srpl-doc-sign-company,.srpl-doc-sign-label{min-height:5mm;border-top:1pt solid #000;text-align:center;font-weight:700;padding:.8mm}
/* Same reasoning as .srpl-doc-grand above — a black background bar isn't
   reliable across print drivers. */
.srpl-doc-footer{min-height:5mm;border-top:1.2pt solid #000;color:#0b2b6b;text-align:center;font-weight:700;padding:.9mm;font-size:8pt}
`
}
