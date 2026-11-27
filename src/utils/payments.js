import { toNum, round2 } from './money'
import { supabase } from '../supabaseClient'
import { fetchAllPages } from './query'
import { nextFromExisting } from './numbering'

// Single source of truth for "how much of this invoice has actually been
// settled". CHANGED (064): TDS is no longer taken from payment rows — it
// lives in the per-invoice TDS/TCS register (tds_tcs_entries). Settled is now:
//   cash paid (invoice_payments.amount) + adjustments
//   + TDS from the register (entry_type 'tds' only — TCS is a record, it
//     never changes pending)
//   + journal set-offs (invoice_setoffs, either side of the pair)
// invoice_payments.tds_amount on old rows is kept for history only: those 20
// rows were copied into the register by migration 064, so counting them here
// as well would settle the same TDS twice.
// Reused by notifications.js, Reports (Ageing) and the Payments tracker so
// they can never drift apart on the definition of "pending".
export function summarizeTranches(tranches) {
  const paidSum = (tranches || []).reduce((s, t) => s + toNum(t.amount), 0)
  const adjSum  = (tranches || []).reduce((s, t) => s + toNum(t.adjustments), 0)
  return { paidSum, adjSum }
}

// extras: { tdsEntries, setoffs } — already scoped to this invoice
// (see groupSettlementsByInvoice). Both optional.
export function computeInvoiceOutstanding(invoice, tranches, extras = {}) {
  const { paidSum, adjSum } = summarizeTranches(tranches)
  const tdsSum = (extras.tdsEntries || [])
    .filter(e => e.entry_type === 'tds' && !e.is_deleted)
    .reduce((s, e) => s + toNum(e.amount), 0)
  const setoffSum = (extras.setoffs || [])
    .filter(o => !o.is_deleted)
    .reduce((s, o) => s + toNum(o.amount), 0)
  const settled = paidSum + adjSum + tdsSum + setoffSum
  const pending = Math.max(0, Math.round(toNum(invoice?.total_amount) - settled))
  return { paidSum, tdsSum, adjSum, setoffSum, settled, pending }
}

// Groups register entries and set-offs by invoice. A set-off belongs to BOTH
// of its invoices (it settles the sale and the purchase by the same amount).
export function groupSettlementsByInvoice(tdsEntries, setoffs) {
  const map = new Map()
  const slot = id => {
    if (!map.has(id)) map.set(id, { tdsEntries: [], setoffs: [] })
    return map.get(id)
  }
  for (const e of (tdsEntries || [])) if (e.invoice_id) slot(e.invoice_id).tdsEntries.push(e)
  for (const o of (setoffs || [])) {
    if (o.sales_invoice_id) slot(o.sales_invoice_id).setoffs.push(o)
    if (o.purchase_invoice_id && o.purchase_invoice_id !== o.sales_invoice_id) slot(o.purchase_invoice_id).setoffs.push(o)
  }
  return map
}

const EMPTY_SETTLEMENT = Object.freeze({ tdsEntries: [], setoffs: [] })
export function settlementFor(map, invoiceId) {
  return map?.get(invoiceId) || EMPTY_SETTLEMENT
}

// Loads every live register entry and set-off (all pages). Optionally scoped
// to a list of invoice ids (chunked so the URL never gets too long).
export async function fetchSettlements(invoiceIds) {
  const tdsCols = 'id,invoice_id,entry_type,section_code,rate,base_amount,amount,entry_date,deducted_by_entity_id,deductee_entity_id,is_deleted'
  const setoffCols = 'id,journal_no,journal_date,entity_id,party_entity_id,sales_invoice_id,purchase_invoice_id,amount,payment_group_id,notes,is_deleted'
  if (!invoiceIds) {
    const [t, o] = await Promise.all([
      fetchAllPages(() => supabase.from('tds_tcs_entries').select(tdsCols).eq('is_deleted', false).order('id')),
      fetchAllPages(() => supabase.from('invoice_setoffs').select(setoffCols).eq('is_deleted', false).order('id')),
    ])
    return { tdsEntries: t.data || [], setoffs: o.data || [], error: t.error || o.error }
  }
  const ids = [...new Set(invoiceIds.filter(Boolean))]
  const tdsEntries = [], setoffs = []
  let error = null
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150)
    const list = chunk.join(',')
    const [t, o] = await Promise.all([
      supabase.from('tds_tcs_entries').select(tdsCols).eq('is_deleted', false).in('invoice_id', chunk),
      supabase.from('invoice_setoffs').select(setoffCols).eq('is_deleted', false)
        .or(`sales_invoice_id.in.(${list}),purchase_invoice_id.in.(${list})`),
    ])
    error = error || t.error || o.error
    tdsEntries.push(...(t.data || []))
    for (const row of (o.data || [])) if (!setoffs.some(x => x.id === row.id)) setoffs.push(row)
  }
  return { tdsEntries, setoffs, error }
}

