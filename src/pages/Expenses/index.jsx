import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import { exportRows } from '../../utils/exportCsv' // CHANGED: CSV export of the rows on screen
import {
  C, Btn, MultiSelectDropdown, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import { formatINR, toNum, roundRupees, round2 } from '../../utils/money'
import { fmtDate, today, currentFYLabel } from '../../utils/dates'
import { useAuth } from '../../hooks/useAuth' // CHANGED: master/admin-only delete, same convention as PI/PO/Invoices
import { hasFullAccess } from '../../utils/roles'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { suggestNextNo } from '../../utils/numbering' // CHANGED: replaces the unconfirmed next_exp_no RPC
import { isValidGSTIN, isValidPAN, GSTIN_ERROR, PAN_ERROR } from '../../utils/validation'
import { excludeAutoPurchaseMirrors } from '../../utils/query'
// CHANGED: freight expenses can be tagged to transporter challans — see utils/challans.js.
import ChallanPicker from '../../components/ChallanPicker'
import InvoiceChallansModal from '../../components/InvoiceChallansModal' // CHANGED: click an invoice number → its challans → challan details
import { isFreightCategory, fetchChallanBoard, groupChallans, linksForChallans, fetchExpenseChallanLinks } from '../../utils/challans'

const GST_RATES = [0, 5, 12, 18, 28]

// CHANGED: auto-suggest a TDS section + rate from an expense's category. Used
// only at PAYMENT time (PartyPayments below) — withholding is decided when
// the vendor is actually paid, not when the expense is first booked. Payments
// to parties for these services attract withholding tax the payer must deduct
// (freight/transport → §194C, brokerage → §194H, professional → §194J). Always
// overridable, and thresholds (§194C ₹30k/₹1L) are NOT auto-enforced — this is
// a planning suggestion, the user decides.
const CATEGORY_TDS = {
  transport:         { section: '194C', rate: 1 },
  freight:           { section: '194C', rate: 1 },
  'loading/unloading': { section: '194C', rate: 1 },
  brokerage:         { section: '194H', rate: 5 },
  professional:      { section: '194J', rate: 10 },
}
function suggestTds(category) {
  return CATEGORY_TDS[(category || '').trim().toLowerCase()] || null
}

// CHANGED: the vendor's invoice number is the main identifier for an expense;
// the system number (expense_no) is the fallback when no vendor invoice is entered.
const expenseLabel = e => e?.vendor_invoice_no || e?.expense_no || ''

const EMPTY = {
  expense_date: today(), entity_id: '', expense_type: '',
  description: '', amount: '', gst_rate: 0,
  is_rcm: false, rcm_gst_rate: '',
  vendor_entity_id: '', vendor_name: '', vendor_gstin: '',
  vendor_invoice_no: '', vendor_invoice_date: '', // CHANGED: the vendor's own bill number + date
  party_id: '', due_date: '',
  order_id: '', order_leg_id: '', invoice_id: '', status: 'unpaid', notes: '',
}

// expense_date + n days → ISO date string, for auto due dates from a party's terms
function addDaysISO(dateStr, days) {
  if (!dateStr || days == null) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + Number(days))
  return d.toISOString().slice(0, 10)
}


// Resolve current FY
async function resolveFY() {
  const label = currentFYLabel()
  const { data } = await supabase.from('financial_years').select('id,name,code').order('start_date',{ascending:false}).limit(5)
  return (data||[]).find(f=>f.name===label)||data?.[0]
}

