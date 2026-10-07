// Transporter challans — shared logic for the Challans page, the invoice
// page's vehicle list and the freight-expense challan picker.
//
// Data model (057_invoice_vehicles_and_expense_challans.sql):
//   invoice_vehicles  — one row per vehicle per invoice (vehicle, challan, transporter)
//   expense_challans  — one row per challan tagged on an expense
//
// A challan is identified by its NUMBER + TRANSPORTER NAME (case-insensitive),
// so two transporters that happen to use the same number are never merged.
// One challan can sit on many invoices; one invoice can have many vehicles.
import { supabase } from '../supabaseClient'
import { fetchAllPages } from './query'

export const VEHICLE_FIELDS = ['vehicle_no', 'transporter_name', 'challan_no']

export function clean(v) { return (v ?? '').toString().trim() }

// '' when there is no challan number — a row without one is not a challan yet.
export function challanKey(challanNo, transporterName) {
  const c = clean(challanNo).toLowerCase()
  return c ? `${c}|${clean(transporterName).toLowerCase()}` : ''
}

// The challan picker shows on freight-type expenses. Categories are free text
// from the expense_categories master, so match on the word rather than an id.
export function isFreightCategory(name) { return /freight|transport/i.test(name || '') }

function joinDistinct(values) {
  const seen = new Set(), out = []
  for (const raw of values) {
    const v = clean(raw)
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase()); out.push(v)
  }
  return out.length ? out.join(', ') : null
}

// invoices.vehicle_no / challan_no / transporter_name are kept as a combined
// copy of the vehicle rows ("KA01AB1234, KA02CD5678") so the printed invoice
// (utils/documentBuilders.js) and any older reader keep working unchanged.
export function transportMirror(vehicles) {
  const rows = vehicles || []
  return {
    vehicle_no:       joinDistinct(rows.map(v => v.vehicle_no)),
    challan_no:       joinDistinct(rows.map(v => v.challan_no)),
    transporter_name: joinDistinct(rows.map(v => v.transporter_name)),
  }
}

export async function syncInvoiceTransport(invoiceId, vehicles) {
  const mirror = transportMirror(vehicles)
  const { error } = await supabase.from('invoices').update({ ...mirror, updated_at: new Date() }).eq('id', invoiceId)
  return { mirror, error }
}

// A write the user has no rights to comes back from the API as "no rows"
// rather than a clear refusal — say what actually happened.
export function saveErrorMessage(error) {
  return error?.code === 'PGRST116'
    ? 'Not saved — you do not have edit access to this invoice.'
    : (error?.message || 'Could not save')
}

export async function fetchInvoiceVehicles(invoiceId) {
  return supabase.from('invoice_vehicles')
    .select('id,invoice_id,vehicle_no,challan_no,transporter_name,created_at')
    .eq('invoice_id', invoiceId).order('created_at').order('id')
}

// Saves ONE field of one vehicle row. A row with no id yet is inserted (and
// only when there is something to save); an existing row is updated.
export async function saveVehicleField(invoiceId, row, field, value) {
  const v = clean(value) || null
  if (row.id) {
    return supabase.from('invoice_vehicles').update({ [field]: v, updated_at: new Date() }).eq('id', row.id)
      .select('id,invoice_id,vehicle_no,challan_no,transporter_name,created_at').single()
  }
  if (!v) return { data: null, error: null }
  return supabase.from('invoice_vehicles').insert({ invoice_id: invoiceId, [field]: v })
    .select('id,invoice_id,vehicle_no,challan_no,transporter_name,created_at').single()
}

export async function deleteVehicleRow(id) {
  return supabase.from('invoice_vehicles').delete().eq('id', id)
}

