// One PI (or PO) can be billed across SEVERAL invoices — partial dispatches /
// tranches. Everything that has to answer "how much of this PI/PO is already
// invoiced?" lives here, so the New Invoice form (prefill only what's left)
// and the PI/PO status (converted/completed only once FULLY invoiced) can
// never disagree with each other.
//
// Matching is by product name (productKey) — product identity is name alone
// (see utils/products.js / migration 046), there is no line-level id linking
// an invoice line back to the PI/PO line it came from.
import { supabase } from '../supabaseClient'
import { fetchAllPages, excludeAutoPurchaseMirrors } from './query'
import { productKey } from './products'

const EPS = 1e-6
// qty columns are numeric(15,3)
const round3 = n => Math.round(n * 1000) / 1000

// { productKey: total qty } over a set of lines.
export function sumQtyByProduct(lines) {
  const out = {}
  for (const l of lines || []) {
    const k = productKey(l.product_name)
    out[k] = (out[k] || 0) + (Number(l.qty) || 0)
  }
  return out
}

// The PI/PO's lines with each qty reduced by what's already invoiced for that
// product; fully invoiced lines are dropped. When the same product sits on
// several source lines, the invoiced qty is consumed top-down (line order).
export function remainingLines(sourceLines, billedLines) {
  const billed = sumQtyByProduct(billedLines)
  const out = []
  for (const l of sourceLines || []) {
    const k = productKey(l.product_name)
    const qty = Number(l.qty) || 0
    const take = Math.min(billed[k] || 0, qty)
    billed[k] = (billed[k] || 0) - take
    const rem = round3(qty - take)
    if (rem > EPS) out.push({ ...l, qty: rem })
  }
  return out
}

// 'none'    — no active invoice against it
// 'partial' — invoiced, but at least one product is still short of its qty
// 'full'    — every product on the PI/PO is invoiced up to (or past) its qty
// A PI/PO with no quantities to compare counts as 'full' on its first
// invoice — the same "one invoice converts it" behaviour as before.
export function invoiceCoverage(sourceLines, billedLines, invoiceCount) {
  if (!invoiceCount) return 'none'
  const need = sumQtyByProduct(sourceLines)
  const billed = sumQtyByProduct(billedLines)
  for (const [k, qty] of Object.entries(need)) {
    if ((billed[k] || 0) < qty - EPS) return 'partial'
  }
  return 'full'
}

const SOURCES = {
  pi: { table: 'proforma_invoices', lines: 'proforma_invoice_lines', fk: 'pi_id' },
  po: { table: 'purchase_orders',   lines: 'purchase_order_lines',   fk: 'po_id' },
}

// Source lines of one PI/PO plus the lines of every invoice that counts
// against it: not deleted, not cancelled, and not an auto-generated purchase
// mirror (the mirror copies its source's pi_id/po_id and would double the
// invoiced qty — see utils/query.js).
async function fetchSourceAndBilled(kind, docId) {
  const src = SOURCES[kind]
  const [{ data: sourceLines, error: srcErr }, { data: invs, error: invErr }] = await Promise.all([
    fetchAllPages(() => supabase.from(src.lines)
      .select('product_name,description,hsn_code,qty,unit,rate,gst_rate,line_no')
      .eq(src.fk, docId).order('line_no')),
    fetchAllPages(() => excludeAutoPurchaseMirrors(supabase.from('invoices').select('id,created_at')
      .eq(src.fk, docId).eq('is_deleted', false).neq('status', 'cancelled')).order('created_at')),
  ])
  if (srcErr || invErr) return { error: srcErr || invErr }
  let billedLines = []
  if (invs.length) {
    const { data, error } = await fetchAllPages(() => supabase.from('invoice_lines')
      .select('product_name,qty').in('invoice_id', invs.map(i => i.id)).order('invoice_id').order('line_no'))
    if (error) return { error }
    billedLines = data
  }
  return { sourceLines, invoices: invs, billedLines, error: null }
}

// For the New Invoice form: what's still left to invoice on this PI/PO.
// Returns { lines, invoiceCount, error } — `lines` is empty when it's fully
// invoiced (or simply has no lines; tell them apart with invoiceCount).
export async function fetchRemainingLines(kind, docId) {
  const r = await fetchSourceAndBilled(kind, docId)
  if (r.error) return { lines: [], invoiceCount: 0, error: r.error }
  return { lines: remainingLines(r.sourceLines, r.billedLines), invoiceCount: r.invoices.length, error: null }
}

const PO_RANK = { open: 0, partial: 1, completed: 2 }

// Re-derive a PI's / PO's status from the invoices that now stand against it.
// Call after anything that changes that set: invoice created, edited,
// cancelled or deleted.
//
//   PI: fully invoiced → 'converted'. Otherwise a 'converted' PI goes back
//       to 'accepted'; any other status (draft/sent/accepted) is left alone.
//   PO: none → 'open', some → 'partial', all → 'completed'.
//
// allowReopen=false only ever moves the status FORWARD — used when an invoice
// is added, so a PI/PO someone closed by hand isn't reopened just because a
// further invoice was raised against it. A 'cancelled' PI/PO is never touched.
export async function syncLinkedDocStatus(kind, docId, { allowReopen = false } = {}) {
  if (!docId) return
  const src = SOURCES[kind]
  const { data: doc } = await supabase.from(src.table).select('id,status').eq('id', docId).single()
  if (!doc || doc.status === 'cancelled') return
  const r = await fetchSourceAndBilled(kind, docId)
  if (r.error) return
  const cov = invoiceCoverage(r.sourceLines, r.billedLines, r.invoices.length)

  if (kind === 'pi') {
    if (cov === 'full') {
      const latest = r.invoices[r.invoices.length - 1]
      await supabase.from(src.table).update({ status: 'converted', converted_to_invoice_id: latest.id }).eq('id', docId)
    } else if (doc.status === 'converted' && allowReopen) {
      await supabase.from(src.table).update({ status: 'accepted', converted_to_invoice_id: null }).eq('id', docId)
    }
    return
  }

  const target = cov === 'full' ? 'completed' : cov === 'partial' ? 'partial' : 'open'
  if (target === doc.status) return
  if (!allowReopen && (PO_RANK[target] ?? 0) < (PO_RANK[doc.status] ?? 0)) return
  await supabase.from(src.table).update({ status: target }).eq('id', docId)
}
