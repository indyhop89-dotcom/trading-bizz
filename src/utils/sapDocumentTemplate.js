/**
 * "SAP style" print format for the Proforma Invoice / Purchase Order / Tax
 * Invoice — a compact, fully bordered, black-on-white A4 layout, replicated
 * from the standalone "SAP Style PI / PO / Invoice Generator" HTML tools
 * shared for it:
 *
 *   title bar → logo | company details | copy boxes → document details |
 *   transport details → Bill To / Ship To (with Bill From / Ship From) →
 *   item table → totals → amount in words → HSN summary → terms →
 *   bank details | signature → footer
 *
 * Two variants, same layout:
 *   'sap'           no Material column          (…_No_Material.html)
 *   'sap_material'  with a Material column      (…_Final.html)
 *
 * Like the Tally template, nothing here is tied to one company — name,
 * address, GSTIN, PAN, bank and logo all come from doc.sellerEntity, so any
 * entity can be assigned this format. Amounts are never recalculated: line
 * values and totals are printed exactly as saved on the document.
 *
 * Fields the tools had that this ERP does not record (CIN, railway / L.R.
 * number, representative, charity / rebate lines, lot numbers) are left out
 * rather than printed blank or invented.
 */
import { esc, fmtN, numWords, addressLines } from './documentHelpers'
import { fmtDate } from './dates'

const TITLES = { INVOICE: 'TAX INVOICE', PI: 'PROFORMA INVOICE', PO: 'PURCHASE ORDER' }
const DATE_LABEL = { INVOICE: 'Due Date', PI: 'Valid Until', PO: 'Delivery By' }
const n = v => Number(v) || 0
const br = s => esc(s).replace(/\n/g, '<br>')
const date = d => (d ? fmtDate(d) : '')
const kv = (k, v) => `<td class="k">${k}</td><td>${v || ''}</td>`

function partyBlock(entity) {
  if (!entity) return ''
  return `<b>${esc(entity.name || '')}</b><br>${addressLines(entity)}${entity.gstin ? `<br><b>GSTIN NO:</b> ${esc(entity.gstin)}` : ''}`
}

