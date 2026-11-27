import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../supabaseClient'
import { exportRows } from '../../utils/exportCsv'
import {
  C, Btn, MultiSelectDropdown, Modal, ConfirmModal, Toast, EmptyState,
  Card, FormRow, Input, Select, Textarea, StatCard,
} from '../../components/UI/index'
import { formatINR, formatNumberIN, toNum, round2 } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { fetchAllPages, excludeAutoPurchaseMirrors } from '../../utils/query'
import {
  computeInvoiceOutstanding, groupTranchesByInvoice, groupSettlementsByInvoice, settlementFor,
  pairSetoffs, nextJournalNo, syncInvoicesPaymentStatus,
} from '../../utils/payments'
import PickTable from './PickTable'

// ─── Journal (set-offs) ─────────────────────────────────────────────────────
// Knocks our sales to a party against that party's sales to us (our
// purchases), so both sides drop out of pending without any cash moving.
// Stored in invoice_setoffs (migration 064): one row per sales/purchase pair,
// rows of one voucher share journal_no. Set-offs made inside a payment carry
// payment_group_id and show here too.
//
// Editing a journal replaces its rows: the old rows are soft-deleted and the
// new ones saved under the same journal number.

const EMPTY = { entity_id: '', party_entity_id: '', journal_date: '', notes: '', sales: {}, purchases: {} }
const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '10px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', whiteSpace: 'nowrap' }
const td = { padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontSize: '12px', verticalAlign: 'middle' }

