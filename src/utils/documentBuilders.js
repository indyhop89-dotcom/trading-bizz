// Shared doc-shape builders for PI/PO/Invoice printed documents (PDF/Excel).
//
// Lives outside the PI/PO/Invoices page files on purpose: Orders' per-leg
// "Generate Docs" action (fetchAndBuildLegDoc) needs exactly these three
// functions and nothing else from those pages, but a plain
// `import { buildPIDoc } from '../PI/index'` pulls the ENTIRE PI page module
// — every List/Detail/CSV-upload component — into whatever chunk imports it.
// With route-level code-splitting (see App.jsx's React.lazy), that static
// cross-page import would force the PI/PO/Invoices page bundles to load
// eagerly the moment Orders loads, defeating the split. Keeping these here
// means Orders only pulls in this small, dependency-light file.
import { supabase } from '../supabaseClient'
import { ENTITY_DOC_COLUMNS } from './documentTemplate'
import { getDriveViewUrl } from './drive'

// Fetches its own full entity rows (address/bank/logo columns) by id rather
// than relying on the page's own load() query to embed them — this keeps
// the wider, newer entity columns (which may not exist yet until migration
// 025_entity_logo.sql is applied) isolated to document generation, so a
// missing column here can never break the PI detail page itself loading.
export async function buildPIDoc(pi, lines) {
  const [{ data: fromEntity }, { data: toEntity }] = await Promise.all([
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', pi.from_entity_id).single(),
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', pi.to_entity_id).single(),
  ])
  let logoSrc = null
  if (fromEntity?.logo_file_id) { try { logoSrc = await getDriveViewUrl(fromEntity.logo_file_id) } catch { /* no logo — text-only header */ } }
  return {
    docType: 'PI',
    docNo: pi.pi_no, docDate: pi.pi_date, validOrDueDate: pi.valid_upto,
    paymentTerms: pi.payment_terms, deliveryTimeline: pi.delivery_timeline, modeOfTransport: pi.mode_of_transport || 'Road',
    sellerEntity: { ...fromEntity, logoSrc },
    buyerEntity: toEntity,
    lines,
    totals: { taxable_amount: pi.taxable_amount, cgst_amount: pi.cgst_amount, sgst_amount: pi.sgst_amount, igst_amount: pi.igst_amount, round_off_amount: pi.round_off_amount, total_amount: pi.total_amount },
    interstate: pi.is_interstate,
    bankDetails: fromEntity,
    notes: pi.notes,
    // These free-text overrides are captured on the PI form (and shown on
    // the detail page) but rendered separately — named distinctly from
    // `shipTo` (a structured buyer/ship-to address object) since these are
    // free-text notes, not a replacement for it.
    dispatchInfo: { billFrom: pi.bill_from, billTo: pi.bill_to, shipFrom: pi.ship_from, shipTo: pi.ship_to },
  }
}

// A PO's letterhead/issuer is the BUYER (the entity placing the order) —
// the vendor being ordered from goes in the "Bill To" block. This is the
// reverse of PI/Invoice, where the seller is the issuer.
//
// Fetches its own full entity rows the same way buildPIDoc does above.
export async function buildPODoc(po, lines) {
  const [{ data: buyer }, { data: seller }] = await Promise.all([
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', po.buyer_entity_id).single(),
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', po.seller_entity_id).single(),
  ])
  let logoSrc = null
  if (buyer?.logo_file_id) { try { logoSrc = await getDriveViewUrl(buyer.logo_file_id) } catch { /* no logo — text-only header */ } }
  return {
    docType: 'PO',
    docNo: po.po_no, docDate: po.po_date, validOrDueDate: po.delivery_date,
    paymentTerms: po.payment_terms, deliveryTimeline: po.delivery_timeline, modeOfTransport: po.mode_of_transport || 'Road',
    sellerEntity: { ...buyer, logoSrc },
    buyerEntity: seller,
    lines,
    totals: { taxable_amount: po.taxable_amount, cgst_amount: po.cgst_amount, sgst_amount: po.sgst_amount, igst_amount: po.igst_amount, round_off_amount: po.round_off_amount, total_amount: po.total_amount },
    interstate: po.is_interstate,
    bankDetails: buyer,
    notes: po.notes,
    dispatchInfo: { billFrom: po.bill_from, billTo: po.bill_to, shipFrom: po.ship_from, shipTo: po.ship_to },
  }
}

// Fetches its own full entity rows the same way buildPIDoc does above.
export async function buildInvoiceDoc(inv, lines) {
  const [{ data: seller }, { data: buyer }] = await Promise.all([
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', inv.seller_entity_id).single(),
    supabase.from('entities').select(ENTITY_DOC_COLUMNS).eq('id', inv.buyer_entity_id).single(),
  ])
  let logoSrc = null
  if (seller?.logo_file_id) { try { logoSrc = await getDriveViewUrl(seller.logo_file_id) } catch { /* no logo — text-only header */ } }
  return {
    docType: 'INVOICE',
    docNo: inv.invoice_no, docDate: inv.invoice_date, validOrDueDate: inv.due_date,
    paymentTerms: inv.payment_terms,
    sellerEntity: { ...seller, logoSrc },
    buyerEntity: buyer,
    lines,
    totals: { taxable_amount: inv.taxable_amount, cgst_amount: inv.cgst_amount, sgst_amount: inv.sgst_amount, igst_amount: inv.igst_amount, round_off_amount: inv.round_off_amount, total_amount: inv.total_amount },
    interstate: inv.is_interstate,
    bankDetails: seller,
    notes: inv.notes,
    ewayBill: { eway_bill_no: inv.eway_bill_no, vehicle_no: inv.vehicle_no, transporter_name: inv.transporter_name, challan_no: inv.challan_no },
    dispatchInfo: { billFrom: inv.bill_from, billTo: inv.bill_to, shipFrom: inv.ship_from, shipTo: inv.ship_to },
  }
}
