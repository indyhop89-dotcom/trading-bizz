/**
 * SRPL (Siddhidhatri Retail Private Limited / "Siddhi") document template —
 * replicated from three real reference PDFs (a Purchase Order, a Proforma
 * Invoice, and a Tax Invoice), not built from an interactive HTML tool like
 * VRVPL's was. Colors are a visual estimate from those PDFs (no exact hex
 * available from a flat PDF) — confirm against the real documents and
 * update entityDocumentThemes.js if they're off; everything else (layout,
 * field labels, column set) is transcribed directly from the PDFs' text.
 *
 * This is a genuinely different structure from documentTemplate.js's
 * "vananam" family, not a recolor of it:
 *  - Single accent color (navy) plus neutral black for emphasis bars —
 *    no second "orange" accent color at all.
 *  - Bordered, understated table style (white header rows with colored
 *    text) instead of solid color-filled header bars.
 *  - PO uniquely repeats the issuer's own name under a "Bill To" label at
 *    the very top, IN ADDITION to the "Supplier (Bill From)" / "Ship To"
 *    pair below it — three address mentions, not two.
 *  - One combined "GST Amount" column per line (no per-line CGST/SGST
 *    split) — CGST/SGST are only broken out in the totals block.
 *  - A single, full-width black "TOTAL AMOUNT" bar instead of a bordered
 *    totals box.
 *  - "E. & O.E" and bank details appear on PI/Invoice only, not PO.
 */
import { fmtDate } from './dates'
import { esc, fmtN, numWords, addressLines, paginateLines } from './documentHelpers'

// SRPL's own doc-type labels differ slightly from the generic DOC_META
// (e.g. "Invoice No" not "Invoice Number", "PI Number" not "PI No") and its
// meta-info box has a different row set per doc type entirely.
const SRPL_META = {
  PI:      { title: 'Proforma Invoice', numberLabel: 'PI Number' },
  PO:      { title: 'Purchase Order',   numberLabel: 'PO Number' },
  INVOICE: { title: 'Tax Invoice',      numberLabel: 'Invoice No' },
}