// Sales invoices whose E-way Bill is entered (goods have actually moved), each
// with its vehicle rows. Restricting to invoice_type 'sales' also leaves out
// the auto-created purchase mirrors (see utils/query.js), so nothing shows twice.
export async function fetchChallanBoard() {
  const { data, error } = await fetchAllPages(() => supabase.from('invoices')
    .select('id,invoice_no,invoice_date,status,eway_bill_no,eway_bill_date,order_id,order_leg_id,seller_entity_id,buyer_entity_id,' +
      'seller:seller_entity_id(name,short_name),buyer:buyer_entity_id(name,short_name),orders(name,description),' +
      'vehicles:invoice_vehicles(id,invoice_id,vehicle_no,challan_no,transporter_name,created_at)')
    .eq('invoice_type', 'sales').eq('is_deleted', false).neq('status', 'cancelled')
    .not('eway_bill_no', 'is', null)
    .order('invoice_date', { ascending: false }).order('id'))
  if (error) return { data: null, error }
  for (const inv of data) {
    inv.vehicles = (inv.vehicles || []).slice().sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || '') || (a.id || '').localeCompare(b.id || ''))
  }
  return { data, error: null }
}

// Collapses the board into one entry per challan, with every invoice, order
// and vehicle it covers. Invoice order in = challan order out (newest first).
export function groupChallans(invoices) {
  const groups = new Map()
  for (const inv of invoices || []) {
    for (const v of inv.vehicles || []) {
      const key = challanKey(v.challan_no, v.transporter_name)
      if (!key) continue
      let g = groups.get(key)
      if (!g) {
        g = { key, challan_no: clean(v.challan_no), transporter_name: clean(v.transporter_name), vehicles: [], invoices: [], orders: [] }
        groups.set(key, g)
      }
      const veh = clean(v.vehicle_no)
      if (veh && !g.vehicles.some(x => x.toLowerCase() === veh.toLowerCase())) g.vehicles.push(veh)
      if (!g.invoices.some(i => i.id === inv.id)) {
        g.invoices.push({ id: inv.id, invoice_no: inv.invoice_no, order_id: inv.order_id || null })
      }
      if (inv.order_id && !g.orders.some(o => o.id === inv.order_id)) {
        g.orders.push({ id: inv.order_id, name: inv.orders?.name || '' })
      }
    }
  }
  return [...groups.values()]
}

// Invoices and orders behind a set of selected challans (deduped).
export function linksForChallans(groups, selectedKeys) {
  const invoices = [], orders = []
  for (const g of groups || []) {
    if (!selectedKeys.includes(g.key)) continue
    for (const i of g.invoices) if (!invoices.some(x => x.id === i.id)) invoices.push(i)
    for (const o of g.orders) if (!orders.some(x => x.id === o.id)) orders.push(o)
  }
  return { invoices, orders }
}

// Which expenses each challan is already on, and which challans each expense
// carries. Deleted expenses are ignored. Returns empty maps on any error so a
// page that only decorates with this never breaks because of it.
export async function fetchExpenseChallanLinks() {
  const byKey = {}, byExpense = {}, rowsByExpense = {}
  const { data, error } = await fetchAllPages(() => supabase.from('expense_challans')
    .select('id,expense_id,challan_no,transporter_name,expense:expense_id(expense_no,is_deleted)')
    .order('created_at').order('id'))
  if (error) return { byKey, byExpense, rowsByExpense, error }
  for (const r of data) {
    if (!r.expense || r.expense.is_deleted) continue
    const key = challanKey(r.challan_no, r.transporter_name)
    if (!key) continue
    const label = r.expense.expense_no || 'expense'
    if (!byKey[key]) byKey[key] = []
    if (!byKey[key].includes(label)) byKey[key].push(label)
    if (!byExpense[r.expense_id]) byExpense[r.expense_id] = []
    byExpense[r.expense_id].push(clean(r.challan_no))
    // Full rows per expense — what the expense edit form preselects from.
    if (!rowsByExpense[r.expense_id]) rowsByExpense[r.expense_id] = []
    rowsByExpense[r.expense_id].push({ key, challan_no: clean(r.challan_no), transporter_name: clean(r.transporter_name) })
  }
  return { byKey, byExpense, rowsByExpense, error: null }
}