export function buildSAPDocumentHTML(doc, { material = false } = {}) {
  const { docType, sellerEntity: seller = {}, buyerEntity: buyer = {}, lines = [], totals = {}, dispatchInfo = {}, ewayBill = {}, bankDetails = {} } = doc
  const isPO = docType === 'PO'

  // ── Items ──
  let qtyTotal = 0
  const lineTax = l => n(l.cgst_amount) + n(l.sgst_amount) + n(l.igst_amount)
  const rows = lines.map((l, i) => {
    qtyTotal += n(l.qty)
    const name = l.product_name || ''
    // With a Material column the product name goes there and the description
    // beside it; without one, the description (or the name) fills the single column.
    const desc = material ? (l.description && l.description !== name ? l.description : (name ? '' : l.description || '')) : (l.description || name)
    return `<tr class="item-main"><td class="sn">${i + 1}</td>${material ? `<td class="mat">${br(name)}</td>` : ''}<td class="desc">${br(desc)}</td><td class="hsn">${esc(l.hsn_code || '')}</td><td class="qty">${fmtN(l.qty)}</td><td class="unit">${esc(l.unit || '')}</td><td class="rate">${fmtN(l.rate)}</td><td class="gst">${fmtN(l.gst_rate)}%</td><td class="tax">${fmtN(lineTax(l))}</td><td class="amt">${fmtN(l.total_amount)}</td></tr>`
  }).join('')

  // ── Totals (as saved on the document) ──
  const sub = n(totals.taxable_amount)
  const cgst = n(totals.cgst_amount), sgst = n(totals.sgst_amount), igst = n(totals.igst_amount)
  const round = n(totals.round_off_amount)
  const grand = n(totals.total_amount)
  const taxRows = doc.interstate
    ? `<tr><td class="lbl">IGST:</td><td class="rate"></td><td class="val">${fmtN(igst)}</td></tr>`
    : `<tr><td class="lbl">CGST:</td><td class="rate"></td><td class="val">${fmtN(cgst)}</td></tr><tr><td class="lbl">SGST:</td><td class="rate"></td><td class="val">${fmtN(sgst)}</td></tr>`

  // ── HSN summary ──
  const hsn = new Map()
  for (const l of lines) {
    const k = l.hsn_code || '—'
    const g = hsn.get(k) || { taxable: 0, tax: 0 }
    g.taxable += n(l.taxable_amount); g.tax += lineTax(l)
    hsn.set(k, g)
  }
  const hsnRows = [...hsn].map(([k, g]) => `<tr><td class="left">${esc(k)}</td><td>${fmtN(g.taxable)}</td><td>${fmtN(g.tax)}</td><td>${fmtN(g.taxable + g.tax)}</td></tr>`).join('')
  const taxTotal = cgst + sgst + igst

  // ── Parties ──
  // PI / Invoice: we are the seller, the customer is billed. PO: we are the
  // one ordering, so the vendor is on the left and the goods ship to us.
  const sellerText = `<b>${esc(seller.name || '')}</b><br>${addressLines(seller)}`
  const left = isPO
    ? `<div class="party-title">VENDOR</div>${dispatchInfo.billFrom ? br(dispatchInfo.billFrom) : partyBlock(buyer)}<div class="subparty"><b>SHIP FROM</b><br>${dispatchInfo.shipFrom ? br(dispatchInfo.shipFrom) : addressLines(buyer)}</div>`
    : `<div class="party-title">BILL TO</div>${dispatchInfo.billTo ? br(dispatchInfo.billTo) : partyBlock(buyer)}<div class="subparty"><b>BILL FROM</b><br>${dispatchInfo.billFrom ? br(dispatchInfo.billFrom) : sellerText}</div>`
  const right = isPO
    ? `<div class="party-title">SHIP TO</div>${dispatchInfo.shipTo ? br(dispatchInfo.shipTo) : partyBlock(seller)}<div class="subparty"><b>BILL TO</b><br>${dispatchInfo.billTo ? br(dispatchInfo.billTo) : sellerText}</div>`
    : `<div class="party-title">SHIP TO</div>${dispatchInfo.shipTo ? br(dispatchInfo.shipTo) : partyBlock(buyer)}<div class="subparty"><b>SHIP FROM</b><br>${dispatchInfo.shipFrom ? br(dispatchInfo.shipFrom) : addressLines(seller)}</div>`

  const contact = [seller.email ? `E-Mail-${esc(seller.email)}` : '', seller.phone ? `Helpline No: ${esc(seller.phone)}` : ''].filter(Boolean).join(' &nbsp;&nbsp; ')
  const terms = seller.terms_and_conditions || doc.termsAndConditions || ''
  const itemCols = material ? 4 : 3
  // A short document keeps the open space the original layout has under the
  // totals; a long one gives that room to the items instead.
  const filler = lines.length <= 8 ? '<div class="blank-space"></div>' : ''

  return `<div class="sap-page${material ? ' sap-mat' : ''}"><div class="sap-wrap">
<div class="sap-title">${TITLES[docType] || TITLES.PI}</div>
<table class="sap-header"><tr>
<td class="seller-logo">${seller.logoSrc ? `<img src="${seller.logoSrc}" alt="">` : ''}</td>
<td class="seller-info"><b>${esc(seller.name || '')}</b><br>${addressLines(seller)}<br>${seller.gstin ? `<b>GSTIN:</b>${esc(seller.gstin)} &nbsp; ` : ''}${seller.pan ? `<b>PAN NO:</b>${esc(seller.pan)}` : ''}${seller.phone ? `<br><b>TEL:</b> ${esc(seller.phone)}` : ''}</td>
<td class="copy-block"><div class="copy-line"><span class="box"></span>Original for Recipient</div><div class="copy-line"><span class="box"></span>Duplicate for Transporter</div><div class="copy-line"><span class="box"></span>Triplicate for Supplier</div></td>
</tr></table>
<table class="meta-grid"><tr>
<td class="meta-left"><table class="meta-inner">
<tr>${kv('Document No:', esc(doc.docNo || ''))}${kv('Document Date:', date(doc.docDate))}</tr>
<tr>${kv('Reverse Charge:', 'N')}${kv(`${DATE_LABEL[docType] || 'Date'}:`, date(doc.validOrDueDate))}</tr>
<tr>${kv('Challan No:', esc(ewayBill.challan_no || ''))}${kv('Payment Terms:', esc(doc.paymentTerms || ''))}</tr>
<tr>${kv('Place of Supply:', esc(buyer.state_name || ''))}${kv('Delivery:', esc(doc.deliveryTimeline || ''))}</tr>
</table></td>
<td class="meta-right"><table class="meta-inner">
<tr>${kv('Transporter Name', `: ${esc(ewayBill.transporter_name || '')}`)}</tr>
<tr>${kv('Vehicle No', `: ${esc(ewayBill.vehicle_no || '')}`)}</tr>
<tr>${kv('E-Way Bill No', `: ${esc(ewayBill.eway_bill_no || '')}`)}</tr>
<tr>${kv('Mode of Transport', `: ${esc(doc.modeOfTransport || '')}`)}</tr>
</table></td>
</tr></table>
<table class="party-grid"><tr><td>${left}</td><td>${right}</td></tr></table>
<table class="items"><thead><tr><th class="sn">S.N</th>${material ? '<th class="mat">Material</th>' : ''}<th class="desc">Description</th><th class="hsn">HSN Code</th><th class="qty">Quantity</th><th class="unit">Unit</th><th class="rate">Rate</th><th class="gst">GST %</th><th class="tax">GST Amount</th><th class="amt">Total Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="${itemCols}">Total Quantity</td><td class="qty">${fmtN(qtyTotal)}</td><td></td><td colspan="3"></td><td class="amt">${fmtN(sub)}</td></tr></tfoot></table>
<table class="charges">
<tr><td class="lbl">Sub Total:</td><td></td><td class="val">${fmtN(sub)}</td></tr>
${taxRows}
<tr><td class="lbl">Rounding Off:</td><td></td><td class="val">${round < 0 ? `${fmtN(Math.abs(round))}-` : fmtN(round)}</td></tr>
<tr class="total-line"><td class="lbl">TOTAL:</td><td class="rate">INR</td><td class="val">${fmtN(grand)}</td></tr>
</table>
<div class="words"><b>AMOUNT IN WORDS:</b> &nbsp; Rs. ${numWords(grand)}</div>
${filler}
<table class="hsn-summary"><thead><tr><th class="left">HSN/SAC</th><th>Taxable Value</th><th>GST Amount</th><th>Total Value</th></tr></thead>
<tbody>${hsnRows}<tr><td class="left"><b>Total</b></td><td><b>${fmtN(sub)}</b></td><td><b>${fmtN(taxTotal)}</b></td><td><b>${fmtN(sub + taxTotal)}</b></td></tr></tbody></table>
<div class="conditions"><div class="conditions-title">TERMS &amp; CONDITIONS:</div>${br(terms)}${doc.notes ? `${terms ? '<br>' : ''}<b>Notes:</b> ${br(doc.notes)}` : ''}</div>
<table class="bottom-grid"><tr>
<td class="bank"><b>BANK NAME</b> &nbsp;&nbsp;: ${esc(bankDetails.bank_name || '')}<br><b>A/C NO</b> &nbsp;&nbsp;: ${esc(bankDetails.bank_account_no || '')}<br><b>IFSC/RTGS</b> &nbsp;&nbsp;: ${esc(bankDetails.bank_ifsc || '')}${bankDetails.bank_branch ? `<br><b>BRANCH</b> &nbsp;&nbsp;: ${esc(bankDetails.bank_branch)}` : ''}<br><b>PAN</b> &nbsp;&nbsp;: ${esc(seller.pan || '')}</td>
<td class="sign"><div class="sign-company">For: ${esc(seller.name || '')}</div><div class="sign-row"><span>Checked By</span><span>Authorized Signatory</span></div></td>
</tr></table>
<div class="footer1${contact ? '' : ' last'}">This is a computer generated document; no signature is required</div>
${contact ? `<div class="footer2">${contact}</div>` : ''}
</div></div>`
}