// TDS / TCS rates recorded for an invoice in the register (0 when none).
// Credit/debit notes use these so a correction carries the same rate.
export async function fetchInvoiceTaxRates(invoiceId) {
  if (!invoiceId) return { tds: 0, tcs: 0 }
  const { data } = await supabase.from('tds_tcs_entries')
    .select('entry_type,rate').eq('invoice_id', invoiceId).eq('is_deleted', false)
  const rate = type => toNum((data || []).find(e => e.entry_type === type)?.rate) || 0
  return { tds: rate('tds'), tcs: rate('tcs') }
}

// Auto-advance an invoice's payment status from everything that settles it
// (payments, adjustments, register TDS, set-offs). Called after every
// payment, TDS entry or set-off insert/update/soft-delete so paid_amount /
// outstanding_amount / status on the invoice row can never drift. Rules:
// draft/cancelled invoices are never touched; otherwise settled==0 →
// 'submitted', 0<settled<total → 'partial', settled>=total → 'paid'.
// Failures are returned, not thrown — the entry itself already saved, so
// callers surface a warning rather than rolling anything back.
export async function syncInvoicePaymentStatus(invoiceId) {
  if (!invoiceId) return {}
  const [{ data: inv }, { data: tranches }, settle] = await Promise.all([
    supabase.from('invoices').select('id,total_amount,status').eq('id', invoiceId).single(),
    supabase.from('invoice_payments').select('amount,adjustments').eq('invoice_id', invoiceId).eq('is_deleted', false),
    fetchSettlements([invoiceId]),
  ])
  if (!inv || ['draft', 'cancelled'].includes(inv.status)) return {}
  if (settle.error) return { error: settle.error }
  const { settled } = computeInvoiceOutstanding(inv, tranches, settle)
  const total = toNum(inv.total_amount)
  const status = settled <= 0 ? 'submitted' : settled >= total - 0.005 ? 'paid' : 'partial'
  const { error } = await supabase.from('invoices').update({
    paid_amount: round2(settled),
    outstanding_amount: round2(Math.max(0, total - settled)),
    status,
    updated_at: new Date(),
  }).eq('id', invoiceId)
  return { status, error }
}

// Syncs several invoices; returns the first error, if any.
export async function syncInvoicesPaymentStatus(invoiceIds) {
  let firstError = null
  for (const id of [...new Set((invoiceIds || []).filter(Boolean))]) {
    const { error } = await syncInvoicePaymentStatus(id)
    if (error && !firstError) firstError = error
  }
  return { error: firstError }
}

// Pairs sales-side and purchase-side amounts into set-off rows, first come
// first served: each sales amount is used up against the purchases in order.
// Totals must match (caller checks); anything left over is ignored.
//   sales:     [{ invoice_id, amount }]
//   purchases: [{ invoice_id, amount }]
//   → [{ sales_invoice_id, purchase_invoice_id, amount }]
export function pairSetoffs(sales, purchases) {
  const s = (sales || []).map(x => ({ id: x.invoice_id, left: round2(toNum(x.amount)) })).filter(x => x.left > 0)
  const p = (purchases || []).map(x => ({ id: x.invoice_id, left: round2(toNum(x.amount)) })).filter(x => x.left > 0)
  const out = []
  let i = 0, j = 0
  while (i < s.length && j < p.length) {
    const amt = round2(Math.min(s[i].left, p[j].left))
    if (amt > 0) out.push({ sales_invoice_id: s[i].id, purchase_invoice_id: p[j].id, amount: amt })
    s[i].left = round2(s[i].left - amt)
    p[j].left = round2(p[j].left - amt)
    if (s[i].left <= 0) i++
    if (p[j].left <= 0) j++
  }
  return out
}

