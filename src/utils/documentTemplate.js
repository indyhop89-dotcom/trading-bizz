/**
 * Shared print/PDF template for Proforma Invoice, Purchase Order, and Tax
 * Invoice documents — ported from the standalone Vananam PI/Tax Invoice
 * generator tools (same CSS, same "hidden print area + window.print()"
 * technique, same Excel-2003 SpreadsheetML export in documentExcel.js),
 * parametrized per entity instead of hardcoded to one company.
 *
 * PO deliberately reuses the exact same layout as PI (per product decision)
 * — only the title/heading text differs, plus two label/data swaps specific
 * to PO's reversed roles (its issuer is the BUYER, not the seller): the
 * counterparty address block reads "Vendor" instead of "Bill To", and
 * "Ship To" defaults to the issuing buyer's own address instead of the
 * vendor's. The GST computation table, e-way-bill/vehicle block, and
 * per-line CGST/SGST/IGST breakdown are Invoice-only, matching how the two
 * reference tools actually differed.
 *
 * Pagination: unlike the reference tools (which used two different
 * techniques — explicit JS row-chunking for PI, native CSS running headers
 * for Invoice), every doc type here uses one explicit row-chunking scheme
 * (like the PI tool) so the same code path prints correctly in any browser
 * regardless of CSS Paged Media support.
 *
 * Colors are NOT hardcoded here — each entity's palette comes from
 * entityDocumentThemes.js, keyed by GSTIN. Generation is refused (throws,
 * caught by the calling page and shown as a toast) for any entity without a
 * registered theme, rather than falling back to a shared/generic look —
 * every entity's format is exclusive to them, by design.
 *
 * This module owns the "vananam" template family only. A theme with a
 * different `family` (see entityDocumentThemes.js) — e.g. SRPL's, a
 * genuinely different layout transcribed from real reference PDFs, or
 * Kirti's, a monochrome Tally-ERP-style layout ported from a standalone
 * HTML generator tool — is dispatched to its own module
 * (srplDocumentTemplate.js / kirtiDocumentTemplate.js) by the exported
 * buildDocumentHTML/getDocumentStyles/printDocument below, so every calling
 * page (PI/PO/Invoices/Orders) can keep importing these same three names
 * regardless of which entity's document is being built.
 */
import { fmtDate } from './dates'
import { esc, fmtN, fmtInt, numWords, addressLines, paginateLines } from './documentHelpers'
import { resolveEntityTheme } from './entityDocumentThemes'
import { buildSRPLDocumentHTML, getSRPLDocumentStyles } from './srplDocumentTemplate'
import { buildKirtiDocumentHTML, getKirtiDocumentStyles } from './kirtiDocumentTemplate'

// Columns needed from `entities` to render a document header/address block —
// shared by every page that builds a doc for printDocument/downloadDocumentExcel.
export const ENTITY_DOC_COLUMNS = 'name,short_name,gstin,pan,city,address,pincode,state_name,bank_name,bank_account_no,bank_ifsc,bank_branch,logo_url,logo_file_id,terms_and_conditions'

export const DOC_META = {
  PI: { title: 'Proforma Invoice', short: 'PI', dateLabel: 'Valid Until' },
  PO: { title: 'Purchase Order', short: 'PO', dateLabel: 'Delivery By' },
  INVOICE: { title: 'Tax Invoice', short: 'INV', dateLabel: 'Due Date' },
}

/**
 * Every entity's documents must look visually distinct from every other
 * entity's — there is no generic fallback look. Throws (rather than
 * defaulting to some shared style) when the issuing entity has no
 * configured theme yet, so document generation is blocked with a clear
 * message until that entity's actual format has been replicated and
 * registered in entityDocumentThemes.js.
 */
export function resolveThemeOrThrow(sellerEntity) {
  const theme = resolveEntityTheme(sellerEntity?.gstin)
  if (!theme) {
    throw new Error(`No document format has been configured for "${sellerEntity?.name || 'this entity'}" yet — share its Proforma Invoice/Invoice/PO format to have it added.`)
  }
  return theme
}