export function getSAPDocumentStyles() {
  return `
@page { size: A4; margin: 7mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
.sap-page { width: 196mm; margin: 0 auto; background: #fff; color: #000; font: 8.25px/1.12 Arial, Helvetica, sans-serif; }
.sap-wrap { border: 1px solid #000; }
.sap-title { height: 5mm; border-bottom: 1px solid #000; text-align: center; font-size: 12px; font-weight: 700; line-height: 5mm; padding: 0; }
.sap-header, .meta-grid, .party-grid, .items, .charges, .bottom-grid, .hsn-summary { width: 100%; border-collapse: collapse; border-spacing: 0; table-layout: fixed; margin: 0; }
.sap-header { border-bottom: 1px solid #000; }
.sap-header td { border: 0; border-right: 1px solid #000; vertical-align: top; padding: 2px 3px; height: 32mm; }
.sap-header td:last-child { border-right: 0; }
.seller-logo { width: 20.5%; text-align: center; vertical-align: middle !important; }
.seller-logo img { max-width: 26mm; max-height: 30mm; object-fit: contain; }
.seller-info { width: 53.5%; font-size: 8.2px; }
.copy-block { width: 26%; font-size: 8.1px; padding: 3px 5px !important; }
.copy-line { margin: 2px 0; }
.box { display: inline-block; width: 9px; height: 9px; border: 1px solid #000; margin-right: 5px; vertical-align: middle; }
.meta-grid { border-bottom: 1px solid #000; }
.meta-grid > tbody > tr > td { border: 0; border-right: 1px solid #000; padding: 2px 3px; vertical-align: top; height: 22mm; }
.meta-grid > tbody > tr > td:last-child { border-right: 0; }
.meta-left, .meta-right { width: 50%; }
.meta-inner { width: 100%; border-collapse: collapse; }
.meta-inner td { border: 0 !important; padding: .7px 0; vertical-align: top; }
.meta-inner .k { width: 24%; font-weight: 700; }
.meta-right .meta-inner .k { width: 42%; }
.party-grid { border-bottom: 1px solid #000; }
.party-grid td { width: 50%; border: 0; border-right: 1px solid #000; padding: 2px 3px; vertical-align: top; height: 38mm; }
.party-grid td:last-child { border-right: 0; }
.party-title { font-size: 9px; font-weight: 700; }
.subparty { margin-top: 5px; padding-top: 4px; border-top: 1px solid #000; }
.items { border-bottom: 1px solid #000; }
.items th, .items td { border: 0; border-right: 1px solid #000; border-bottom: 1px solid #000; padding: 1.5px 2px; vertical-align: top; }
.items th:last-child, .items td:last-child { border-right: 0; }
.items thead th { text-align: center; font-weight: 700; height: 5mm; vertical-align: middle; }
.items tfoot td { font-weight: 700; border-bottom: 0; }
.items .sn { width: 4%; text-align: center; }
.items .desc { width: 31%; }
.items .hsn { width: 10%; text-align: center; }
.items .qty { width: 9%; text-align: right; }
.items .unit { width: 7%; text-align: center; }
.items .rate { width: 9%; text-align: right; }
.items .gst { width: 7%; text-align: right; }
.items .tax { width: 10%; text-align: right; }
.items .amt { width: 13%; text-align: right; }
.sap-mat .items .sn { width: 3.5%; } .sap-mat .items .mat { width: 14%; } .sap-mat .items .desc { width: 19%; }
.sap-mat .items .qty { width: 8%; } .sap-mat .items .unit { width: 6%; } .sap-mat .items .rate { width: 8%; } .sap-mat .items .amt { width: 14.5%; }
.item-main td { height: 6.5mm; }
.charges { border-bottom: 1px solid #000; }
.charges td { border: 0; padding: 1.4px 4px; }
.charges .lbl { text-align: right; width: 70%; }
.charges .rate { text-align: right; width: 10%; }
.charges .val { text-align: right; width: 20%; }
.total-line td { font-weight: 700; border-top: 1px solid #000; }
.words { border-bottom: 1px solid #000; padding: 2px 3px; min-height: 5mm; }
.blank-space { height: 35mm; border-bottom: 1px solid #000; }
.hsn-summary { border-bottom: 1px solid #000; font-size: 7.7px; }
.hsn-summary th, .hsn-summary td { border-right: 1px solid #000; border-bottom: 1px solid #000; padding: 1.5px 2px; text-align: right; }
.hsn-summary th:last-child, .hsn-summary td:last-child { border-right: 0; }
.hsn-summary tr:last-child td { border-bottom: 0; }
.hsn-summary .left { text-align: left; }
.conditions { padding: 2px 3px; border-bottom: 1px solid #000; min-height: 22mm; font-size: 7.35px; line-height: 1.13; }
.conditions-title { font-weight: 700; font-size: 9px; }
.bottom-grid { border-bottom: 1px solid #000; }
.bottom-grid td { border: 0; border-right: 1px solid #000; padding: 2px 3px; vertical-align: top; height: 22mm; }
.bottom-grid td:last-child { border-right: 0; }
.bank { width: 42%; }
.sign { width: 58%; }
.sign-company { text-align: right; font-weight: 700; }
.sign-row { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 13mm; }
.footer1 { border-bottom: 1px solid #000; text-align: center; font-weight: 700; padding: 1px; min-height: 4mm; }
.footer1.last { border-bottom: 0; }
.footer2 { text-align: center; font-weight: 700; padding: 1px; min-height: 4mm; }
@media print {
  .items thead { display: table-header-group; }
  .item-main { page-break-inside: avoid; }
  .conditions, .bottom-grid, .charges, .words, .hsn-summary { page-break-inside: avoid; }
}
`
}