// Journal voucher number, per entity: <SHORT>/JV/26-27/0001, restarting each FY.
export function journalFormat(entityShort) {
  const base = (entityShort || 'JV').toUpperCase().replace(/\s+/g, '')
  return { prefix: `${base}/JV`, fy_format: 'YY-YY', separator: '/', start: 1, padding: 4, suffix: '', reset_each_fy: true }
}
export async function nextJournalNo(entityId, entityShort, date) {
  const f = journalFormat(entityShort)
  const { data } = await fetchAllPages(() => supabase.from('invoice_setoffs').select('journal_no').eq('entity_id', entityId).order('journal_no'))
  return nextFromExisting(f, date, (data || []).map(r => r.journal_no))
}
// Groups a flat invoice_payments result set by invoice_id — the shape both
// consumers need before calling computeInvoiceOutstanding per invoice.
export function groupTranchesByInvoice(tranches) {
  const map = new Map()
  for (const t of (tranches || [])) {
    if (!t.invoice_id) continue
    if (!map.has(t.invoice_id)) map.set(t.invoice_id, [])
    map.get(t.invoice_id).push(t)
  }
  return map
}

// Builds a single chronological cash-movement list for one entity, merging
// standalone entity_payments rows with invoice_payments tranches where that
// entity is either the payer (entity_id) or the payee/seller (party_entity_id)
// — entities here routinely sell as well as buy, so a ledger scoped only to
// entity_id would look empty for a primarily-selling entity. Balance = cash
// in − cash out, starting at 0. No opening-balance concept — this is a simple
// running total, not double-entry accounting.
export function buildEntityLedger(entityId, { entityPayments = [], invoicePayments = [] } = {}) {
  const rows = []

  for (const p of entityPayments) {
    if (p.entity_id === entityId) {
      rows.push({
        id: p.id, source: 'entity_payment', date: p.actual_payment_date,
        counterpartyId: p.party_entity_id, counterpartyName: p.party_name,
        inbound: p.direction === 'received', amount: toNum(p.amount), currency: p.currency,
        category: p.category, notes: p.notes, raw: p,
      })
    } else if (p.party_entity_id === entityId) {
      // Flip side: the OTHER entity's direction determines what this one experienced.
      rows.push({
        id: p.id, source: 'entity_payment', date: p.actual_payment_date,
        counterpartyId: p.entity_id, counterpartyName: null,
        inbound: p.direction !== 'received', amount: toNum(p.amount), currency: p.currency,
        category: p.category, notes: p.notes, raw: p,
      })
    }
  }

  for (const t of invoicePayments) {
    // Cash that actually moved: settled amount + TCS collected on top (TDS is
    // withheld, not paid out — same reasoning as index.jsx's tranche modal).
    const cash = toNum(t.amount) + toNum(t.tcs_amount)
    if (t.entity_id === entityId) {
      rows.push({
        id: t.id, source: 'invoice_payment', date: t.actual_payment_date,
        counterpartyId: t.party_entity_id, counterpartyName: t.party_name,
        inbound: false, amount: cash, currency: t.currency,
        invoiceNo: t.invoice_no, notes: t.notes, raw: t,
      })
    } else if (t.party_entity_id === entityId) {
      rows.push({
        id: t.id, source: 'invoice_payment', date: t.actual_payment_date,
        counterpartyId: t.entity_id, counterpartyName: null,
        inbound: true, amount: cash, currency: t.currency,
        invoiceNo: t.invoice_no, notes: t.notes, raw: t,
      })
    }
  }

  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.id || '').localeCompare(b.id || ''))
  let balance = 0
  for (const r of rows) {
    balance += r.inbound ? r.amount : -r.amount
    r.runningBalance = balance
  }
  return rows
}