export default function Journal() {
  const { entities: accessEntities, defaultEntityId, loading: accessLoading } = useEntityAccess()
  const [setoffs, setSetoffs]   = useState([])
  const [tdsEntries, setTdsEntries] = useState([])
  const [invoices, setInvoices] = useState([])
  const [payments, setPayments] = useState([])
  const [entities, setEntities] = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null) // journal group being edited
  const [form, setForm]         = useState(EMPTY)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [entityFilter, setEntityFilter] = useState([])
  const [partyFilter, setPartyFilter]   = useState([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [o, t, inv, p, { data: es }] = await Promise.all([
      fetchAllPages(() => supabase.from('invoice_setoffs').select('*').eq('is_deleted', false).order('id')),
      fetchAllPages(() => supabase.from('tds_tcs_entries').select('id,invoice_id,entry_type,amount,is_deleted').eq('is_deleted', false).order('id')),
      fetchAllPages(() => excludeAutoPurchaseMirrors(supabase.from('invoices')
        .select('id,invoice_no,invoice_date,total_amount,status,seller_entity_id,buyer_entity_id')
        .eq('is_deleted', false).neq('status', 'cancelled')).order('id')),
      fetchAllPages(() => supabase.from('invoice_payments').select('id,invoice_id,amount,adjustments,payment_ref,payment_group_id').eq('is_deleted', false).order('id')),
      supabase.from('entities').select('id,name,short_name').eq('is_deleted', false).order('name'),
    ])
    const err = o.error || t.error || inv.error || p.error
    if (err) setToast({ message: err.message, type: 'error' })
    setSetoffs(o.data || [])
    setTdsEntries(t.data || [])
    setInvoices(inv.data || [])
    setPayments(p.data || [])
    setEntities(es || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (defaultEntityId && entityFilter.length === 0) setEntityFilter([defaultEntityId]) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps

  const entityMap  = useMemo(() => new Map(entities.map(e => [e.id, e])), [entities])
  const entName = id => entityMap.get(id)?.short_name || entityMap.get(id)?.name || '—'
  const invoiceMap = useMemo(() => new Map(invoices.map(i => [i.id, i])), [invoices])

  // Pending per invoice — same rule as everywhere else.
  const pendingById = useMemo(() => {
    const tranches = groupTranchesByInvoice(payments)
    const settle = groupSettlementsByInvoice(tdsEntries, setoffs)
    const m = new Map()
    for (const inv of invoices) m.set(inv.id, computeInvoiceOutstanding(inv, tranches.get(inv.id), settlementFor(settle, inv.id)).pending)
    return m
  }, [invoices, payments, tdsEntries, setoffs])

  const paymentRefByGroup = useMemo(() => {
    const m = new Map()
    for (const p of payments) if (p.payment_group_id && !m.get(p.payment_group_id)) m.set(p.payment_group_id, p.payment_ref || '')
    return m
  }, [payments])

  // ── Journals = set-off rows grouped by entity + journal_no ───────────────
  const journals = useMemo(() => {
    const m = new Map()
    for (const o of setoffs) {
      const key = `${o.entity_id}|${o.journal_no}`
      if (!m.has(key)) m.set(key, { key, journal_no: o.journal_no, journal_date: o.journal_date, entity_id: o.entity_id, party_entity_id: o.party_entity_id, notes: o.notes, payment_group_id: o.payment_group_id, rows: [], amount: 0 })
      const j = m.get(key)
      j.rows.push(o)
      j.amount = round2(j.amount + toNum(o.amount))
    }
    return [...m.values()].map(j => {
      const sum = side => {
        const acc = new Map()
        for (const r of j.rows) acc.set(r[side], round2((acc.get(r[side]) || 0) + toNum(r.amount)))
        return [...acc.entries()].map(([id, amount]) => ({ id, invoice_no: invoiceMap.get(id)?.invoice_no || '—', amount }))
      }
      return { ...j, sales: sum('sales_invoice_id'), purchases: sum('purchase_invoice_id') }
    })
  }, [setoffs, invoiceMap])

  const canSee = id => accessLoading || accessEntities.some(e => e.id === id)
  const filtered = journals.filter(j => {
    if (!canSee(j.entity_id) && !canSee(j.party_entity_id)) return false
    if (entityFilter.length && !entityFilter.includes(j.entity_id)) return false
    if (partyFilter.length && !partyFilter.includes(j.party_entity_id)) return false
    if (dateFrom && j.journal_date < dateFrom) return false
    if (dateTo && j.journal_date > dateTo) return false
    return true
  }).sort((a, b) => (b.journal_date || '').localeCompare(a.journal_date || '') || (b.journal_no || '').localeCompare(a.journal_no || ''))
  const totalSetoff = round2(filtered.reduce((s, j) => s + j.amount, 0))

  // ── Form ──────────────────────────────────────────────────────────────────
  // While editing, this journal's own amounts count as still pending.
  const ownAmount = useMemo(() => {
    const m = new Map()
    for (const r of (editing?.rows || [])) {
      m.set(r.sales_invoice_id, round2((m.get(r.sales_invoice_id) || 0) + toNum(r.amount)))
      m.set(r.purchase_invoice_id, round2((m.get(r.purchase_invoice_id) || 0) + toNum(r.amount)))
    }
    return m
  }, [editing])
  const pendingFor = id => round2((pendingById.get(id) || 0) + (ownAmount.get(id) || 0))

  const listFor = (sellerId, buyerId) => (!sellerId || !buyerId) ? [] : invoices
    .filter(i => i.seller_entity_id === sellerId && i.buyer_entity_id === buyerId && i.status !== 'draft' && pendingFor(i.id) > 0)
    .map(i => ({ ...i, _pending: pendingFor(i.id) }))
    .sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || ''))
  const salesList    = listFor(form.entity_id, form.party_entity_id)
  const purchaseList = listFor(form.party_entity_id, form.entity_id)

  // Parties with pending invoices in BOTH directions with this entity.
  const partyOptions = useMemo(() => {
    if (!form.entity_id) return []
    const sellTo = new Set(), buyFrom = new Set()
    for (const i of invoices) {
      if (pendingFor(i.id) <= 0 || i.status === 'draft') continue
      if (i.seller_entity_id === form.entity_id) sellTo.add(i.buyer_entity_id)
      if (i.buyer_entity_id === form.entity_id) buyFrom.add(i.seller_entity_id)
    }
    return entities.filter(e => sellTo.has(e.id) && buyFrom.has(e.id))
  }, [form.entity_id, invoices, entities, pendingById, ownAmount]) // eslint-disable-line react-hooks/exhaustive-deps

  function setF(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'entity_id') { u.party_entity_id = ''; u.sales = {}; u.purchases = {} }
      if (k === 'party_entity_id') { u.sales = {}; u.purchases = {} }
      return u
    })
  }
  const pick = side => (id, patch) => setForm(f => {
    const prev = f[side][id] || { checked: false, amount: '' }
    const next = { ...prev, ...patch }
    if (patch.checked === true && !prev.amount) next.amount = String(pendingFor(id))
    return { ...f, [side]: { ...f[side], [id]: next } }
  })

  const chosenSales = salesList.filter(i => form.sales[i.id]?.checked)
  const chosenPurch = purchaseList.filter(i => form.purchases[i.id]?.checked)
  const salesTotal = round2(chosenSales.reduce((s, i) => s + toNum(form.sales[i.id].amount), 0))
  const purchTotal = round2(chosenPurch.reduce((s, i) => s + toNum(form.purchases[i.id].amount), 0))

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY, entity_id: defaultEntityId || '', journal_date: today() })
    setModalOpen(true)
  }
  function openEdit(j) {
    setEditing(j)
    const toState = list => Object.fromEntries(list.map(x => [x.id, { checked: true, amount: String(x.amount) }]))
    setForm({
      entity_id: j.entity_id, party_entity_id: j.party_entity_id, journal_date: j.journal_date,
      notes: j.notes || '', sales: toState(j.sales), purchases: toState(j.purchases),
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.entity_id || !form.party_entity_id) return setToast({ message: 'Select the entity and the party', type: 'error' })
    if (!form.journal_date) return setToast({ message: 'Date is required', type: 'error' })
    if (!chosenSales.length || !chosenPurch.length) return setToast({ message: 'Tick at least one sales and one purchase invoice', type: 'error' })
    for (const [side, list] of [['sales', chosenSales], ['purchases', chosenPurch]]) {
      for (const i of list) {
        const a = toNum(form[side][i.id].amount)
        if (a <= 0) return setToast({ message: `Enter an amount for ${i.invoice_no}`, type: 'error' })
        if (a > i._pending + 0.5) return setToast({ message: `${i.invoice_no}: amount is more than its pending ${formatINR(i._pending)}`, type: 'error' })
      }
    }
    if (Math.abs(salesTotal - purchTotal) > 0.005) return setToast({ message: `Sales (${formatINR(salesTotal)}) and purchases (${formatINR(purchTotal)}) must be equal`, type: 'error' })

    setSaving(true)
    const pairs = pairSetoffs(
      chosenSales.map(i => ({ invoice_id: i.id, amount: form.sales[i.id].amount })),
      chosenPurch.map(i => ({ invoice_id: i.id, amount: form.purchases[i.id].amount })),
    )
    const journalNo = editing?.journal_no || await nextJournalNo(form.entity_id, entityMap.get(form.entity_id)?.short_name, form.journal_date)
    const oldIds = (editing?.rows || []).map(r => r.id)
    if (oldIds.length) {
      const { error } = await supabase.from('invoice_setoffs').update({ is_deleted: true, updated_at: new Date() }).in('id', oldIds)
      if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    }
    const { error } = await supabase.from('invoice_setoffs').insert(pairs.map(p => ({
      ...p, journal_no: journalNo, journal_date: form.journal_date,
      entity_id: form.entity_id, party_entity_id: form.party_entity_id,
      payment_group_id: editing?.payment_group_id || null, notes: form.notes || null,
    })))
    if (error) {
      // Put the old rows back so an edit never loses the journal.
      if (oldIds.length) await supabase.from('invoice_setoffs').update({ is_deleted: false }).in('id', oldIds)
      setSaving(false)
      return setToast({ message: error.message, type: 'error' })
    }
    const touched = [...chosenSales.map(i => i.id), ...chosenPurch.map(i => i.id), ...(editing?.rows || []).flatMap(r => [r.sales_invoice_id, r.purchase_invoice_id])]
    const { error: syncErr } = await syncInvoicesPaymentStatus(touched)
    setSaving(false)
    setToast(syncErr
      ? { message: `Saved, but an invoice status could not be updated: ${syncErr.message}`, type: 'error' }
      : { message: `${journalNo} ${editing ? 'updated' : 'saved'} — ${formatINR(salesTotal)} set off`, type: 'success' })
    setModalOpen(false); load()
  }

  async function handleDelete() {
    const j = confirmDelete
    const { error } = await supabase.from('invoice_setoffs').update({ is_deleted: true, updated_at: new Date() }).in('id', j.rows.map(r => r.id))
    if (error) setToast({ message: error.message, type: 'error' })
    else await syncInvoicesPaymentStatus(j.rows.flatMap(r => [r.sales_invoice_id, r.purchase_invoice_id]))
    setConfirmDelete(null); load()
  }

  const invList = list => list.map(x => x.invoice_no).join(', ')
  const sourceLabel = j => {
    if (!j.payment_group_id) return 'Journal'
    const ref = paymentRefByGroup.get(j.payment_group_id)
    return ref ? `Payment ${ref}` : 'Payment'
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Journals' value={filtered.length} />
        <StatCard label='Total set off' value={formatINR(totalSetoff)} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: '130px' }}><FormRow label='From Date'><Input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></FormRow></div>
        <div style={{ width: '130px' }}><FormRow label='To Date'><Input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} /></FormRow></div>
        <div style={{ width: '170px' }}>
          <FormRow label='Entity'>
            <MultiSelectDropdown options={accessEntities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={entityFilter} onChange={setEntityFilter} placeholder='All' capitalize={false} style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ width: '170px' }}>
          <FormRow label='Party'>
            <MultiSelectDropdown options={entities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={partyFilter} onChange={setPartyFilter} placeholder='All' capitalize={false} style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' onClick={() => {
          const out = filtered.map(j => ({
            journal_no: j.journal_no, date: j.journal_date, entity: entName(j.entity_id), party: entName(j.party_entity_id),
            sales_invoices: invList(j.sales), purchase_invoices: invList(j.purchases), amount: j.amount,
            source: sourceLabel(j), notes: j.notes,
          }))
          if (!exportRows('journal_setoffs', out)) setToast({ message: 'Nothing to export', type: 'error' })
        }}>↓ Export CSV</Btn>
        <Btn onClick={openNew}>+ New Journal</Btn>
      </div>

      <Card>
        {loading ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        : filtered.length === 0 ? <EmptyState icon='⇄' title='No journals yet' message='Set off a sales invoice against a purchase invoice from the same party.' action={<Btn onClick={openNew}>+ New Journal</Btn>} />
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1050px' }}>
              <thead><tr>
                {['Date', 'Journal No', 'Entity', 'Party', 'Our sales', 'Our purchases', 'Amount', 'Source', ''].map((h, i) => (
                  <th key={i} style={{ ...th, textAlign: i === 6 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((j, i) => (
                  <tr key={j.key} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={td}>{fmtDate(j.journal_date)}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{j.journal_no}</td>
                    <td style={td}>{entName(j.entity_id)}</td>
                    <td style={td}>{entName(j.party_entity_id)}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{invList(j.sales)}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{invList(j.purchases)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>₹{formatNumberIN(j.amount)}</td>
                    <td style={{ ...td, color: C.textMuted }}>{sourceLabel(j)}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <Btn size='xs' variant='ghost' onClick={() => openEdit(j)}>Edit</Btn>
                        <Btn size='xs' variant='ghost' onClick={() => setConfirmDelete(j)} style={{ color: C.danger }}>Del</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? `Edit Journal — ${editing.journal_no}` : 'New Journal'} width={820}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Entity' required>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)} disabled={!!editing}>
                <option value=''>Select</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Party' required hint={form.entity_id && !editing && partyOptions.length === 0 ? 'No party has pending invoices both ways with this entity.' : undefined}>
              <Select value={form.party_entity_id} onChange={e => setF('party_entity_id', e.target.value)} disabled={!form.entity_id || !!editing}>
                <option value=''>Select</option>
                {(editing ? [entityMap.get(form.party_entity_id)].filter(Boolean) : partyOptions).map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Date' required><Input type='date' value={form.journal_date} onChange={e => setF('journal_date', e.target.value)} /></FormRow>
          </div>

          {form.entity_id && form.party_entity_id && (
            <>
              <PickTable title={`Our sales — ${entName(form.entity_id)} → ${entName(form.party_entity_id)}`} list={salesList} state={form.sales} onChange={pick('sales')} />
              <PickTable title={`Our purchases — ${entName(form.party_entity_id)} → ${entName(form.entity_id)}`} list={purchaseList} state={form.purchases} onChange={pick('purchases')} />
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '8px', fontSize: '13px' }}>
                <div><div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700 }}>Sales set off</div><strong>{formatINR(salesTotal)}</strong></div>
                <div><div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700 }}>Purchases set off</div><strong>{formatINR(purchTotal)}</strong></div>
                <div><div style={{ fontSize: '10px', color: C.textMuted, textTransform: 'uppercase', fontWeight: 700 }}>Difference</div>
                  <strong style={{ color: Math.abs(salesTotal - purchTotal) > 0.005 ? C.danger : C.success }}>{formatINR(round2(salesTotal - purchTotal))}</strong></div>
              </div>
            </>
          )}

          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Save Journal'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Journal' message={`Delete ${confirmDelete?.journal_no || ''}? Both invoices go back to pending by ${formatINR(confirmDelete?.amount || 0)}.${confirmDelete?.payment_group_id ? ' The cash part of that payment stays as it is.' : ''}`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