export default function Expenses() {
  const { profile } = useAuth()
  // CHANGED: bulk + single delete, master-only, same convention as PI/PO/Invoices
  const canDelete = hasFullAccess(profile)
  // CHANGED: expense_categories writes are gated on is_super_admin() (role=master)
  // in RLS — only masters get the "Manage categories" affordance, otherwise the
  // insert/deactivate would just bounce with an RLS error.
  const canManageCategories = profile?.role === 'master'
  // CHANGED: expenses_write is gated on has_entity_grant(entity_id) — an
  // expense belongs to one entity, no counterparty to worry about.
  const { entities: accessEntities, frozen: entityFrozen, defaultEntityId } = useEntityAccess()
  const [selected, setSelected] = useState(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [expenses, setExpenses] = useState([])
  const [entities, setEntities] = useState([])
  const [orders, setOrders]     = useState([])
  const [categories, setCategories] = useState([]) // CHANGED: loaded from expense_categories master table (string[] the dropdowns expect)
  const [categoryRows, setCategoryRows] = useState([]) // CHANGED: full {id,name} rows for the category manager
  const [orderInvoices, setOrderInvoices] = useState([]) // CHANGED: invoices for the currently linked order
  const [loadingInvoices, setLoadingInvoices] = useState(false)
  const [catModalOpen, setCatModalOpen] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [savingCat, setSavingCat]   = useState(false)
  const [parties, setParties]   = useState([]) // CHANGED: global party master (vendors)
  const [partyModalOpen, setPartyModalOpen] = useState(false) // CHANGED: quick-add party from the expense tool
  const [partyForm, setPartyForm] = useState({ name: '', gstin: '', pan: '', phone: '', payment_terms: '', payment_days: '' })
  const [savingParty, setSavingParty] = useState(false)
  const [loading, setLoading]   = useState(true)
  const [tab, setTab]           = useState('Expenses') // CHANGED: Expenses / Party Payments / Summary
  const [search, setSearch]     = useState('')
  const [typeFilter, setType]   = useState([]) // CHANGED: multi-select — empty means all types
  // CHANGED: entity + order multi-select and a from/to date range, same as the other list pages
  const [entityFilter, setEntityFilter] = useState([])
  const [orderFilter, setOrderFilter]   = useState([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]         = useState(EMPTY)
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  // CHANGED: challans tagged on a freight expense. challanGroups = one entry
  // per challan (with its invoices + orders), selChallans = picked challan
  // keys for the expense being created, challanLinks = which expenses each
  // challan is already on / which challans each expense carries.
  const [challanGroups, setChallanGroups]   = useState([])
  const [challanLoading, setChallanLoading] = useState(false)
  const [challanError, setChallanError]     = useState('')
  const [selChallans, setSelChallans]       = useState([])
  const [challanLinks, setChallanLinks]     = useState({ byKey: {}, byExpense: {}, rowsByExpense: {} })
  // CHANGED: expenses can now be edited. editingExpense = the row being edited
  // (null = creating a new one). The same form and modal serve both.
  const [editingExpense, setEditingExpense] = useState(null)
  // CHANGED: invoice numbers on the list are clickable. directInvoices = numbers
  // for expenses tagged straight to an invoice, viewInvoiceId = the one opened.
  const [directInvoices, setDirectInvoices] = useState({})
  const [viewInvoiceId, setViewInvoiceId]   = useState(null)
  const [moreInvoices, setMoreInvoices]     = useState(new Set()) // rows showing their full invoice list
  const showChallans = isFreightCategory(form.expense_type)

  const load = useCallback(async () => {
    setLoading(true)
    // Decorative only — never blocks the expense list (returns empty maps on error).
    fetchExpenseChallanLinks().then(l => setChallanLinks({ byKey: l.byKey, byExpense: l.byExpense, rowsByExpense: l.rowsByExpense }))
    // CHANGED: the challan board (challan → invoices) is also loaded with the list, so
    // each expense can show the invoices behind its challans. Decorative as well.
    fetchChallanBoard().then(({ data, error }) => { if (!error) setChallanGroups(groupChallans(data)) })
    const [{ data: exps }, { data: es }, { data: os }, { data: cats }, { data: pts }] = await Promise.all([
      supabase.from('expenses')
        .select('*, entity:entity_id(name,short_name), vendor:vendor_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).order('expense_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('expense_categories').select('id,name,sort_order').eq('is_active', true).order('sort_order'), // CHANGED
      supabase.from('parties').select('id,name,gstin,payment_terms,payment_days,rcm_applicable').eq('is_deleted', false).eq('is_active', true).order('name'), // CHANGED
    ])
    setExpenses(exps || [])
    // CHANGED: invoice numbers for expenses tagged straight to an invoice (fetched
    // separately, in small batches, so the main list never depends on it).
    const invIds = [...new Set((exps || []).map(e => e.invoice_id).filter(Boolean))]
    const invMap = {}
    for (let i = 0; i < invIds.length; i += 100) {
      const { data: invs } = await supabase.from('invoices').select('id,invoice_no').in('id', invIds.slice(i, i + 100))
      for (const inv of invs || []) invMap[inv.id] = inv.invoice_no
    }
    setDirectInvoices(invMap)
    setEntities(es || [])
    setOrders(os || [])
    setCategoryRows(cats || []) // CHANGED: full rows for the manager
    setCategories((cats || []).map(c => c.name)) // CHANGED: keep same string[] shape the UI already expects
    setParties(pts || []) // CHANGED
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // CHANGED: once an order is linked, load that order's invoices so an expense
  // can be tagged to a specific invoice. Cleared when no order is selected.
  useEffect(() => {
    if (!form.order_id) { setOrderInvoices([]); return }
    let cancelled = false
    setLoadingInvoices(true)
    // CHANGED: excludeAutoPurchaseMirrors — an expense shouldn't be
    // tag-able to the phantom auto-mirror copy of an order's invoice (see
    // utils/query.js).
    excludeAutoPurchaseMirrors(supabase.from('invoices')
      .select('id,invoice_no,invoice_date,total_amount')
      .eq('order_id', form.order_id).eq('is_deleted', false)
      .order('invoice_date', { ascending: false }))
      .then(({ data }) => { if (!cancelled) { setOrderInvoices(data || []); setLoadingInvoices(false) } })
    return () => { cancelled = true }
  }, [form.order_id])

  // CHANGED: challans already tagged on the expense being edited. Kept even
  // if a challan has since been removed from its invoice, so an edit never
  // drops a link silently.
  const editChallanRows = editingExpense ? (challanLinks.rowsByExpense[editingExpense.id] || []) : []
  // What the picker lists: every challan on an invoice, plus any tagged on
  // this expense that no longer sits on an invoice.
  // CHANGED: External challans (transport paid by someone else) are left out —
  // unless one is already tagged on the expense being edited.
  const pickerGroups = [
    ...challanGroups.filter(g => !g.external || editChallanRows.some(r => r.key === g.key)),
    ...editChallanRows.filter(r => !challanGroups.some(g => g.key === r.key))
      .map(r => ({ ...r, vehicles: [], invoices: [], orders: [] })),
  ]

  // "Already on another expense" warnings — leave out the expense being edited itself.
  const ownNo = editingExpense ? (expenseLabel(editingExpense) || 'expense') : null
  const linkedElsewhere = !editingExpense ? challanLinks.byKey : Object.fromEntries(
    Object.entries(challanLinks.byKey).map(([k, nos]) => [k, nos.filter(n => n !== ownNo)]).filter(([, nos]) => nos.length))

  function openNew() {
    setEditingExpense(null)
    setSelChallans([])
    setForm({ ...EMPTY, entity_id: defaultEntityId })
    setModalOpen(true)
  }
  // CHANGED: load an existing expense into the form. expense_type is the
  // live column the save writes.
  function openEdit(e) {
    setEditingExpense(e)
    setSelChallans((challanLinks.rowsByExpense[e.id] || []).map(r => r.key))
    setForm({
      ...EMPTY,
      expense_date: e.expense_date || today(), entity_id: e.entity_id || '',
      expense_type: e.expense_type || e.category || '',
      description: e.description || '', amount: e.amount ?? '',
      gst_rate: e.gst_rate ?? 0, is_rcm: !!e.is_rcm, rcm_gst_rate: e.rcm_gst_rate ?? '',
      vendor_entity_id: e.vendor_entity_id || '', vendor_name: e.vendor_name || '', vendor_gstin: e.vendor_gstin || '',
      vendor_invoice_no: e.vendor_invoice_no || '', vendor_invoice_date: e.vendor_invoice_date || '',
      party_id: e.party_id || '', due_date: e.due_date || '',
      order_id: e.order_id || '', invoice_id: e.invoice_id || '',
      status: e.status || 'unpaid', notes: e.notes || '',
    })
    setModalOpen(true)
  }
  // CHANGED: load the challan list when a freight-type expense is being
  // entered (fresh each time the form opens).
  useEffect(() => {
    if (!modalOpen || !showChallans) return
    let cancelled = false
    setChallanLoading(true)
    fetchChallanBoard().then(({ data, error }) => {
      if (cancelled) return
      setChallanError(error ? error.message : '')
      setChallanGroups(error ? [] : groupChallans(data))
      setChallanLoading(false)
    })
    return () => { cancelled = true }
  }, [modalOpen, showChallans])

  // CHANGED: picking challans links the expense to the invoices and orders
  // behind them. The single Order / Invoice fields are filled only when the
  // picked challans all point at ONE order (and one invoice); if they span
  // several, those fields are cleared and the full list is shown instead.
  // The amount is never split.
  function changeChallans(keys) {
    setSelChallans(keys)
    if (keys.length === 0) return
    const { invoices: invs, orders: ords } = linksForChallans(pickerGroups, keys)
    const oneOrder = ords.length === 1 && invs.every(i => i.order_id === ords[0].id)
    setForm(f => ({
      ...f,
      order_id:   oneOrder ? ords[0].id : '',
      invoice_id: oneOrder && invs.length === 1 ? invs[0].id : '',
    }))
  }
  const challanLinked = showChallans ? linksForChallans(pickerGroups, selChallans) : { invoices: [], orders: [] }

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  // CHANGED: switching orders invalidates any invoice tagged from the previous
  // order — clear it so we never persist an invoice that belongs elsewhere.
  function setOrder(v) { setForm(f => ({ ...f, order_id: v, invoice_id: '' })) }

  // CHANGED: selecting a party auto-fills vendor GSTIN/name and derives the
  // payment due date from the party's default payment_days.
  function selectParty(id) {
    const p = parties.find(x => x.id === id)
    setForm(f => {
      const next = {
        ...f,
        party_id: id,
        vendor_name:  p ? p.name : f.vendor_name,
        vendor_gstin: p ? (p.gstin || '') : f.vendor_gstin,
        due_date: p && p.payment_days != null ? addDaysISO(f.expense_date, p.payment_days) : f.due_date,
      }
      // CHANGED: RCM auto-suggestion — vendors marked rcm_applicable in the
      // party master default this expense to RCM (zeroes vendor GST, suggests
      // a starting self-assessed rate); always overridable, same
      // "suggest, never force" pattern as suggestTds.
      if (p?.rcm_applicable && !f.is_rcm) {
        next.is_rcm = true
        next.rcm_gst_rate = f.rcm_gst_rate || 5
        next.gst_rate = 0
      }
      return next
    })
  }
  // Changing the expense date re-derives the due date from the selected party's
  // terms (keeps them in sync); no party ⇒ date change leaves due_date alone.
  function setExpenseDate(v) {
    const p = parties.find(x => x.id === form.party_id)
    setForm(f => ({ ...f, expense_date: v, due_date: p && p.payment_days != null ? addDaysISO(v, p.payment_days) : f.due_date }))
  }

  // CHANGED: quick-add a party without leaving the expense form (master/admin only).
  async function handleAddParty() {
    if (!partyForm.name.trim()) return setToast({ message: 'Party name is required', type: 'error' })
    const days = partyForm.payment_days === '' ? null : parseInt(partyForm.payment_days, 10)
    if (days !== null && (isNaN(days) || days < 0)) return setToast({ message: 'Payment days must be a positive number', type: 'error' })
    if (!isValidGSTIN(partyForm.gstin)) return setToast({ message: GSTIN_ERROR, type: 'error' })
    if (!isValidPAN(partyForm.pan)) return setToast({ message: PAN_ERROR, type: 'error' })
    setSavingParty(true)
    const payload = {
      name: partyForm.name.trim(),
      gstin: partyForm.gstin.trim().toUpperCase() || null,
      pan: partyForm.pan.trim().toUpperCase() || null,
      phone: partyForm.phone.trim() || null,
      payment_terms: partyForm.payment_terms.trim() || null,
      payment_days: days,
    }
    const { data, error } = await supabase.from('parties').insert(payload).select('id,name,gstin,payment_terms,payment_days').single()
    setSavingParty(false)
    if (error) {
      const msg = error.code === '23505' ? 'A party with this GSTIN already exists' : error.message
      return setToast({ message: msg, type: 'error' })
    }
    setParties(ps => [...ps, data].sort((a, b) => a.name.localeCompare(b.name)))
    selectParty(data.id)
    setPartyModalOpen(false)
    setPartyForm({ name: '', gstin: '', pan: '', phone: '', payment_terms: '', payment_days: '' })
    setToast({ message: 'Party added', type: 'success' })
  }

  // CHANGED: master-only category management (add custom / retire junk).
  async function addCategory() {
    const name = newCatName.trim()
    if (!name) return
    if (categoryRows.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      return setToast({ message: 'That category already exists', type: 'error' })
    }
    setSavingCat(true)
    const nextOrder = Math.max(0, ...categoryRows.map(c => c.sort_order || 0)) + 1
    // name is UNIQUE and retired categories are only soft-deleted (is_active=false),
    // so a plain insert of a previously-removed name (e.g. re-adding "Other")
    // collides. Upsert on name instead: it revives the retired row or creates
    // a new one, either way leaving it active.
    const { error } = await supabase.from('expense_categories')
      .upsert({ name, is_active: true, sort_order: nextOrder }, { onConflict: 'name' })
    setSavingCat(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setNewCatName('')
    setToast({ message: 'Category added', type: 'success' })
    load()
  }
  // Soft-retire (is_active=false) rather than hard-delete: existing expenses
  // store the category as free text, so this only removes it from future
  // dropdowns without rewriting history.
  async function retireCategory(cat) {
    const { error } = await supabase.from('expense_categories').update({ is_active: false }).eq('id', cat.id)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `"${cat.name}" removed from the list`, type: 'success' })
    load()
  }

  const previewAmount  = toNum(form.amount)
  const previewGST     = form.is_rcm ? 0 : roundRupees(round2(previewAmount * Number(form.gst_rate) / 100))
  const previewTotal   = previewAmount + previewGST   // what's payable to the vendor
  const previewRcmGST  = form.is_rcm ? roundRupees(round2(previewAmount * (Number(form.rcm_gst_rate) || 0) / 100)) : 0

  async function handleSave() {
    if (!form.entity_id || !form.description) return setToast({ message: 'Entity and description are required', type: 'error' })
    if (!form.expense_type) return setToast({ message: 'Expense type is required', type: 'error' })
    const amount    = roundRupees(toNum(form.amount))
    if (!amount) return setToast({ message: 'Amount is required', type: 'error' })
    if (!isValidGSTIN(form.vendor_gstin)) return setToast({ message: GSTIN_ERROR, type: 'error' })
    if (form.is_rcm && !Number(form.rcm_gst_rate)) return setToast({ message: 'RCM GST rate is required', type: 'error' })
    setSaving(true)
    // CHANGED: an edit keeps the expense's own number and financial year —
    // both are only worked out when a NEW expense is created.
    const isEdit = !!editingExpense
    const fy = isEdit ? null : await resolveFY()
    if (!isEdit && !fy) { setSaving(false); return setToast({ message: 'No financial year found', type: 'error' }) }
    // CHANGED: next_exp_no was calling an RPC of unconfirmed reliability —
    // same shape as the next_pi_no/next_po_no/next_inv_no functions already
    // confirmed missing on the live DB. Switched to suggestNextNo(), the
    // same client-side approach already proven for PI/PO/Invoices, so
    // expense numbering can't silently fail the same way. Stays fully
    // auto-generated — no manual override field, as requested.
    const entity = entities.find(e => e.id === form.entity_id)
    const expNo = isEdit ? null : await suggestNextNo({ table: 'expenses', noCol: 'expense_no', entityShort: entity?.short_name || entity?.name, fyCode: fy.code })
    const gst_amount     = form.is_rcm ? 0 : roundRupees(round2(amount * Number(form.gst_rate) / 100))
    const total_amount   = amount + gst_amount   // vendor payable — RCM GST never added here
    const rcm_gst_amount = form.is_rcm ? roundRupees(round2(amount * Number(form.rcm_gst_rate) / 100)) : 0
    const payload = {
      // CHANGED: the live expenses table has no financial_year_id column — the FY
      // is only used above to build the expense number.
      ...(isEdit ? {} : { expense_no: expNo }),
      expense_date:    form.expense_date,
      entity_id:       form.entity_id,
      // CHANGED: the live column is expense_type — there is no `category` column.
      expense_type:    form.expense_type || form.category || 'other',
      description:     form.description,
      amount,
      gst_rate:        form.is_rcm ? 0 : Number(form.gst_rate),
      gst_amount,
      total_amount,
      is_rcm:          form.is_rcm,
      rcm_gst_rate:    form.is_rcm ? Number(form.rcm_gst_rate) : null,
      rcm_gst_amount,
      vendor_entity_id: form.vendor_entity_id || null,
      vendor_name:     form.vendor_name || null,
      vendor_gstin:    form.vendor_gstin || null,
      vendor_invoice_no:   form.vendor_invoice_no.trim() || null, // CHANGED: vendor's own bill number — the main identifier
      vendor_invoice_date: form.vendor_invoice_date || null,
      order_id:        form.order_id || null,
      invoice_id:      form.invoice_id || null, // CHANGED: optional invoice tag under the linked order
      party_id:        form.party_id || null,   // CHANGED: tagged party from the global master
      due_date:        form.due_date || null,   // CHANGED: payment due date (from party terms, editable)
      // TDS/TCS is no longer recorded at booking time — it's decided when the
      // party is actually paid (Party Payments tab), mirroring how invoice
      // TDS/TCS moved to payment time. See PartyPayments below.
      status:          form.status,
      notes:           form.notes || null,
    }
    // CHANGED: .select('id') — the new expense's id is needed to tag its challans.
    const { data: saved, error } = isEdit
      ? await supabase.from('expenses').update(payload).eq('id', editingExpense.id).select('id').single()
      : await supabase.from('expenses').insert(payload).select('id').single()
    if (error) {
      setSaving(false)
      // An update the user has no rights to comes back as "no rows", not a refusal.
      return setToast({ message: error.code === 'PGRST116' ? 'Not saved — you do not have edit access to this expense.' : error.message, type: 'error' })
    }
    // CHANGED: challan links. On an edit the expense's links are replaced with
    // exactly what is ticked now (none if the type is no longer freight); the
    // old ones are only removed when something actually changed.
    let challanErr = null
    const wanted = showChallans ? pickerGroups.filter(g => selChallans.includes(g.key)) : []
    const had = isEdit ? editChallanRows.map(r => r.key) : []
    const changed = wanted.length !== had.length || wanted.some(g => !had.includes(g.key))
    if (changed) {
      if (had.length) ({ error: challanErr } = await supabase.from('expense_challans').delete().eq('expense_id', saved.id))
      if (!challanErr && wanted.length) {
        ({ error: challanErr } = await supabase.from('expense_challans').insert(
          wanted.map(g => ({ expense_id: saved.id, challan_no: g.challan_no, transporter_name: g.transporter_name || null }))))
      }
    }
    setSaving(false)
    const done = isEdit ? 'Expense updated' : 'Expense recorded'
    setToast(challanErr
      ? { message: `${done}, but the challans were not saved: ${challanErr.message}`, type: 'error' }
      : { message: done, type: 'success' })
    setModalOpen(false)
    load()
  }

  // CHANGED: the invoices behind an expense — through its challans, plus the
  // one it is tagged to directly. [{ id, invoice_no }], no repeats.
  function invoicesOf(e) {
    const out = []
    const keys = (challanLinks.rowsByExpense[e.id] || []).map(r => r.key)
    for (const g of challanGroups) if (keys.includes(g.key)) for (const i of g.invoices) if (!out.some(x => x.id === i.id)) out.push({ id: i.id, invoice_no: i.invoice_no })
    if (e.invoice_id && !out.some(x => x.id === e.invoice_id)) out.push({ id: e.invoice_id, invoice_no: directInvoices[e.invoice_id] })
    return out
  }

  const filtered = expenses.filter(e => {
    // CHANGED: search also matches the vendor invoice number and the system number
    const q = search.toLowerCase()
    const ms = !search || e.description.toLowerCase().includes(q) || e.entity?.name?.toLowerCase().includes(q)
      || (e.vendor_invoice_no || '').toLowerCase().includes(q) || (e.expense_no || '').toLowerCase().includes(q)
      || (!!search && invoicesOf(e).some(i => (i.invoice_no || '').toLowerCase().includes(q)))
    // CHANGED: the type lives in expense_type on the live table
    const mt = typeFilter.length === 0 || typeFilter.includes(e.expense_type || e.category)
    // CHANGED: entity / order multi-select + expense-date range
    const me = entityFilter.length === 0 || entityFilter.includes(e.entity_id)
    const mo = orderFilter.length === 0 || orderFilter.includes(e.order_id)
    const md = (!dateFrom || (e.expense_date || '') >= dateFrom) && (!dateTo || (e.expense_date || '') <= dateTo)
    return ms && mt && me && mo && md
  })
  // CHANGED: the Unpaid / Paid cards follow the filters, so they total what the list shows
  const totalUnpaid = filtered.filter(e => e.status === 'unpaid').reduce((s, e) => s + e.total_amount, 0)
  const totalPaid   = filtered.filter(e => e.status === 'paid').reduce((s, e) => s + e.total_amount, 0)
  // Filter choices: only entities and orders that actually have an expense
  const entityOptions = entities.filter(en => expenses.some(e => e.entity_id === en.id)).map(en => ({ value: en.id, label: en.short_name || en.name }))
  const orderOptions  = orders.filter(o => expenses.some(e => e.order_id === o.id)).map(o => ({ value: o.id, label: o.name }))
  const anyFilter = typeFilter.length || entityFilter.length || orderFilter.length || dateFrom || dateTo
  function clearFilters() { setType([]); setEntityFilter([]); setOrderFilter([]); setDateFrom(''); setDateTo('') }

  // CHANGED: multi-select + bulk/single soft-delete, same shape as PI/PO/Invoices
  function toggleSelect(id) {
    setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleSelectAll() {
    setSelected(s => s.size === filtered.length ? new Set() : new Set(filtered.map(e => e.id)))
  }
  async function handleBulkDelete() {
    setBulkDeleting(true)
    const { error } = await supabase.from('expenses').update({ is_deleted: true }).in('id', [...selected])
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${selected.size} expense(s) deleted`, type: 'success' })
    setSelected(new Set())
    load()
  }
  async function handleDelete() {
    setDeleting(true)
    const { error } = await supabase.from('expenses').update({ is_deleted: true }).eq('id', confirmDelete.id)
    setDeleting(false)
    setConfirmDelete(null)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: 'Expense deleted', type: 'success' })
    load()
  }

  const columns = [
    // CHANGED: checkbox column, master-only
    ...(canDelete ? [{
      label: <input type='checkbox' checked={filtered.length > 0 && selected.size === filtered.length}
        onChange={toggleSelectAll} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
      render: e => <input type='checkbox' checked={selected.has(e.id)}
        onChange={() => toggleSelect(e.id)} onClick={ev => ev.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
    }] : []),
    { label: 'S.No.',    render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    // CHANGED: vendor invoice number leads as the main identifier; the system number sits under it as the secondary reference
    { label: 'Vendor Inv No', render: e => <span style={{ fontSize: '12px' }}>
        <span style={{ fontWeight: 600 }}>{e.vendor_invoice_no || '—'}</span>
        {e.vendor_invoice_date && <span style={{ color: C.textMuted }}> · {fmtDate(e.vendor_invoice_date)}</span>}
        <span style={{ display: 'block', fontFamily: 'monospace', fontSize: '10px', color: C.textMuted }}>{e.expense_no || ''}</span>
      </span> },
    { label: 'Date',     render: e => <span style={{ fontSize: '12px' }}>{fmtDate(e.expense_date)}</span> },
    { label: 'Entity',   render: e => <span style={{ fontSize: '12px' }}>{e.entity?.short_name || e.entity?.name}</span> },
    { label: 'Type',     render: e => <Badge status={e.expense_type || e.category} label={e.expense_type || e.category} /> },
    // CHANGED: challans tagged on the expense show under the description
    { label: 'Desc',     render: e => <span style={{ fontSize: '12px' }}>{e.description}
        {challanLinks.byExpense[e.id]?.length > 0 && <span style={{ display: 'block', fontSize: '11px', color: C.textMuted }}>Challan: {challanLinks.byExpense[e.id].join(', ')}</span>}
      </span> },
    // CHANGED: clickable invoice numbers — opens the challans on that invoice
    { label: 'Invoices', render: e => {
        const invs = invoicesOf(e)
        if (invs.length === 0) return <span style={{ fontSize: '12px', color: C.textMuted }}>—</span>
        const all = moreInvoices.has(e.id)
        return (
          <span style={{ fontSize: '12px', display: 'flex', flexWrap: 'wrap', gap: '2px 8px', maxWidth: '260px' }}>
            {(all ? invs : invs.slice(0, 3)).map(i => (
              <button key={i.id} type='button' title='View challans on this invoice' onClick={ev => { ev.stopPropagation(); setViewInvoiceId(i.id) }}
                style={{ background: 'none', border: 'none', padding: 0, color: C.accent, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px' }}>{i.invoice_no || '(no number)'}</button>
            ))}
            {invs.length > 3 && (
              <button type='button' onClick={ev => { ev.stopPropagation(); setMoreInvoices(s => { const n = new Set(s); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n }) }}
                style={{ background: 'none', border: 'none', padding: 0, color: C.textMuted, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px' }}>{all ? 'show less' : `+${invs.length - 3} more`}</button>
            )}
          </span>
        )
      } },
    { label: 'Vendor',   render: e => <span style={{ fontSize: '12px', color: C.textSoft }}>{e.vendor?.short_name || e.vendor?.name || e.vendor_name || '—'}{e.is_rcm && <span style={{ marginLeft: '6px' }}><Badge status='rcm' label='RCM' /></span>}</span> },
    { label: 'Total',    right: true, render: e => <span style={{ fontWeight: 600 }}>{formatINR(e.total_amount)}</span> },
    { label: 'Status',   render: e => <Badge status={e.status} /> },
    // CHANGED: the Docs column (and its + Doc upload) is no longer shown on this list. Documents already uploaded are untouched.
    // CHANGED: per-row edit — anyone who can see the expense; the database still decides who may save
    { label: '', render: e => <Btn size='sm' variant='ghost' onClick={ev => { ev.stopPropagation(); openEdit(e) }}>Edit</Btn> },
    // CHANGED: per-row delete, master-only
    ...(canDelete ? [{
      label: '', render: e => <Btn size='sm' variant='ghost' onClick={ev => { ev.stopPropagation(); setConfirmDelete(e) }} style={{ color: C.danger }}>Delete</Btn>,
    }] : []),
  ]

  return (
    <div>
      <PageHeader title='Expenses' subtitle='All costs associated with orders and entities'
        action={tab === 'Expenses' ? <Btn onClick={openNew}>+ New Expense</Btn> : undefined}
      />

      {/* CHANGED: tab shell — expense list, party settlements, and entity-wise summary */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: `2px solid ${C.border}` }}>
        {['Expenses', 'Party Payments', 'RCM Register', 'Summary'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontWeight: tab === t ? 700 : 500, fontSize: '13px',
            color: tab === t ? C.text : C.textSoft, background: 'transparent',
            borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: '-2px', transition: 'all 0.15s',
          }}>{t}</button>
        ))}
      </div>

      {tab === 'Party Payments' && (
        <PartyPayments entities={accessEntities} parties={parties} expenses={expenses} canDelete={canDelete} defaultEntityId={defaultEntityId} />
      )}
      {tab === 'RCM Register' && (
        <RcmRegister expenses={expenses} onChange={load} />
      )}
      {tab === 'Summary' && (
        <ExpenseSummary expenses={expenses} parties={parties} loading={loading} />
      )}

      {tab === 'Expenses' && (<>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Unpaid' value={formatINR(totalUnpaid)} color={C.warning} />
        <StatCard label='Paid'   value={formatINR(totalPaid)} color={C.success} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search vendor invoice no, description, entity…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit' }} />
        <MultiSelectDropdown options={entityOptions} selected={entityFilter} onChange={setEntityFilter} placeholder='All entities' capitalize={false} />
        <MultiSelectDropdown options={categories} selected={typeFilter} onChange={setType} placeholder='All types' capitalize={false} />
        <MultiSelectDropdown options={orderOptions} selected={orderFilter} onChange={setOrderFilter} placeholder='All orders' capitalize={false} />
        <input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} title='Expense date from'
          style={{ padding: '8px 10px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }} />
        <input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} title='Expense date to'
          style={{ padding: '8px 10px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }} />
        {!!anyFilter && <Btn size='sm' variant='ghost' onClick={clearFilters}>Clear filters</Btn>}
        <Btn variant='ghost' onClick={() => { if (!exportRows('expenses', filtered, e => ({ type: e.expense_type || e.category || '', challans: (challanLinks.byExpense[e.id] || []).join(', '), invoices: invoicesOf(e).map(i => i.invoice_no).filter(Boolean).join(', ') }))) setToast({ message: 'Nothing to export', type: 'error' }) }}>↓ Export CSV</Btn>
      </div>

      {/* CHANGED: bulk-selection action bar, same pattern as PI/PO/Invoices */}
      {canDelete && selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff3cc', border: '1px solid #e8d89a', borderRadius: '6px', padding: '8px 14px', marginBottom: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{selected.size} expense{selected.size > 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn size='sm' variant='ghost' onClick={() => setSelected(new Set())}>Clear</Btn>
            <Btn size='sm' variant='danger' onClick={() => setConfirmBulkDelete(true)} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : 'Delete Selected'}</Btn>
          </div>
        </div>
      )}

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered}
              emptyState={<EmptyState icon='📊' title='No expenses' action={<Btn onClick={openNew}>+ New Expense</Btn>} />} />
        }
      </Card>
      </>)}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editingExpense ? `Edit Expense${expenseLabel(editingExpense) ? ` — ${expenseLabel(editingExpense)}` : ''}` : 'New Expense'} width={600}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Date' required>
              <Input type='date' value={form.expense_date} onChange={e => setExpenseDate(e.target.value)} />
            </FormRow>
            <FormRow label='Entity' required hint={entityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)} disabled={entityFrozen}>
                <option value=''>Select entity</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Expense Type' required
              action={canManageCategories
                ? <button type='button' onClick={() => setCatModalOpen(true)}
                    style={{ background: 'none', border: 'none', color: C.accent, fontSize: '11px', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>Manage</button>
                : undefined}>
              <Select value={form.expense_type} onChange={e => setF('expense_type', e.target.value)}>
                <option value=''>Select category</option>
                {categories.map(t => <option key={t} value={t}>{t}</option>)}
                {/* CHANGED: keep a custom value visible even if it was later retired from the master list */}
                {form.expense_type && !categories.includes(form.expense_type) && <option value={form.expense_type}>{form.expense_type}</option>}
              </Select>
            </FormRow>
            <FormRow label='Status'>
              <Select value={form.status} onChange={e => setF('status', e.target.value)}>
                <option value='unpaid'>Unpaid</option>
                <option value='paid'>Paid</option>
              </Select>
            </FormRow>
          </div>
          {/* CHANGED: freight-type expenses pick the transporter challan(s) they pay for */}
          {showChallans && (
            <FormRow label='Challans' hint='Optional — select every challan this freight bill covers. Invoices and orders are linked from them.'>
              <ChallanPicker groups={pickerGroups} selected={selChallans} onChange={changeChallans}
                linkedByKey={linkedElsewhere} loading={challanLoading} error={challanError} />
              {selChallans.length > 0 && (
                <div style={{ fontSize: '12px', color: C.textSoft, lineHeight: 1.5, marginTop: '2px' }}>
                  <div><strong>Invoices:</strong> {challanLinked.invoices.map(i => i.invoice_no || '(no number)').join(', ') || '—'}</div>
                  <div><strong>Orders:</strong> {challanLinked.orders.map(o => o.name).join(', ') || '—'}</div>
                </div>
              )}
            </FormRow>
          )}
          <FormRow label='Description' required>
            <Input value={form.description} onChange={e => setF('description', e.target.value)} placeholder='What is this expense for?' />
          </FormRow>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='exp_is_rcm' checked={form.is_rcm}
              onChange={e => setF('is_rcm', e.target.checked)}
              style={{ width: '15px', height: '15px', cursor: 'pointer' }} />
            <label htmlFor='exp_is_rcm' style={{ fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
              Reverse Charge (RCM) — vendor bills with no GST
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Amount (₹)' required>
              <Input type='number' value={form.amount} onChange={e => setF('amount', e.target.value)} placeholder='0.00' />
            </FormRow>
            {form.is_rcm ? (
              <FormRow label='RCM GST %' hint='Self-assessed — payable to govt, not the vendor'>
                <Select value={form.rcm_gst_rate} onChange={e => setF('rcm_gst_rate', e.target.value)}>
                  <option value=''>Select rate</option>
                  {GST_RATES.filter(r => r > 0).map(r => <option key={r} value={r}>{r}%</option>)}
                </Select>
              </FormRow>
            ) : (
              <FormRow label='GST %'>
                <Select value={form.gst_rate} onChange={e => setF('gst_rate', e.target.value)}>
                  {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </Select>
              </FormRow>
            )}
          </div>
          {previewAmount > 0 && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 14px', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: C.textSoft }}>{form.is_rcm ? 'Payable to vendor (no GST)' : 'Total incl. GST'}</span>
                <span style={{ fontWeight: 700 }}>{formatINR(previewTotal)}</span>
              </div>
              {form.is_rcm && previewRcmGST > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.warning }}>RCM GST payable to govt (not to vendor)</span>
                  <span style={{ fontWeight: 700, color: C.warning }}>{formatINR(previewRcmGST)}</span>
                </div>
              )}
            </div>
          )}
          <SectionDivider label='Party / Vendor' />
          {/* CHANGED: pick from the global party master — auto-fills GSTIN and the
              payment due date. Master/admin can add a new party inline. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Party' hint={form.party_id && parties.find(p => p.id === form.party_id)?.payment_terms ? `Terms: ${parties.find(p => p.id === form.party_id).payment_terms}` : undefined}
              action={canDelete
                ? <button type='button' onClick={() => setPartyModalOpen(true)}
                    style={{ background: 'none', border: 'none', color: C.accent, fontSize: '11px', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>+ Add party</button>
                : undefined}>
              <Select value={form.party_id} onChange={e => selectParty(e.target.value)}>
                <option value=''>No party / one-off</option>
                {parties.map(p => <option key={p.id} value={p.id}>{p.name}{p.gstin ? ` · ${p.gstin}` : ''}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Payment Due'
              hint={form.due_date ? (() => {
                const diff = Math.ceil((new Date(`${form.due_date}T00:00:00`) - new Date(new Date().toDateString())) / 86400000)
                return diff >= 0 ? `${diff} day${diff === 1 ? '' : 's'} left` : `${-diff} day${diff === -1 ? '' : 's'} overdue`
              })() : undefined}>
              <Input type='date' value={form.due_date} onChange={e => setF('due_date', e.target.value)} />
            </FormRow>
          </div>
          {/* CHANGED: the vendor's own bill number + date — the main identifier for the expense */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Vendor Invoice No' hint={editingExpense?.expense_no ? `Main reference — system no ${editingExpense.expense_no}` : 'Main reference — the number on the vendor\'s bill'}>
              <Input value={form.vendor_invoice_no} onChange={e => setF('vendor_invoice_no', e.target.value)} />
            </FormRow>
            <FormRow label='Vendor Invoice Date'>
              <Input type='date' value={form.vendor_invoice_date} onChange={e => setF('vendor_invoice_date', e.target.value)} />
            </FormRow>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Vendor (In System)' hint='Optional — only if the vendor is one of your own entities'>
              <Select value={form.vendor_entity_id} onChange={e => setF('vendor_entity_id', e.target.value)}>
                <option value=''>External vendor</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            {!form.vendor_entity_id && (
              <FormRow label='Vendor Name'>
                <Input value={form.vendor_name} onChange={e => setF('vendor_name', e.target.value)} />
              </FormRow>
            )}
            <FormRow label='Vendor GSTIN' error={!isValidGSTIN(form.vendor_gstin) ? GSTIN_ERROR : undefined}>
              <Input value={form.vendor_gstin} onChange={e => setF('vendor_gstin', e.target.value.toUpperCase())} />
            </FormRow>
          </div>
          <SectionDivider label='Link to Order' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Order'>
              <Select value={form.order_id} onChange={e => setOrder(e.target.value)}>
                <option value=''>No order</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </FormRow>
            {/* CHANGED: dynamic invoice dropdown — only appears once an order is
                linked, and lists just that order's invoices to tag the expense. */}
            {form.order_id && (
              <FormRow label='Invoice' hint={!loadingInvoices && orderInvoices.length === 0 ? 'No invoices under this order yet' : undefined}>
                <Select value={form.invoice_id} onChange={e => setF('invoice_id', e.target.value)} disabled={loadingInvoices || orderInvoices.length === 0}>
                  <option value=''>{loadingInvoices ? 'Loading…' : 'No invoice'}</option>
                  {orderInvoices.map(iv => (
                    <option key={iv.id} value={iv.id}>{iv.invoice_no || '(no number)'}{iv.total_amount ? ` · ${formatINR(iv.total_amount)}` : ''}</option>
                  ))}
                </Select>
              </FormRow>
            )}
          </div>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editingExpense ? 'Save Changes' : 'Save Expense'}</Btn>
          </div>
        </div>
      </Modal>

      {/* CHANGED: category manager — add custom categories, retire junk ones. Master-only. */}
      <Modal open={catModalOpen} onClose={() => { setCatModalOpen(false); setNewCatName('') }} title='Manage Expense Categories' width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Add a category'>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Input value={newCatName} onChange={e => setNewCatName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory() } }}
                placeholder='e.g. Customs Clearance' />
              <Btn onClick={addCategory} disabled={savingCat || !newCatName.trim()}>{savingCat ? 'Adding…' : 'Add'}</Btn>
            </div>
          </FormRow>
          <SectionDivider label='Current categories' />
          {categoryRows.length === 0
            ? <div style={{ fontSize: '13px', color: C.textMuted }}>No categories yet.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflowY: 'auto' }}>
                {categoryRows.map(cat => (
                  <div key={cat.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: '6px', background: C.surface }}>
                    <span style={{ fontSize: '13px' }}>{cat.name}</span>
                    <Btn size='sm' variant='ghost' onClick={() => retireCategory(cat)} style={{ color: C.danger }}>Remove</Btn>
                  </div>
                ))}
              </div>
          }
          <div style={{ fontSize: '11px', color: C.textMuted, lineHeight: 1.4 }}>
            Removing a category only hides it from future dropdowns — expenses already recorded under it keep their label.
          </div>
        </div>
      </Modal>

      {/* CHANGED: quick-add party from the expense tool (master/admin). Full editing lives in Settings › Parties. */}
      <Modal open={partyModalOpen} onClose={() => setPartyModalOpen(false)} title='Add Party' width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Name' required>
            <Input value={partyForm.name} onChange={e => setPartyForm(f => ({ ...f, name: e.target.value }))} placeholder='Full legal / trade name' />
          </FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='GSTIN' error={!isValidGSTIN(partyForm.gstin) ? GSTIN_ERROR : undefined}><Input value={partyForm.gstin} onChange={e => setPartyForm(f => ({ ...f, gstin: e.target.value.toUpperCase() }))} placeholder='22AAAAA0000A1Z5' style={{ fontFamily: 'monospace' }} /></FormRow>
            <FormRow label='PAN' error={!isValidPAN(partyForm.pan) ? PAN_ERROR : undefined}><Input value={partyForm.pan} onChange={e => setPartyForm(f => ({ ...f, pan: e.target.value.toUpperCase() }))} placeholder='AAAAA0000A' style={{ fontFamily: 'monospace' }} /></FormRow>
            <FormRow label='Phone'><Input value={partyForm.phone} onChange={e => setPartyForm(f => ({ ...f, phone: e.target.value }))} /></FormRow>
            <FormRow label='Payment Days' hint='Days to due date'><Input type='number' value={partyForm.payment_days} onChange={e => setPartyForm(f => ({ ...f, payment_days: e.target.value }))} placeholder='e.g. 30' /></FormRow>
          </div>
          <FormRow label='Payment Terms' hint='Optional label, e.g. "Net 30"'><Input value={partyForm.payment_terms} onChange={e => setPartyForm(f => ({ ...f, payment_terms: e.target.value }))} /></FormRow>
          <div style={{ fontSize: '11px', color: C.textMuted }}>This party becomes available across all entities. Add more details later in Settings › Parties.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setPartyModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleAddParty} disabled={savingParty}>{savingParty ? 'Saving…' : 'Add Party'}</Btn>
          </div>
        </div>
      </Modal>

      {/* CHANGED: delete confirmation modals */}
      <ConfirmModal open={confirmBulkDelete} onClose={() => setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Expenses' message={`Delete ${selected.size} selected expense(s)? This cannot be undone.`} danger />
      {/* CHANGED: disable + relabel Confirm while the delete is in flight — 'deleting' was tracked but never wired to the button, so a slow request could be double-fired by a second click */}
      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Expense' message={`Delete "${confirmDelete?.description || 'this expense'}"? This cannot be undone.`} danger
        confirmDisabled={deleting} confirmLabel={deleting ? 'Deleting…' : 'Confirm'} />

      {/* CHANGED: invoice → challans → challan details popup */}
      {viewInvoiceId && <InvoiceChallansModal invoiceId={viewInvoiceId} onClose={() => setViewInvoiceId(null)} />}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Party Payments tab ─────────────────────────────────────────────────────────
// Settlements actually paid to a party, entity-scoped (RLS: has_entity_grant).
// Feeds the Reports → Party Ledger credit side.
const EMPTY_PP = {
  entity_id: '', party_id: '', expense_id: '', payment_date: today(),
  basis: '', mode: 'bank', reference: '', notes: '',
  // CHANGED: TDS/TCS now lives here — decided when the party is actually
  // paid, not when the expense was booked (see CATEGORY_TDS/suggestTds above).
  apply_tds: false, tds_section: '', tds_rate: '',
  apply_tcs: false, tcs_section: '', tcs_rate: '',
}

function PartyPayments({ entities, parties, expenses, canDelete, defaultEntityId }) {
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_PP)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('party_payments')
      .select('*, entity:entity_id(name,short_name), party:party_id(name)')
      .eq('is_deleted', false).order('payment_date', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function openNew()  { setEditing(null); setForm({ ...EMPTY_PP, entity_id: defaultEntityId || '' }); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({
      entity_id: r.entity_id || '', party_id: r.party_id || '', expense_id: r.expense_id || '',
      payment_date: r.payment_date || today(),
      basis: String(toNum(r.amount) + toNum(r.tds_amount)), // reconstruct the gross settle amount, same as invoice_payments
      mode: r.mode || 'bank', reference: r.reference || '', notes: r.notes || '',
      apply_tds: !!toNum(r.tds_amount), tds_section: r.tds_section || '', tds_rate: r.tds_rate != null ? String(r.tds_rate) : '',
      apply_tcs: !!toNum(r.tcs_amount), tcs_section: r.tcs_section || '', tcs_rate: r.tcs_rate != null ? String(r.tcs_rate) : '',
    })
    setModalOpen(true)
  }

  // Only the expenses for the chosen entity+party can be settled here.
  const linkableExpenses = expenses.filter(e => e.entity_id === form.entity_id && e.party_id === form.party_id)

  // CHANGED: selecting an expense to settle prefills the gross settle amount
  // and auto-suggests TDS from that expense's category — the same suggestion
  // that used to fire on the expense form itself, just triggered at the
  // moment it should actually apply (payment time).
  function selectExpense(id) {
    const ex = linkableExpenses.find(e => e.id === id)
    setForm(f => {
      const next = { ...f, expense_id: id }
      if (ex) {
        next.basis = String(ex.total_amount || '')
        const s = suggestTds(ex.expense_type || ex.category)
        if (s && !f.tds_section && !f.tds_rate) { next.apply_tds = true; next.tds_section = s.section; next.tds_rate = String(s.rate) }
      }
      return next
    })
  }

  const basisAmount = toNum(form.basis)
  const tdsAmount   = form.apply_tds ? roundRupees(round2(basisAmount * (Number(form.tds_rate) || 0) / 100)) : 0
  const tcsAmount   = form.apply_tcs ? roundRupees(round2(basisAmount * (Number(form.tcs_rate) || 0) / 100)) : 0
  // CHANGED: same correctness rule as invoice_payments — TDS reduces what's
  // actually paid (still "settles" the expense, withheld on the vendor's
  // behalf); TCS is a separate collection on top, tracked in its own column,
  // never folded into the persisted `amount`.
  const cashAmount  = Math.max(0, roundRupees(basisAmount - tdsAmount))
  const totalCashThisTranche = cashAmount + tcsAmount

  async function handleSave() {
    if (!form.entity_id || !form.party_id) return setToast({ message: 'Entity and party are required', type: 'error' })
    if (!basisAmount) return setToast({ message: 'Settle amount is required', type: 'error' })
    setSaving(true)
    const fy = await resolveFY()
    const payload = {
      entity_id: form.entity_id, party_id: form.party_id,
      expense_id: form.expense_id || null, financial_year_id: fy?.id || null,
      payment_date: form.payment_date, amount: cashAmount, mode: form.mode || null,
      reference: form.reference || null, notes: form.notes || null,
      tds_section: form.apply_tds ? (form.tds_section || null) : null,
      tds_rate: form.apply_tds ? (toNum(form.tds_rate) || 0) : 0,
      tds_base_amount: form.apply_tds ? basisAmount : 0,
      tds_amount: tdsAmount,
      tcs_section: form.apply_tcs ? (form.tcs_section || null) : null,
      tcs_rate: form.apply_tcs ? (toNum(form.tcs_rate) || 0) : 0,
      tcs_base_amount: form.apply_tcs ? basisAmount : 0,
      tcs_amount: tcsAmount,
    }
    const res = editing
      ? await supabase.from('party_payments').update(payload).eq('id', editing.id)
      : await supabase.from('party_payments').insert(payload)
    setSaving(false)
    if (res.error) return setToast({ message: res.error.message, type: 'error' })
    setModalOpen(false)
    setToast({ message: editing ? 'Payment updated' : 'Payment recorded', type: 'success' })
    load()
  }
  async function handleDelete() {
    if (!confirmDelete) return
    const { error } = await supabase.from('party_payments').update({ is_deleted: true }).eq('id', confirmDelete.id)
    if (error) setToast({ message: error.message, type: 'error' })
    else setToast({ message: 'Payment deleted', type: 'success' })
    setConfirmDelete(null)
    load()
  }

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)
  const columns = [
    { label: 'S.No.', render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Date',   render: r => <span style={{ fontSize: '12px' }}>{fmtDate(r.payment_date)}</span> },
    { label: 'Entity', render: r => <span style={{ fontSize: '12px' }}>{r.entity?.short_name || r.entity?.name || '—'}</span> },
    { label: 'Party',  render: r => <span style={{ fontSize: '12px', fontWeight: 600 }}>{r.party?.name || '—'}</span> },
    { label: 'Amount', right: true, render: r => <span style={{ fontWeight: 600 }}>{formatINR(r.amount)}</span> },
    { label: 'TDS/TCS', right: true, render: r => (r.tds_amount || r.tcs_amount)
        ? <span style={{ fontSize: '12px', color: C.textSoft }}>{r.tds_amount ? `TDS ${formatINR(r.tds_amount)}` : ''}{r.tds_amount && r.tcs_amount ? ' / ' : ''}{r.tcs_amount ? `TCS ${formatINR(r.tcs_amount)}` : ''}</span>
        : <span style={{ color: C.textMuted }}>—</span> },
    { label: 'Mode',   render: r => <span style={{ fontSize: '12px', color: C.textSoft, textTransform: 'capitalize' }}>{r.mode || '—'}</span> },
    { label: 'Ref',    render: r => <span style={{ fontSize: '12px', color: C.textSoft }}>{r.reference || '—'}</span> },
    ...(canDelete ? [{ label: 'Actions', render: r => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Delete</Btn>
      </div>
    )}] : []),
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <StatCard label='Total Paid to Parties' value={formatINR(total)} />
        <Btn variant='ghost' onClick={() => { if (!exportRows('party_payments', rows)) setToast({ message: 'Nothing to export', type: 'error' }) }}>↓ Export CSV</Btn>
        <Btn onClick={openNew}>+ Record Payment</Btn>
      </div>
      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={rows}
              emptyState={<EmptyState icon='💸' title='No party payments yet' action={<Btn onClick={openNew}>+ Record Payment</Btn>} />} />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Payment' : 'Record Party Payment'} width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Entity' required>
              <Select value={form.entity_id} onChange={e => setForm(f => ({ ...f, entity_id: e.target.value, expense_id: '' }))}>
                <option value=''>Select entity</option>
                {entities.map(en => <option key={en.id} value={en.id}>{en.short_name || en.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Party' required>
              <Select value={form.party_id} onChange={e => setForm(f => ({ ...f, party_id: e.target.value, expense_id: '' }))}>
                <option value=''>Select party</option>
                {parties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Payment Date' required>
              <Input type='date' value={form.payment_date} onChange={e => setF('payment_date', e.target.value)} />
            </FormRow>
            <FormRow label='Settle Amount (₹)' required hint='Gross amount before any TDS/TCS'>
              <Input type='number' value={form.basis} onChange={e => setF('basis', e.target.value)} placeholder='0' />
            </FormRow>
            <FormRow label='Mode'>
              <Select value={form.mode} onChange={e => setF('mode', e.target.value)}>
                <option value='bank'>Bank Transfer</option>
                <option value='cash'>Cash</option>
                <option value='upi'>UPI</option>
                <option value='cheque'>Cheque</option>
              </Select>
            </FormRow>
            <FormRow label='Reference' hint='UTR / cheque no'>
              <Input value={form.reference} onChange={e => setF('reference', e.target.value)} />
            </FormRow>
          </div>
          {form.entity_id && form.party_id && (
            <FormRow label='Against Expense' hint={linkableExpenses.length === 0 ? 'No expenses for this entity + party' : 'Selecting one prefills the settle amount and suggests TDS from its category'}>
              <Select value={form.expense_id} onChange={e => selectExpense(e.target.value)} disabled={linkableExpenses.length === 0}>
                <option value=''>General / on account</option>
                {linkableExpenses.map(ex => (
                  <option key={ex.id} value={ex.id}>{expenseLabel(ex) || ex.description} · {formatINR(ex.total_amount)}</option>
                ))}
              </Select>
            </FormRow>
          )}

          {/* CHANGED: TDS/TCS decided here, at payment time — not on the expense form. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='pp_apply_tds' checked={form.apply_tds} onChange={e => setF('apply_tds', e.target.checked)} style={{ width: '15px', height: '15px', cursor: 'pointer' }} />
            <label htmlFor='pp_apply_tds' style={{ fontSize: '13px', fontWeight: 600, color: C.text, cursor: 'pointer' }}>Deduct TDS from this payment</label>
          </div>
          {form.apply_tds && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px' }}>
              <FormRow label='TDS Section'><Input value={form.tds_section} onChange={e => setF('tds_section', e.target.value)} placeholder='e.g. 194C' /></FormRow>
              <FormRow label='TDS Rate %'><Input type='number' step='0.01' value={form.tds_rate} onChange={e => setF('tds_rate', e.target.value)} /></FormRow>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='pp_apply_tcs' checked={form.apply_tcs} onChange={e => setF('apply_tcs', e.target.checked)} style={{ width: '15px', height: '15px', cursor: 'pointer' }} />
            <label htmlFor='pp_apply_tcs' style={{ fontSize: '13px', fontWeight: 600, color: C.text, cursor: 'pointer' }}>Collect TCS on this payment</label>
          </div>
          {form.apply_tcs && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px' }}>
              <FormRow label='TCS Section'><Input value={form.tcs_section} onChange={e => setF('tcs_section', e.target.value)} placeholder='e.g. 206C' /></FormRow>
              <FormRow label='TCS Rate %'><Input type='number' step='0.01' value={form.tcs_rate} onChange={e => setF('tcs_rate', e.target.value)} /></FormRow>
            </div>
          )}
          {basisAmount > 0 && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', display: 'grid', gridTemplateColumns: `repeat(${tcsAmount > 0 ? 4 : 2},1fr)`, gap: '8px', fontSize: '13px' }}>
              <div>
                <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>Settling</div>
                <strong>{formatINR(basisAmount)}</strong>
              </div>
              {tdsAmount > 0 && (
                <div>
                  <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>TDS Deducted</div>
                  <strong style={{ color: C.warning }}>− {formatINR(tdsAmount)}</strong>
                </div>
              )}
              {tcsAmount > 0 && (
                <div>
                  <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>TCS Collected</div>
                  <strong style={{ color: C.warning }}>+ {formatINR(tcsAmount)}</strong>
                </div>
              )}
              <div>
                <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>{tcsAmount > 0 ? 'Applied to Expense' : 'Amount to be Paid'}</div>
                <strong style={{ color: C.success }}>{formatINR(cashAmount)}</strong>
              </div>
              {tcsAmount > 0 && (
                <div>
                  <div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, marginBottom: '2px' }}>Total Cash This Tranche</div>
                  <strong style={{ color: C.success }}>{formatINR(totalCashThisTranche)}</strong>
                </div>
              )}
            </div>
          )}
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Record Payment'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Payment' message={`Delete this ${formatINR(confirmDelete?.amount || 0)} payment?`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── RCM Register tab ───────────────────────────────────────────────────────
// Full RCM ledger: liability (computed at booking, from is_rcm/rcm_gst_rate/
// rcm_gst_amount on the expense itself — migration 050), paid-to-govt
// date/ref (GSTR-3B cash ledger — a manual real-world action recorded here),
// and ITC-claimed date/ref (claimable only once paid). Rows are derived from
// `expenses` (already loaded + RLS-scoped by the parent) — no separate fetch.
function RcmRegister({ expenses, onChange }) {
  const rows = (expenses || []).filter(e => e.is_rcm)
  const [markModal, setMarkModal] = useState(null) // { row, kind: 'paid' | 'claimed' }
  const [date, setDate] = useState(today())
  const [ref, setRef]   = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  function openMark(row, kind) {
    setMarkModal({ row, kind })
    setDate((kind === 'paid' ? row.rcm_paid_date : row.rcm_itc_claimed_date) || today())
    setRef((kind === 'paid' ? row.rcm_paid_ref : row.rcm_itc_claim_ref) || '')
  }
  async function confirmMark() {
    setSaving(true)
    const patch = markModal.kind === 'paid'
      ? { rcm_paid_date: date, rcm_paid_ref: ref || null }
      : { rcm_itc_claimed_date: date, rcm_itc_claim_ref: ref || null }
    const { error } = await supabase.from('expenses').update(patch).eq('id', markModal.row.id)
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setMarkModal(null)
    setToast({ message: markModal.kind === 'paid' ? 'Marked paid to govt' : 'Marked ITC claimed', type: 'success' })
    onChange()
  }

  const totalLiability = rows.reduce((s, r) => s + (r.rcm_gst_amount || 0), 0)
  const totalPaid    = rows.filter(r => r.rcm_paid_date).reduce((s, r) => s + (r.rcm_gst_amount || 0), 0)
  const totalClaimed = rows.filter(r => r.rcm_itc_claimed_date).reduce((s, r) => s + (r.rcm_gst_amount || 0), 0)

  const columns = [
    { label: 'Date',   render: r => <span style={{ fontSize: '12px' }}>{fmtDate(r.expense_date)}</span> },
    { label: 'Entity', render: r => <span style={{ fontSize: '12px' }}>{r.entity?.short_name || r.entity?.name}</span> },
    { label: 'Vendor', render: r => <span style={{ fontSize: '12px' }}>{r.vendor?.short_name || r.vendor?.name || r.vendor_name || '—'}</span> },
    { label: 'Taxable', right: true, render: r => formatINR(r.amount) },
    { label: 'RCM %',   right: true, render: r => `${r.rcm_gst_rate ?? 0}%` },
    { label: 'RCM Liability', right: true, render: r => <span style={{ fontWeight: 600 }}>{formatINR(r.rcm_gst_amount)}</span> },
    { label: 'Paid to Govt', render: r => r.rcm_paid_date
        ? <Btn size='sm' variant='ghost' onClick={() => openMark(r, 'paid')}>{fmtDate(r.rcm_paid_date)}</Btn>
        : <Btn size='sm' onClick={() => openMark(r, 'paid')}>Mark Paid</Btn> },
    { label: 'ITC Claimed', render: r => r.rcm_itc_claimed_date
        ? <Btn size='sm' variant='ghost' onClick={() => openMark(r, 'claimed')}>{fmtDate(r.rcm_itc_claimed_date)}</Btn>
        : <Btn size='sm' disabled={!r.rcm_paid_date} onClick={() => openMark(r, 'claimed')}>Mark Claimed</Btn> },
  ]

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='RCM Liability' value={formatINR(totalLiability)} />
        <StatCard label='Paid to Govt' value={formatINR(totalPaid)} color={C.success} />
        <StatCard label='Pending to Pay' value={formatINR(totalLiability - totalPaid)} color={totalLiability - totalPaid > 0 ? C.danger : C.success} />
        <StatCard label='ITC Claimed' value={formatINR(totalClaimed)} color={C.success} />
        <StatCard label='Pending to Claim' value={formatINR(totalPaid - totalClaimed)} color={totalPaid - totalClaimed > 0 ? C.warning : C.textMuted} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <Btn variant='ghost' onClick={() => { if (!exportRows('rcm_register', rows)) setToast({ message: 'Nothing to export', type: 'error' }) }}>↓ Export CSV</Btn>
      </div>
      <Card>
        <Table columns={columns} rows={rows}
          emptyState={<EmptyState icon='🔄' title='No RCM expenses yet' />} />
      </Card>
      <Modal open={!!markModal} onClose={() => setMarkModal(null)}
        title={markModal?.kind === 'paid' ? 'Mark RCM Paid to Govt' : 'Mark RCM ITC Claimed'} width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Date' required><Input type='date' value={date} onChange={e => setDate(e.target.value)} /></FormRow>
          <FormRow label={markModal?.kind === 'paid' ? 'Challan / GSTR-3B ARN' : 'GSTR-3B period'} hint='Optional'>
            <Input value={ref} onChange={e => setRef(e.target.value)} placeholder={markModal?.kind === 'paid' ? 'e.g. ARN AB123...' : 'e.g. Aug-2026'} />
          </FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setMarkModal(null)}>Cancel</Btn>
            <Btn onClick={confirmMark} disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</Btn>
          </div>
        </div>
      </Modal>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Summary tab ────────────────────────────────────────────────────────────────
// Entity-wise expense summary. `expenses` (booked, gross) is already loaded and
// RLS-scoped by the parent; TDS/TCS and paid figures now live on party_payments
// (payment-time, per the same decision made for invoices), so this tab fetches
// its own copy — same self-contained pattern every Reports tab already uses.
function ExpenseSummary({ expenses, parties, loading }) {
  const [payments, setPayments]     = useState([])
  const [payLoading, setPayLoading] = useState(true)

  useEffect(() => {
    setPayLoading(true)
    supabase.from('party_payments')
      .select('id,entity_id,party_id,expense_id,amount,tds_amount,tcs_amount,payment_date,entity:entity_id(name,short_name)')
      .eq('is_deleted', false)
      .then(({ data }) => { setPayments(data || []); setPayLoading(false) })
  }, [])

  const partyName = Object.fromEntries((parties || []).map(p => [p.id, p.name]))

  // Booked (gross) side — from expenses.
  const byEntityBooked = new Map()
  const byCategory = new Map()
  for (const e of (expenses || [])) {
    const ek = e.entity?.short_name || e.entity?.name || '—'
    const en = byEntityBooked.get(ek) || { count: 0, taxable: 0, gst: 0, total: 0 }
    en.count++; en.taxable += e.amount || 0; en.gst += e.gst_amount || 0; en.total += e.total_amount || 0
    byEntityBooked.set(ek, en)

    const ck = e.expense_type || e.category || '—'
    const cc = byCategory.get(ck) || { count: 0, total: 0 }
    cc.count++; cc.total += e.total_amount || 0
    byCategory.set(ck, cc)
  }

  // Paid / withheld side — from party_payments (payment-time TDS/TCS).
  const byEntityPaid = new Map()
  const byParty = new Map()
  let totalPaid = 0, totalTds = 0
  for (const p of payments) {
    totalPaid += p.amount || 0
    totalTds  += p.tds_amount || 0
    const ek = p.entity?.short_name || p.entity?.name || '—'
    const en = byEntityPaid.get(ek) || { paid: 0, tds: 0 }
    en.paid += p.amount || 0; en.tds += p.tds_amount || 0
    byEntityPaid.set(ek, en)

    const pk = partyName[p.party_id] || '—'
    const pp = byParty.get(pk) || { count: 0, paid: 0, tds: 0 }
    pp.count++; pp.paid += p.amount || 0; pp.tds += p.tds_amount || 0
    byParty.set(pk, pp)
  }

  const totalBooked  = (expenses || []).reduce((s, e) => s + (e.total_amount || 0), 0)
  const outstanding  = totalBooked - totalPaid - totalTds

  const entityKeys = new Set([...byEntityBooked.keys(), ...byEntityPaid.keys()])
  const entityRows = [...entityKeys].map(k => {
    const b = byEntityBooked.get(k) || { count: 0, taxable: 0, gst: 0, total: 0 }
    const p = byEntityPaid.get(k) || { paid: 0, tds: 0 }
    return [k, { ...b, paid: p.paid, tds: p.tds, outstanding: b.total - p.paid - p.tds }]
  }).sort((a, b) => b[1].total - a[1].total)

  const catRows   = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total)
  const partyRows = [...byParty.entries()].sort((a, b) => b[1].paid - a[1].paid)

  const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em' }
  const td = { padding: '9px 12px', borderBottom: '1px solid #f0e8d8' }

  if (loading || payLoading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if ((expenses || []).length === 0) return <EmptyState icon='📊' title='No expenses to summarise' />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: '12px' }}>
        <StatCard label='Total Expenses (booked)' value={formatINR(totalBooked)} />
        <StatCard label='Total Paid' value={formatINR(totalPaid)} color={C.success} />
        <StatCard label='TDS Withheld' value={formatINR(totalTds)} color={totalTds > 0 ? C.warning : C.textMuted} />
        <StatCard label='Outstanding' value={formatINR(outstanding)} color={outstanding > 0 ? C.danger : C.success} />
      </div>

      <Card>
        <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>By Entity</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>Entity</th>
              <th style={{ ...th, textAlign: 'right' }}>Count</th>
              <th style={{ ...th, textAlign: 'right' }}>Taxable</th>
              <th style={{ ...th, textAlign: 'right' }}>GST</th>
              <th style={{ ...th, textAlign: 'right' }}>Total (booked)</th>
              <th style={{ ...th, textAlign: 'right' }}>Paid</th>
              <th style={{ ...th, textAlign: 'right' }}>TDS</th>
              <th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
            </tr></thead>
            <tbody>
              {entityRows.map(([name, v], i) => (
                <tr key={name} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                  <td style={{ ...td, fontWeight: 600 }}>{name}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{v.count}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{formatINR(v.taxable)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{formatINR(v.gst)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{formatINR(v.total)}</td>
                  <td style={{ ...td, textAlign: 'right', color: C.success }}>{formatINR(v.paid)}</td>
                  <td style={{ ...td, textAlign: 'right', color: v.tds > 0 ? C.warning : C.textMuted }}>{formatINR(v.tds)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: v.outstanding > 0 ? C.danger : C.success }}>{formatINR(v.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px,1fr))', gap: '16px' }}>
        <Card>
          <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>By Category (booked)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>Category</th>
                <th style={{ ...th, textAlign: 'right' }}>Count</th>
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
              </tr></thead>
              <tbody>
                {catRows.map(([name, v], i) => (
                  <tr key={name} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={{ ...td, textTransform: 'capitalize' }}>{name}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{v.count}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{formatINR(v.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <div style={{ padding: '12px 16px', fontWeight: 700, fontSize: '14px', borderBottom: `1px solid ${C.border}` }}>By Party (paid)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr>
                <th style={{ ...th, textAlign: 'left' }}>Party</th>
                <th style={{ ...th, textAlign: 'right' }}>Payments</th>
                <th style={{ ...th, textAlign: 'right' }}>Paid</th>
                <th style={{ ...th, textAlign: 'right' }}>TDS Withheld</th>
              </tr></thead>
              <tbody>
                {partyRows.length === 0
                  ? <tr><td colSpan={4} style={{ padding: '18px', textAlign: 'center', color: C.textMuted }}>No payments recorded yet.</td></tr>
                  : partyRows.map(([name, v], i) => (
                    <tr key={name} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{name}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{v.count}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: C.success }}>{formatINR(v.paid)}</td>
                      <td style={{ ...td, textAlign: 'right', color: v.tds > 0 ? C.warning : C.textMuted }}>{formatINR(v.tds)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  )
}