/**
 * doc = {
 *   docType: 'PI' | 'PO' | 'INVOICE',
 *   docNo, docDate, validOrDueDate,
 *   paymentTerms, deliveryTimeline, modeOfTransport, placeOfSupply,
 *   sellerEntity: { name, address, city, state_name, pincode, gstin, logoSrc },
 *   buyerEntity:  { name, address, city, state_name, pincode, gstin },
 *   shipTo: same shape as buyerEntity, or null to reuse buyerEntity,
 *   lines: [{ description, hsn_code, qty, unit, rate, gst_rate,
 *              taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount }],
 *   totals: { taxable_amount, cgst_amount, sgst_amount, igst_amount, round_off_amount, total_amount },
 *   interstate: boolean,
 *   bankDetails: { bank_name, bank_account_no, bank_ifsc, bank_branch },
 *   notes,
 *   ewayBill: { eway_bill_no, vehicle_no, transporter_name, challan_no } | null,  // INVOICE only
 * }
 */
function buildVananamHTML(doc, theme) {
  const {
    docType, docNo, docDate, validOrDueDate,
    paymentTerms, deliveryTimeline, modeOfTransport = 'Road', placeOfSupply,
    sellerEntity = {}, buyerEntity = {}, shipTo,
    lines = [], totals = {}, interstate = false,
    bankDetails = {}, notes, ewayBill, dispatchInfo,
  } = doc
  const meta = DOC_META[docType] || DOC_META.PI
  // PO's letterhead/issuer is the BUYER (sellerEntity here, per buildPODoc's
  // doc-shape mapping) and the counterparty in the address grid is the
  // VENDOR being ordered from — the reverse of PI/Invoice, where the seller
  // issues to a buyer. Two consequences: the counterparty block reads
  // "Vendor" not "Bill To" for a PO, and goods should ship to the buyer's
  // own address (sellerEntity) by default, not the vendor's.
  const counterpartyLabel = docType === 'PO' ? 'Vendor' : 'Bill To'
  const ship = shipTo || (docType === 'PO' ? sellerEntity : buyerEntity)

  // Split lines into fixed-size pages up front (simplest thing that
  // renders correctly across browsers — no reliance on CSS Paged Media).
  const pages = paginateLines(lines)
  const totalPages = pages.length

  // GST computation table (Invoice only) — grouped by HSN + rate.
  const gstMap = new Map()
  for (const l of lines) {
    const key = `${l.hsn_code || '—'}|${l.gst_rate}`
    if (!gstMap.has(key)) gstMap.set(key, { hsn: l.hsn_code || '—', rate: Number(l.gst_rate) || 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 })
    const g = gstMap.get(key)
    g.taxable += Number(l.taxable_amount) || 0
    g.cgst    += Number(l.cgst_amount) || 0
    g.sgst    += Number(l.sgst_amount) || 0
    g.igst    += Number(l.igst_amount) || 0
  }
  const gstRows = [...gstMap.values()]

  function rowHTML(l, sl) {
    const taxCell = interstate
      ? `IGST:₹${fmtN(l.igst_amount)}`
      : `CGST:₹${fmtN(l.cgst_amount)}<br>SGST:₹${fmtN(l.sgst_amount)}`
    return `<tr>
      <td class="tc" style="color:#6b7280">${sl}</td>
      <td>${esc(l.description).replace(/\n/g, '<br>')}</td>
      <td class="tc">${esc(l.hsn_code) || '—'}</td>
      <td class="tc">${l.qty}</td>
      <td class="tc">${esc(l.unit) || 'Nos'}</td>
      <td class="tr">₹ ${fmtN(l.rate)}</td>
      <td class="tc">${l.gst_rate}%</td>
      <td class="tr">₹ ${fmtN(l.taxable_amount)}</td>
      <td class="tr" style="font-size:8px;color:#6b7280">${taxCell}</td>
      <td class="tr" style="font-weight:700;color:${theme.navy}">₹ ${fmtN(l.total_amount)}</td>
    </tr>`
  }

  function gstComputationHTML() {
    if (docType !== 'INVOICE') return ''
    const taxCols = interstate
      ? `<th class="left" rowspan="2">HSN/SAC</th><th rowspan="2">Taxable Value</th><th colspan="2">Integrated Tax</th><th rowspan="2">Total Tax</th>`
      : `<th class="left" rowspan="2">HSN/SAC</th><th rowspan="2">Taxable Value</th><th colspan="2">Central Tax</th><th colspan="2">State Tax</th><th rowspan="2">Total Tax</th>`
    const subCols = interstate ? `<th>Rate</th><th>Amount</th>` : `<th>Rate</th><th>Amount</th><th>Rate</th><th>Amount</th>`
    const rows = gstRows.map(g => interstate
      ? `<tr><td class="left">${esc(g.hsn)}</td><td>${fmtN(g.taxable)}</td><td>${g.rate}%</td><td>${fmtN(g.igst)}</td><td>${fmtN(g.igst)}</td></tr>`
      : `<tr><td class="left">${esc(g.hsn)}</td><td>${fmtN(g.taxable)}</td><td>${g.rate / 2}%</td><td>${fmtN(g.cgst)}</td><td>${g.rate / 2}%</td><td>${fmtN(g.sgst)}</td><td>${fmtN(g.cgst + g.sgst)}</td></tr>`
    ).join('')
    const totalTax = interstate ? Number(totals.igst_amount) || 0 : (Number(totals.cgst_amount) || 0) + (Number(totals.sgst_amount) || 0)
    const totalRow = interstate
      ? `<tr class="total-row"><td class="left">Total</td><td>${fmtN(totals.taxable_amount)}</td><td>—</td><td>${fmtN(totals.igst_amount)}</td><td>${fmtN(totalTax)}</td></tr>`
      : `<tr class="total-row"><td class="left">Total</td><td>${fmtN(totals.taxable_amount)}</td><td>—</td><td>${fmtN(totals.cgst_amount)}</td><td>—</td><td>${fmtN(totals.sgst_amount)}</td><td>${fmtN(totalTax)}</td></tr>`
    return `<div class="gst-comp-wrap">
      <div class="gst-comp-head">GST Computation</div>
      <table class="gst-comp-table">
        <thead><tr>${taxCols}</tr><tr>${subCols}</tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
      <div class="tax-words-strip"><span class="tw-label">Tax Amount (in words): </span><span class="tw-value">${numWords(totalTax)}</span></div>
    </div>`
  }

  // Free-text overrides captured per-document (dispatch location can differ
  // from the seller's registered address, and Bill From/To can differ from
  // the counterparty's own name for e.g. a drop-ship arrangement) — distinct
  // from the structured addr-grid above, which always shows the actual
  // entity/ship-to addresses. Only rendered when at least one is set.
  function dispatchInfoHTML() {
    if (!dispatchInfo) return ''
    const { billFrom, billTo, shipFrom, shipTo: shipToNote } = dispatchInfo
    const rows = [
      ['Bill From', billFrom], ['Bill To', billTo],
      ['Ship From', shipFrom], ['Ship To', shipToNote],
    ].filter(([, v]) => v)
    if (!rows.length) return ''
    return `<div class="dispatch-info">
      ${rows.map(([label, value]) => `<div class="dispatch-row"><span class="dispatch-lbl">${esc(label)}</span><span class="dispatch-val">${esc(value)}</span></div>`).join('')}
    </div>`
  }

  function ewayHTML() {
    if (docType !== 'INVOICE' || !ewayBill) return ''
    const { eway_bill_no, vehicle_no, transporter_name, challan_no } = ewayBill
    if (!eway_bill_no && !vehicle_no && !transporter_name && !challan_no) return ''
    return `<div class="eway-block">
      <div class="eway-block-head"><span>E-way Bill &amp; Vehicle Details</span>${eway_bill_no ? `<span class="eway-num-badge">EWB: ${esc(eway_bill_no)}</span>` : ''}</div>
      <div class="eway-grid">
        <div class="eway-sub"><div class="eway-sub-head">E-way Bill</div>
          ${eway_bill_no ? `<div class="erow"><span class="ek">EWB Number</span><span class="ev">${esc(eway_bill_no)}</span></div>` : ''}
          ${transporter_name ? `<div class="erow"><span class="ek">Transporter</span><span class="ev">${esc(transporter_name)}</span></div>` : ''}
          ${challan_no ? `<div class="erow"><span class="ek">Challan No.</span><span class="ev">${esc(challan_no)}</span></div>` : ''}
        </div>
        <div class="eway-sub"><div class="eway-sub-head">Vehicle Details</div>
          ${vehicle_no ? `<div class="erow"><span class="ek">Vehicle No.</span><span class="ev">${esc(vehicle_no)}</span></div>` : ''}
        </div>
      </div>
    </div>`
  }

  function footerBlockHTML() {
    return `<div class="po-footer-block">
      <div class="totals-wrap"><div class="totals-box">
        <div class="trow"><span class="tl">Taxable Amount</span><span>₹ ${fmtN(totals.taxable_amount)}</span></div>
        ${interstate
          ? `<div class="trow"><span class="tl">IGST</span><span>₹ ${fmtN(totals.igst_amount)}</span></div>`
          : `<div class="trow"><span class="tl">CGST</span><span>₹ ${fmtN(totals.cgst_amount)}</span></div><div class="trow"><span class="tl">SGST</span><span>₹ ${fmtN(totals.sgst_amount)}</span></div>`
        }
        <div class="trow"><span class="tl">Round Off</span><span>₹ ${fmtN(totals.round_off_amount)}</span></div>
        <div class="trow grand"><span class="tl">Grand Total</span><span>₹ ${fmtInt(totals.total_amount)}</span></div>
      </div></div>
      <div class="amtwords"><div class="al">Amount in words</div><div class="av">${numWords(totals.total_amount)}</div></div>
      ${gstComputationHTML()}
      ${notes ? `<div class="note-badge">📌 ${esc(notes)}</div>` : ''}
      ${ewayHTML()}
      <div class="terms-grid">
        <div class="tbox"><div class="th">Commercial Terms</div>
          <div class="trow2"><span class="tk">Payment Terms</span><span class="tv">${esc(paymentTerms || '—')}</span></div>
          <div class="trow2"><span class="tk">Delivery</span><span class="tv">${esc(deliveryTimeline || '—')}</span></div>
          <div class="trow2"><span class="tk">Mode</span><span class="tv">${esc(modeOfTransport)}</span></div>
        </div>
        <div class="tbox"><div class="th">Terms &amp; Conditions</div>
          <div class="trow2"><span class="tk">${meta.dateLabel}</span><span class="tv">${fmtDate(validOrDueDate)}</span></div>
          <div class="trow2"><span class="tk">GST</span><span class="tv">Rate changes charged accordingly</span></div>
          <div class="trow2"><span class="tk">Disputes</span><span class="tv">As per Bill To party's jurisdiction</span></div>
          ${sellerEntity.terms_and_conditions ? `<div class="tv-extra">${esc(sellerEntity.terms_and_conditions).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
      </div>
      <div class="bank-sig">
        <div class="bbox"><div class="bhead">Bank Details</div>
          <div class="brow"><span class="bk">Bank</span><span class="bv">${esc(bankDetails.bank_name || '—')}</span></div>
          <div class="brow"><span class="bk">A/C No.</span><span class="bv">${esc(bankDetails.bank_account_no || '—')}</span></div>
          <div class="brow"><span class="bk">IFSC</span><span class="bv">${esc(bankDetails.bank_ifsc || '—')}</span></div>
          ${bankDetails.bank_branch ? `<div class="brow"><span class="bk">Branch</span><span class="bv">${esc(bankDetails.bank_branch)}</span></div>` : ''}
        </div>
        <div class="sbox"><div class="bhead">For ${esc(sellerEntity.name || '')}</div>
          <div class="sig-line"></div>
          <div class="sig-name">Authorised Signatory</div>
          <div style="margin-top:5px;font-size:7.5px;color:#9ca3af">This is a computer-generated ${esc(meta.title)}</div>
        </div>
      </div>
    </div>`
  }

  function pageHTML(chunk, num, isLast, startSl) {
    const rowsHTML = chunk.map((l, i) => rowHTML(l, startSl + i)).join('')
    return `<div class="po-page">
      <div class="po-body">
        <div class="pi-header">
          <div class="pi-logo-wrap">
            ${sellerEntity.logoSrc ? `<img class="pi-logo" src="${sellerEntity.logoSrc}" alt="${esc(sellerEntity.name)}">` : ''}
            <div class="co-block">
              <div class="co-name">${esc((sellerEntity.name || '').toUpperCase())}</div>
              <div class="co-sub">${addressLines(sellerEntity)}${sellerEntity.gstin ? `<br>GSTIN: ${esc(sellerEntity.gstin)}` : ''}</div>
            </div>
          </div>
          <div class="pi-title-block">
            <div class="pi-subtitle">${esc(meta.title)}</div>
            <div class="pi-title">${esc(meta.short)}</div>
            <div class="pi-meta">No. &nbsp;<b>${esc(docNo)}</b><br>Date &nbsp;<b>${fmtDate(docDate)}</b></div>
          </div>
        </div>
        <div class="accent-bar">
          <div class="ab-cell"><div class="ab-lbl">Payment Terms</div><div class="ab-val">${esc(paymentTerms || '—')}</div></div>
          <div class="ab-cell"><div class="ab-lbl">${esc(meta.dateLabel)}</div><div class="ab-val">${fmtDate(validOrDueDate)}</div></div>
          <div class="ab-cell"><div class="ab-lbl">Mode of Transport</div><div class="ab-val">${esc(modeOfTransport)}</div></div>
          <div class="ab-cell"><div class="ab-lbl">Place of Supply</div><div class="ab-val">${esc(placeOfSupply || buyerEntity.state_name || '—')}</div></div>
        </div>
        <div class="addr-grid">
          <div class="addr-box">
            <div class="addr-head navy">${esc(counterpartyLabel)}</div>
            <div class="addr-body"><b>${esc(buyerEntity.name)}</b><br>${addressLines(buyerEntity)}${buyerEntity.gstin ? `<br>GSTIN: ${esc(buyerEntity.gstin)}` : ''}</div>
          </div>
          <div class="addr-box">
            <div class="addr-head">Ship To</div>
            <div class="addr-body"><b>${esc(ship.name)}</b><br>${addressLines(ship)}</div>
          </div>
        </div>
        ${dispatchInfoHTML()}
        <div class="items-lbl">Line Items${totalPages > 1 ? ` — Page ${num} of ${totalPages}` : ''}</div>
        <table class="po-items">
          <thead><tr>
            <th style="width:22px">#</th><th>Product / Description</th>
            <th style="width:55px;text-align:center">HSN/SAC</th>
            <th style="width:32px;text-align:center">Qty</th>
            <th style="width:32px;text-align:center">Unit</th>
            <th style="width:65px;text-align:right">Rate (₹)</th>
            <th style="width:32px;text-align:center">GST%</th>
            <th style="width:75px;text-align:right">Taxable (₹)</th>
            <th style="width:88px;text-align:right">${interstate ? 'IGST' : 'GST (CGST+SGST)'}</th>
            <th style="width:78px;text-align:right">Total (₹)</th>
          </tr></thead>
          <tbody>${rowsHTML}</tbody>
        </table>
      </div>
      ${isLast ? footerBlockHTML() : ''}
      <div class="po-pg-footer">
        <span>${esc(sellerEntity.name || '')}${sellerEntity.gstin ? ` | GSTIN: ${esc(sellerEntity.gstin)}` : ''}</span>
        <span class="pg-badge">Page ${num} / ${totalPages}</span>
        <span>${esc(meta.short)} No: ${esc(docNo)} | ${fmtDate(docDate)}</span>
      </div>
    </div>`
  }

  let sl = 1
  return pages.map((chunk, i) => {
    const html = pageHTML(chunk, i + 1, i === pages.length - 1, sl)
    sl += chunk.length
    return html
  }).join('')
}

function getVananamStyles(theme) {
  const { navy, orange } = theme
  return `
* , *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: A4; margin: 0; }
body { background: #f0f1f8; font-family: Arial, sans-serif; font-size: 11px; color: #1a1a1a; }
/* Explicit A4 pixel dimensions (794x1123 @ 96dpi) + flex-column, ported
   verbatim from the original Vananam reference tool — without these, a
   short document's page collapses to its content's natural height instead
   of filling a full physical page (reads as "half size" once printed/saved
   as PDF). flex:1 on .po-body pushes the footer to the true bottom of the
   page even when there are few line items. */
.po-page { background: #fff; width: 794px; min-height: 1123px; margin: 0 auto 32px; display: flex; flex-direction: column; page-break-after: always; }
.po-page:last-child { page-break-after: avoid; margin-bottom: 0; }
.po-body { flex: 1; padding: 24px 30px 14px; }
.po-footer-block { padding: 0 30px 20px; }
@media print {
  body { background: #fff; }
  .po-page { margin: 0; box-shadow: none; }
}
.pi-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 3px solid ${navy}; }
.pi-logo-wrap { display: flex; align-items: center; gap: 12px; }
.pi-logo { height: 48px; width: auto; }
.co-name { font-size: 14px; font-weight: 700; color: ${navy}; letter-spacing: -.2px; }
.co-sub { font-size: 8.5px; color: #555; margin-top: 2px; line-height: 1.7; max-width: 320px; }
.pi-title-block { text-align: right; }
.pi-title { font-size: 22px; font-weight: 900; color: ${orange}; letter-spacing: 2px; text-transform: uppercase; }
.pi-subtitle { font-size: 9px; color: ${navy}; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; margin-bottom: 6px; }
.pi-meta { font-size: 9px; color: #555; line-height: 1.8; }
.pi-meta b { color: ${navy}; }
.accent-bar { background: ${navy}; border-radius: 4px; display: grid; grid-template-columns: repeat(4,1fr); overflow: hidden; margin-bottom: 12px; }
.ab-cell { padding: 6px 10px; border-right: 1px solid rgba(255,255,255,.15); }
.ab-cell:last-child { border-right: none; }
.ab-lbl { color: #b0b4d8; font-size: 7.5px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 2px; }
.ab-val { font-weight: 700; color: #fff; font-size: 9px; }
.addr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
.addr-box { border: 1.5px solid #d1d5db; border-radius: 5px; overflow: hidden; font-size: 9px; }
.addr-head { background: ${orange}; color: #fff; padding: 5px 10px; font-size: 8px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; }
.addr-head.navy { background: ${navy}; }
.addr-body { padding: 7px 10px; line-height: 1.75; color: #374151; }
.addr-body b { color: ${navy}; font-size: 9.5px; }
.dispatch-info { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 12px; font-size: 8.5px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; padding: 6px 10px; }
.dispatch-row { display: flex; gap: 5px; }
.dispatch-lbl { color: #6b7280; font-weight: 700; text-transform: uppercase; font-size: 7.5px; letter-spacing: .3px; align-self: center; }
.dispatch-val { color: #374151; }
.items-lbl { font-size: 8px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; font-weight: 700; margin-bottom: 4px; }
table.po-items { width: 100%; border-collapse: collapse; font-size: 9px; }
table.po-items thead tr { background: ${navy}; }
table.po-items thead th { color: #fff; padding: 6px 7px; font-size: 8px; font-weight: 700; text-align: left; white-space: nowrap; }
table.po-items tbody tr { border-bottom: 1px solid #e5e7eb; page-break-inside: avoid; }
table.po-items tbody tr:last-child { border-bottom: 2px solid ${navy}; }
table.po-items tbody td { padding: 6px 7px; vertical-align: top; color: #374151; line-height: 1.5; }
table.po-items tbody tr:nth-child(even) td { background: #f0f1fb; }
.tr { text-align: right; } .tc { text-align: center; }
.totals-wrap { display: flex; justify-content: flex-end; margin-top: 10px; }
.totals-box { width: 250px; font-size: 9px; }
.trow { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #f0f0f0; color: #374151; }
.trow.grand { font-weight: 700; font-size: 11px; color: ${navy}; border: none; border-top: 2px solid ${navy}; padding-top: 6px; margin-top: 3px; }
.trow .tl { color: #6b7280; } .trow.grand .tl { color: ${navy}; }
.amtwords { background: #eef0fb; border: 1px solid #c7caee; border-radius: 4px; padding: 5px 9px; margin-top: 10px; font-size: 9px; }
.amtwords .al { font-size: 8px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 1px; }
.amtwords .av { font-weight: 700; color: ${navy}; }
.gst-comp-wrap { margin-top: 10px; border: 1px solid #d1d5db; border-radius: 4px; overflow: hidden; font-size: 8px; }
.gst-comp-head { background: ${navy}; color: #fff; padding: 3px 8px; font-size: 7.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; }
.gst-comp-table { width: 100%; border-collapse: collapse; }
.gst-comp-table th { background: #f3f4f6; color: #1a1a1a; font-size: 7.5px; font-weight: 700; text-align: center; padding: 4px 5px; border: 1px solid #e5e7eb; text-transform: uppercase; letter-spacing: .3px; }
.gst-comp-table th.left { text-align: left; }
.gst-comp-table td { padding: 3px 5px; border: 1px solid #e5e7eb; text-align: right; font-size: 8px; }
.gst-comp-table td.left { text-align: left; }
.gst-comp-table tr.total-row td { background: #f9fafb; font-weight: 700; color: ${navy}; border-top: 2px solid #d1d5db; }
.tax-words-strip { margin-top: 5px; font-size: 8px; padding: 3px 5px; }
.tax-words-strip .tw-label { color: #1a1a1a; } .tax-words-strip .tw-value { font-weight: 700; }
.note-badge { background: #fff4ed; border: 1px solid #fbd5b0; border-radius: 4px; padding: 5px 9px; font-size: 8.5px; color: #92400e; margin-top: 8px; }
.eway-block { margin-top: 10px; border: 1.5px solid #d1d5db; border-radius: 5px; overflow: hidden; font-size: 8.5px; }
.eway-block-head { background: ${navy}; color: #fff; padding: 4px 10px; font-size: 7.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; }
.eway-grid { display: grid; grid-template-columns: 1fr 1fr; }
.eway-sub { padding: 7px 10px; }
.eway-sub:first-child { border-right: 1px solid #e5e7eb; }
.eway-sub-head { font-size: 7px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: ${orange}; border-bottom: 1.5px solid ${orange}; padding-bottom: 2px; margin-bottom: 5px; }
.erow { display: flex; gap: 6px; margin-bottom: 3px; }
.ek { min-width: 100px; color: #6b7280; flex-shrink: 0; }
.ev { color: ${navy}; font-weight: 600; word-break: break-all; }
.eway-num-badge { background: ${orange}; color: #fff; font-size: 9px; font-weight: 700; padding: 2px 8px; border-radius: 3px; letter-spacing: .5px; }
.terms-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.tbox { font-size: 8.5px; }
.tbox .th { font-size: 7.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: ${orange}; border-bottom: 2px solid ${orange}; padding-bottom: 3px; margin-bottom: 5px; }
.trow2 { display: flex; gap: 6px; margin-bottom: 3px; line-height: 1.5; }
.trow2 .tk { min-width: 90px; color: #6b7280; flex-shrink: 0; }
.trow2 .tv { color: ${navy}; font-weight: 600; }
.tv-extra { margin-top: 4px; padding-top: 4px; border-top: 1px dashed #d1d5db; color: #374151; line-height: 1.6; font-size: 8px; }
.bank-sig { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
.bbox { font-size: 8.5px; border: 1px solid #e5e7eb; border-radius: 5px; padding: 7px 10px; border-top: 3px solid ${orange}; }
.sbox { font-size: 8.5px; border: 1px solid #e5e7eb; border-radius: 5px; padding: 7px 10px; border-top: 3px solid ${navy}; }
.bhead { font-size: 7.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: #6b7280; margin-bottom: 5px; }
.brow { display: flex; gap: 8px; margin-bottom: 2px; }
.brow .bk { min-width: 80px; color: #6b7280; flex-shrink: 0; }
.brow .bv { color: ${navy}; font-weight: 600; }
.sig-line { border-top: 1.5px solid ${navy}; margin-top: 28px; margin-bottom: 4px; }
.sig-name { font-weight: 700; font-size: 9px; color: ${navy}; }
.po-pg-footer { border-top: 1px solid #e5e7eb; padding: 5px 0; margin-top: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 7.5px; color: #9ca3af; }
.pg-badge { background: ${navy}; color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 7.5px; }
`
}

/**
 * Public dispatchers — every calling page (PI/PO/Invoices/Orders) imports
 * only these three names regardless of which entity's document is being
 * built. They resolve the issuing entity's theme once and route to that
 * theme's `family` template (see the module docstring above).
 */
export function buildDocumentHTML(doc) {
  const theme = resolveThemeOrThrow(doc.sellerEntity)
  if (theme.family === 'srpl') return buildSRPLDocumentHTML(doc)
  if (theme.family === 'tally') return buildKirtiDocumentHTML(doc)
  return buildVananamHTML(doc, theme)
}

export function getDocumentStyles(theme) {
  if (theme.family === 'srpl') return getSRPLDocumentStyles(theme)
  if (theme.family === 'tally') return getKirtiDocumentStyles(theme)
  return getVananamStyles(theme)
}

/**
 * Opens a new window with the built document and triggers the browser's
 * print dialog (from which the user picks "Save as PDF"). No PDF library
 * involved — same technique the reference tools used.
 */
export function printDocument(doc) {
  const theme = resolveThemeOrThrow(doc.sellerEntity)
  const html = buildDocumentHTML(doc)
  const styles = getDocumentStyles(theme)
  const meta = DOC_META[doc.docType] || DOC_META.PI
  const title = doc.docNo || meta.short

  const win = window.open('', '_blank', 'width=900,height=700')
  if (!win) throw new Error("Could not open the print window — check your browser's popup blocker")
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${styles}</style></head><body>${html}</body></html>`)
  win.document.close()

  // onload usually fires almost immediately for a document.write()'d window
  // (no external resources to wait for) — the setTimeout is only a fallback
  // for browsers where onload doesn't fire reliably on such windows.
  // Guarded so whichever fires first is the only one that actually prints.
  let printed = false
  const doPrint = () => {
    if (printed) return
    printed = true
    try { win.focus(); win.print() } catch { /* window may already be closed by the user */ }
  }
  win.onload = doPrint
  setTimeout(doPrint, 600)
}