export function buildSRPLDocumentHTML(doc) {
  const {
    docType, docNo, docDate,
    paymentTerms, deliveryTimeline,
    sellerEntity = {}, buyerEntity = {}, shipTo,
    lines = [], totals = {}, interstate = false,
    bankDetails = {}, ewayBill,
  } = doc
  const meta = SRPL_META[docType] || SRPL_META.PI
  // Same reversed-roles handling as the vananam family's PO: sellerEntity
  // here is SRPL itself (the issuer — buyer, for a PO), buyerEntity is the
  // vendor being ordered from. Ship To defaults to SRPL's own address for a
  // PO (goods ship to the buyer), to the counterparty for PI/Invoice.
  const isPO = docType === 'PO'
  const ship = shipTo || (isPO ? sellerEntity : buyerEntity)
  const counterpartyLabel = isPO ? 'Supplier (Bill From)' : 'BILL TO'

  const pages = paginateLines(lines)
  const totalPages = pages.length

  function metaRowsHTML() {
    if (docType === 'INVOICE') {
      return `
        <tr><td class="ml">Invoice No</td><td class="mv">${esc(docNo)}</td></tr>
        <tr><td class="ml">Invoice Date</td><td class="mv">${fmtDate(docDate)}</td></tr>
        <tr><td class="ml">Eway Bill No</td><td class="mv">${esc(ewayBill?.eway_bill_no) || ''}</td></tr>
        <tr><td class="ml">Vehicle No</td><td class="mv">${esc(ewayBill?.vehicle_no) || ''}</td></tr>`
    }
    const rows = [
      [meta.numberLabel, esc(docNo)],
      [isPO ? 'PO Date' : 'PI Date', fmtDate(docDate)],
      ['Terms of delivery', esc(deliveryTimeline) || ''],
    ]
    if (isPO) rows.push(['Terms of Payment', esc(paymentTerms) || ''])
    return rows.map(([l, v]) => `<tr><td class="ml">${l}</td><td class="mv">${v}</td></tr>`).join('')
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

  function footerHTML() {
    const gstRows = interstate
      ? `<tr><td class="ftl">IGST</td><td class="ftv">${fmtN(totals.igst_amount)}</td></tr>`
      : `<tr><td class="ftl">CGST</td><td class="ftv">${fmtN(totals.cgst_amount)}</td></tr><tr><td class="ftl">SGST</td><td class="ftv">${fmtN(totals.sgst_amount)}</td></tr>`
    return `
      <div class="srpl-foot">
        <table class="srpl-fttable">
          <tr><td class="ftl">TAXABLE AMOUNT</td><td class="ftv">${fmtN(totals.taxable_amount)}</td></tr>
          ${gstRows}
          <tr><td class="ftl">ROUND OFF</td><td class="ftv">${fmtN(totals.round_off_amount)}</td></tr>
        </table>
      </div>
      <div class="srpl-totalbar"><span>TOTAL AMOUNT</span><span>Rs. ${fmtN(totals.total_amount)}</span></div>
      <div class="srpl-bottom">
        <div class="srpl-bottom-left">
          <div class="srpl-words"><b>Amount (in words) :</b> ${numWords(totals.total_amount)}</div>
          <div class="srpl-pan"><b>Company's PAN :</b> ${esc(sellerEntity.pan) || '—'}</div>
          ${docType !== 'PO' ? `
            <div class="srpl-eoe">E. &amp; O.E</div>
            <div class="srpl-bank">
              <b>Company's Bank Details</b><br>
              Bank Name : ${esc(bankDetails.bank_name) || '—'}<br>
              A/c No. : ${esc(bankDetails.bank_account_no) || '—'}<br>
              Branch &amp; IFS Code : ${esc(bankDetails.bank_branch) || '—'}${bankDetails.bank_ifsc ? ' &amp; ' + esc(bankDetails.bank_ifsc) : ''}
            </div>` : ''}
        </div>
        <div class="srpl-bottom-right">
          <div class="srpl-sigbox">
            <div class="srpl-sigspace"></div>
            <div class="srpl-signame">${esc(sellerEntity.name)}</div>
            <div class="srpl-sigsub">Authorized Sign.</div>
          </div>
        </div>
      </div>
      <div class="srpl-blackbar">This is computer generated no signature required</div>`
  }

  function pageHTML(chunk, num, isLast, startSl) {
    const rowsHTML = chunk.map((l, i) => rowHTML(l, startSl + i)).join('')
    return `<div class="srpl-page">
      <div class="srpl-grow">
        <div class="srpl-title">${esc(meta.title)}</div>
        <div class="srpl-header">
          <div class="srpl-header-left">
            ${isPO ? '<div class="srpl-billto-lbl">Bill To</div>' : ''}
            <div class="srpl-coname">${esc(sellerEntity.name)}</div>
            <div class="srpl-coaddr">${addressLines(sellerEntity)}</div>
            ${sellerEntity.gstin ? `<div class="srpl-cogst">GST : ${esc(sellerEntity.gstin)}</div>` : ''}
          </div>
          <div class="srpl-header-right">
            ${sellerEntity.logoSrc ? `<img class="srpl-logo" src="${sellerEntity.logoSrc}" alt="${esc(sellerEntity.name)}">` : ''}
            <table class="srpl-metabox">${metaRowsHTML()}</table>
          </div>
        </div>
        <div class="srpl-addrgrid">
          <div class="srpl-addrcol">
            <div class="srpl-addrhead">${counterpartyLabel}</div>
            <div class="srpl-addrname">${esc(buyerEntity.name)}</div>
            <div class="srpl-addrbody">${addressLines(buyerEntity)}</div>
          </div>
          <div class="srpl-addrcol">
            <div class="srpl-addrhead">SHIP TO</div>
            <div class="srpl-addrname">${esc(ship.name)}</div>
            <div class="srpl-addrbody">${addressLines(ship)}</div>
          </div>
        </div>
        ${buyerEntity.gstin ? `<div class="srpl-gstinrow">GSTIN : ${esc(buyerEntity.gstin)}</div>` : ''}
        <table class="srpl-items">
          <thead><tr>
            <th style="width:26px">SL. NO.</th><th>DESCRIPTION</th><th style="width:60px">HSN NO.</th>
            <th style="width:70px">QTY</th><th style="width:65px">Rate</th><th style="width:38px">GST%</th>
            <th style="width:85px">Taxable Amount</th><th style="width:85px">GST Amount</th>
          </tr></thead>
          <tbody>${rowsHTML}</tbody>
        </table>
        ${!isLast ? `<div class="srpl-pagenote">Continued on next page — Page ${num} of ${totalPages}</div>` : ''}
      </div>
      ${isLast ? footerHTML() : ''}
    </div>`
  }

  let sl = 1
  return pages.map((chunk, i) => {
    const html = pageHTML(chunk, i + 1, i === pages.length - 1, sl)
    sl += chunk.length
    return html
  }).join('')
}

export function getSRPLDocumentStyles(theme) {
  const { navy } = theme
  return `
* , *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: A4; margin: 0; }
body { background: #f0f1f8; font-family: Arial, sans-serif; font-size: 10px; color: #1a1a1a; }
/* Explicit A4 pixel dimensions (794x1123 @ 96dpi) + flex-column, same
   technique as documentTemplate.js's vananam family — without an explicit
   height, a short document (SRPL's own reference PDFs have as few as 1
   line item) collapses to its content's natural height instead of a full
   physical page. .srpl-grow absorbs the extra space so the totals/
   signature/black bar sit at the true bottom of the page, not bunched up
   under a half-empty items table. */
.srpl-page { background: #fff; width: 794px; min-height: 1123px; margin: 0 auto 32px; border: 1.5px solid #1a1a1a; display: flex; flex-direction: column; page-break-after: always; }
.srpl-page:last-child { page-break-after: avoid; margin-bottom: 0; }
.srpl-grow { flex: 1; display: flex; flex-direction: column; }
table.srpl-items { flex: 1; }
@media print {
  body { background: #fff; }
  .srpl-page { margin: 0; }
}
.srpl-title { text-align: center; font-size: 22px; font-weight: 700; color: ${navy}; padding: 14px 0 10px; }
.srpl-header { display: flex; justify-content: space-between; padding: 0 14px 10px; gap: 12px; }
.srpl-billto-lbl { font-size: 9px; color: #1a1a1a; margin-bottom: 2px; }
.srpl-coname { font-size: 16px; font-weight: 700; color: ${navy}; margin-bottom: 3px; }
.srpl-coaddr { font-size: 9px; color: #333; line-height: 1.6; max-width: 300px; }
.srpl-cogst { font-size: 9.5px; font-weight: 700; color: #1a1a1a; margin-top: 3px; }
.srpl-header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.srpl-logo { height: 40px; width: auto; }
.srpl-metabox { border-collapse: collapse; font-size: 9px; }
.srpl-metabox td { border: 1px solid #1a1a1a; padding: 3px 8px; }
.srpl-metabox .ml { font-weight: 700; color: ${navy}; white-space: nowrap; }
.srpl-metabox .mv { color: #1a1a1a; min-width: 90px; }
.srpl-addrgrid { display: grid; grid-template-columns: 1fr 1fr; border-top: 1.5px solid #1a1a1a; border-bottom: 1px solid #1a1a1a; }
.srpl-addrcol { padding: 6px 14px; font-size: 9px; }
.srpl-addrcol:first-child { border-right: 1px solid #1a1a1a; }
.srpl-addrhead { font-weight: 700; color: ${navy}; font-size: 9px; letter-spacing: .3px; margin-bottom: 3px; }
.srpl-addrname { font-weight: 700; color: #1a1a1a; }
.srpl-addrbody { color: #333; line-height: 1.6; }
.srpl-gstinrow { font-weight: 700; color: ${navy}; font-size: 9.5px; padding: 4px 14px; border-bottom: 1px solid #1a1a1a; }
table.srpl-items { width: 100%; border-collapse: collapse; font-size: 9px; }
table.srpl-items thead th { border: 1px solid #1a1a1a; padding: 5px 6px; font-weight: 700; color: ${navy}; text-align: left; }
table.srpl-items tbody td { border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; padding: 5px 6px; color: #1a1a1a; vertical-align: top; }
.tr { text-align: right; } .tc { text-align: center; }
.srpl-pagenote { text-align: center; font-size: 9px; color: #6b7280; padding: 8px; border-top: 1px solid #1a1a1a; }
.srpl-foot { display: flex; justify-content: flex-end; padding: 6px 14px 0; }
table.srpl-fttable { border-collapse: collapse; font-size: 9px; width: 260px; }
table.srpl-fttable td { padding: 3px 8px; }
table.srpl-fttable .ftl { color: #333; }
table.srpl-fttable .ftv { text-align: right; font-weight: 600; color: #1a1a1a; }
.srpl-totalbar { display: flex; justify-content: space-between; background: #1a1a1a; color: #fff; font-weight: 700; font-size: 11px; padding: 6px 14px; margin-top: 4px; }
.srpl-bottom { display: flex; justify-content: space-between; padding: 8px 14px; gap: 12px; border-top: 1px solid #1a1a1a; }
.srpl-bottom-left { font-size: 9px; color: #1a1a1a; max-width: 60%; }
.srpl-words, .srpl-pan { margin-bottom: 4px; line-height: 1.5; }
.srpl-eoe { font-weight: 700; margin: 6px 0 3px; }
.srpl-bank { line-height: 1.6; }
.srpl-bottom-right { display: flex; align-items: flex-end; }
.srpl-sigbox { border-top: 1px solid #1a1a1a; padding-top: 4px; font-size: 9px; text-align: center; min-width: 160px; }
.srpl-sigspace { height: 40px; }
.srpl-signame { font-weight: 700; color: #1a1a1a; }
.srpl-sigsub { color: #6b7280; }
.srpl-blackbar { background: #1a1a1a; color: #fff; text-align: center; font-size: 9px; font-weight: 600; padding: 5px; }
`
}
