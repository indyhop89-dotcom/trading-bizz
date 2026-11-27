import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../supabaseClient'
import { exportRows } from '../../utils/exportCsv'
import {
  C, Btn, MultiSelectDropdown, Modal, ConfirmModal, Toast, EmptyState,
  Card, FormRow, Input, Select, Textarea, StatCard,
} from '../../components/UI/index'
import { formatINR, formatNumberIN, toNum, roundRupees, round2 } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { fetchAllPages, excludeAutoPurchaseMirrors } from '../../utils/query'
import { syncInvoicePaymentStatus } from '../../utils/payments'

// ─── TDS / TCS register ─────────────────────────────────────────────────────
// One entry per invoice per type (tds_tcs_entries, migration 064). This is the
// book record of how much TDS / TCS sits on each invoice — entered here, not
// at payment time.
//   TDS: the buyer (payer) deducts it → deducted_by = buyer, deductee = seller.
//        It reduces the invoice's pending amount.
//   TCS: the seller collects it        → deducted_by = seller, deductee = buyer.
//        Record only — it never changes pending.
// Entries copied from old payment rows by migration 064 carry
// source_payment_id and show as "From payment".

const TDS_SECTIONS = ['194C', '194H', '194I', '194J', '194Q']
const TDS_SECTION_LABELS = {
  '194C': 'Payment to Contractors',
  '194H': 'Commission or Brokerage',
  '194I': 'Rent',
  '194J': 'Professional/Technical Services',
  '194Q': 'Purchase of Goods',
}
const TDS_DEFAULT_RATES = { '194C': 1, '194H': 5, '194I': 10, '194J': 10, '194Q': 0.1 }
const TCS_SECTIONS = ['206C']
const TCS_SECTION_LABELS = { '206C': 'TCS on Sale of Goods' }
const TCS_DEFAULT_RATES = { '206C': 0.1 }

const EMPTY = {
  invoice_id: '', invoice_text: '', entry_type: 'tds', section_code: '', rate: '',
  base_amount: '', amount: '', amount_touched: false, entry_date: '', notes: '',
}

const th = { padding: '9px 12px', background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: '10px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', whiteSpace: 'nowrap' }
const td = { padding: '9px 12px', borderBottom: '1px solid #f0e8d8', fontSize: '12px', verticalAlign: 'middle' }
const calcAmount = (base, rate) => roundRupees((toNum(base) * toNum(rate)) / 100)

export default function TdsRegister() {
  const { entities: accessEntities, defaultEntityId, loading: accessLoading } = useEntityAccess()
  const [entries, setEntries]   = useState([])
  const [invoices, setInvoices] = useState([])
  const [entities, setEntities] = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [entityFilter, setEntityFilter]   = useState([])
  const [typeFilter, setTypeFilter]       = useState([])
  const [sectionFilter, setSectionFilter] = useState([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [search, setSearch]     = useState('')
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [t, inv, { data: es }] = await Promise.all([
      fetchAllPages(() => supabase.from('tds_tcs_entries').select('*').eq('is_deleted', false).order('id')),
      fetchAllPages(() => excludeAutoPurchaseMirrors(supabase.from('invoices')
        .select('id,invoice_no,invoice_date,taxable_amount,total_amount,status,seller_entity_id,buyer_entity_id')
        .eq('is_deleted', false).neq('status', 'cancelled')).order('id')),
      supabase.from('entities').select('id,name,short_name').eq('is_deleted', false).order('name'),
    ])
    if (t.error || inv.error) setToast({ message: (t.error || inv.error).message, type: 'error' })
    setEntries(t.data || [])
    setInvoices(inv.data || [])
    setEntities(es || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (defaultEntityId && entityFilter.length === 0) setEntityFilter([defaultEntityId]) }, [defaultEntityId]) // eslint-disable-line react-hooks/exhaustive-deps

  const entityMap  = useMemo(() => new Map(entities.map(e => [e.id, e])), [entities])
  const invoiceMap = useMemo(() => new Map(invoices.map(i => [i.id, i])), [invoices])
  const entName = id => entityMap.get(id)?.short_name || entityMap.get(id)?.name || '—'
  const canSee = useCallback(inv => accessLoading || accessEntities.some(e => e.id === inv?.seller_entity_id || e.id === inv?.buyer_entity_id), [accessEntities, accessLoading])

  const rows = useMemo(() => entries.map(e => {
    const inv = invoiceMap.get(e.invoice_id)
    return {
      ...e, _inv: inv,
      invoice_no: inv?.invoice_no || '—', invoice_date: inv?.invoice_date,
      seller: entName(inv?.seller_entity_id), buyer: entName(inv?.buyer_entity_id),
      deducted_by: entName(e.deducted_by_entity_id), deductee: entName(e.deductee_entity_id),
      source: e.source_payment_id ? 'From payment' : 'Manual',
    }
  }), [entries, invoiceMap, entityMap]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = rows.filter(r => {
    if (!r._inv || !canSee(r._inv)) return false
    if (entityFilter.length && !entityFilter.includes(r.deducted_by_entity_id) && !entityFilter.includes(r.deductee_entity_id)) return false
    if (typeFilter.length && !typeFilter.includes(r.entry_type)) return false
    if (sectionFilter.length && !sectionFilter.includes(r.section_code)) return false
    const d = r.entry_date || r.invoice_date || ''
    if (dateFrom && d < dateFrom) return false
    if (dateTo && d > dateTo) return false
    if (search && !String(r.invoice_no).toLowerCase().includes(search.trim().toLowerCase())) return false
    return true
  }).sort((a, b) => (b.entry_date || b.invoice_date || '').localeCompare(a.entry_date || a.invoice_date || ''))

  const sum = (type, side) => round2(filtered.filter(r => r.entry_type === type && (
    !entityFilter.length || side === 'all' ||
    (side === 'by' ? entityFilter.includes(r.deducted_by_entity_id) : entityFilter.includes(r.deductee_entity_id))
  )).reduce((s, r) => s + toNum(r.amount), 0))

  // ── Form ──────────────────────────────────────────────────────────────────
  // Invoices that can take an entry: visible to this user, not draft.
  const invoiceChoices = useMemo(() => invoices
    .filter(i => i.status !== 'draft' && canSee(i))
    .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || '')), [invoices, canSee])
  const choiceLabel = i => `${i.invoice_no || i.id.slice(0, 8)} · ${entName(i.seller_entity_id)} → ${entName(i.buyer_entity_id)}`
  const labelToId = useMemo(() => new Map(invoiceChoices.map(i => [choiceLabel(i), i.id])), [invoiceChoices, entityMap]) // eslint-disable-line react-hooks/exhaustive-deps

  const formInv = invoiceMap.get(form.invoice_id)
  const sections = form.entry_type === 'tcs' ? TCS_SECTIONS : TDS_SECTIONS
  const sectionLabels = form.entry_type === 'tcs' ? TCS_SECTION_LABELS : TDS_SECTION_LABELS

  function setF(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'invoice_text') {
        const id = labelToId.get(v) || ''
        u.invoice_id = id
        const inv = invoiceMap.get(id)
        if (inv) {
          u.base_amount = String(toNum(inv.taxable_amount) || toNum(inv.total_amount))
          if (!u.entry_date) u.entry_date = inv.invoice_date || today()
        }
      }
      if (k === 'entry_type') { u.section_code = ''; u.rate = '' }
      if (k === 'section_code') {
        const rate = defaultRatesFor(u.entry_type)[v]
        if (rate != null) u.rate = String(rate)
      }
      if (k === 'amount') u.amount_touched = true
      else if (['invoice_text', 'entry_type', 'section_code', 'rate', 'base_amount'].includes(k)) {
        // Base or rate changed → recalculate; a hand-typed amount is replaced.
        u.amount = String(calcAmount(u.base_amount, u.rate))
        u.amount_touched = false
      }
      return u
    })
  }

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY, entry_date: today() })
    setModalOpen(true)
  }
  function openEdit(r) {
    setEditing(r)
    const inv = invoiceMap.get(r.invoice_id)
    setForm({
      invoice_id: r.invoice_id, invoice_text: inv ? choiceLabel(inv) : '',
      entry_type: r.entry_type, section_code: r.section_code || '', rate: String(toNum(r.rate)),
      base_amount: String(toNum(r.base_amount)), amount: String(toNum(r.amount)), amount_touched: true,
      entry_date: r.entry_date || '', notes: r.notes || '',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!formInv) return setToast({ message: 'Pick an invoice from the list', type: 'error' })
    if (!form.section_code) return setToast({ message: 'Select a section', type: 'error' })
    if (toNum(form.amount) <= 0) return setToast({ message: 'Amount must be more than zero', type: 'error' })
    if (!form.entry_date) return setToast({ message: 'Date is required', type: 'error' })
    const clash = entries.find(e => e.invoice_id === formInv.id && e.entry_type === form.entry_type && e.id !== editing?.id)
    if (clash) return setToast({ message: `${formInv.invoice_no} already has a ${form.entry_type.toUpperCase()} entry — edit that one instead`, type: 'error' })
    if (form.entry_type === 'tds' && toNum(form.amount) > toNum(formInv.total_amount)) return setToast({ message: 'TDS is more than the invoice total', type: 'error' })

    const isTds = form.entry_type === 'tds'
    const payload = {
      invoice_id: formInv.id, entry_type: form.entry_type,
      section_code: form.section_code, section_desc: sectionLabels[form.section_code] || null,
      deducted_by_entity_id: isTds ? formInv.buyer_entity_id : formInv.seller_entity_id,
      deductee_entity_id:    isTds ? formInv.seller_entity_id : formInv.buyer_entity_id,
      base_amount: round2(toNum(form.base_amount)), rate: toNum(form.rate) || 0, amount: round2(toNum(form.amount)),
      entry_date: form.entry_date, notes: form.notes || null, updated_at: new Date(),
    }
    setSaving(true)
    const { error } = editing
      ? await supabase.from('tds_tcs_entries').update(payload).eq('id', editing.id)
      : await supabase.from('tds_tcs_entries').insert(payload)
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    // TDS changes pending, so re-derive the invoice status (old invoice too, if it was moved).
    const toSync = new Set()
    if (isTds) toSync.add(formInv.id)
    if (editing?.entry_type === 'tds') toSync.add(editing.invoice_id)
    let syncErr = null
    for (const id of toSync) { const r = await syncInvoicePaymentStatus(id); syncErr = syncErr || r.error }
    setSaving(false)
    setToast(syncErr
      ? { message: `Saved, but the invoice status could not be updated: ${syncErr.message}`, type: 'error' }
      : { message: editing ? 'Entry updated' : 'Entry added', type: 'success' })
    setModalOpen(false); load()
  }

  async function handleDelete() {
    const r = confirmDelete
    const { error } = await supabase.from('tds_tcs_entries').update({ is_deleted: true, updated_at: new Date() }).eq('id', r.id)
    if (error) setToast({ message: error.message, type: 'error' })
    else if (r.entry_type === 'tds') await syncInvoicePaymentStatus(r.invoice_id)
    setConfirmDelete(null); load()
  }

  const allSections = [...TDS_SECTIONS, ...TCS_SECTIONS]

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '12px', marginBottom: '20px' }}>
        {entityFilter.length ? (
          <>
            <StatCard label='TDS deducted by us' value={formatINR(sum('tds', 'by'))} color={C.warning} />
            <StatCard label='TDS deducted from us' value={formatINR(sum('tds', 'from'))} color={C.success} />
            <StatCard label='TCS collected by us' value={formatINR(sum('tcs', 'by'))} color={C.warning} />
            <StatCard label='TCS collected from us' value={formatINR(sum('tcs', 'from'))} color={C.success} />
          </>
        ) : (
          <>
            <StatCard label='Total TDS' value={formatINR(sum('tds', 'all'))} />
            <StatCard label='Total TCS' value={formatINR(sum('tcs', 'all'))} />
            <StatCard label='Entries' value={filtered.length} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: '130px' }}><FormRow label='From Date'><Input type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></FormRow></div>
        <div style={{ width: '130px' }}><FormRow label='To Date'><Input type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} /></FormRow></div>
        <div style={{ width: '170px' }}>
          <FormRow label='Entity'>
            <MultiSelectDropdown options={accessEntities.map(e => ({ value: e.id, label: e.short_name || e.name }))} selected={entityFilter} onChange={setEntityFilter} placeholder='All' capitalize={false} style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ width: '110px' }}>
          <FormRow label='Type'>
            <MultiSelectDropdown options={[{ value: 'tds', label: 'TDS' }, { value: 'tcs', label: 'TCS' }]} selected={typeFilter} onChange={setTypeFilter} placeholder='All' capitalize={false} style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ width: '120px' }}>
          <FormRow label='Section'>
            <MultiSelectDropdown options={allSections} selected={sectionFilter} onChange={setSectionFilter} placeholder='All' capitalize={false} style={{ width: '100%', justifyContent: 'space-between' }} />
          </FormRow>
        </div>
        <div style={{ width: '160px' }}><FormRow label='Invoice No'><Input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search' /></FormRow></div>
        <div style={{ flex: 1 }} />
        <Btn variant='ghost' onClick={() => {
          const out = filtered.map(r => ({
            date: r.entry_date, invoice_no: r.invoice_no, invoice_date: r.invoice_date, seller: r.seller, buyer: r.buyer,
            type: r.entry_type.toUpperCase(), section: r.section_code, rate: r.rate, base_amount: r.base_amount, amount: r.amount,
            deducted_by: r.deducted_by, deductee: r.deductee, source: r.source, notes: r.notes,
          }))
          if (!exportRows('tds_tcs_register', out)) setToast({ message: 'Nothing to export', type: 'error' })
        }}>↓ Export CSV</Btn>
        <Btn onClick={openNew}>+ Add Entry</Btn>
      </div>

      <Card>
        {loading ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        : filtered.length === 0 ? <EmptyState icon='🧾' title='No TDS / TCS entries' action={<Btn onClick={openNew}>+ Add Entry</Btn>} />
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1150px' }}>
              <thead><tr>
                {['Date', 'Invoice No', 'Seller', 'Buyer', 'Type', 'Section', 'Rate %', 'Base', 'Amount', 'Deducted / collected by', 'Source', ''].map((h, i) => (
                  <th key={i} style={{ ...th, textAlign: i >= 6 && i <= 8 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.id} style={{ background: i % 2 === 0 ? C.surface : '#faf6ed' }}>
                    <td style={td}>{fmtDate(r.entry_date)}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '11px' }}>{r.invoice_no}</td>
                    <td style={td}>{r.seller}</td>
                    <td style={td}>{r.buyer}</td>
                    <td style={td}>
                      <span style={{ fontSize: '11px', background: r.entry_type === 'tds' ? '#f3ede8' : '#e8f0f3', color: r.entry_type === 'tds' ? C.warning : '#1a4a6a', padding: '2px 7px', borderRadius: '4px', fontWeight: 600 }}>{r.entry_type.toUpperCase()}</span>
                    </td>
                    <td style={td}>{r.section_code}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{toNum(r.rate)}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>₹{formatNumberIN(r.base_amount)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>₹{formatNumberIN(r.amount)}</td>
                    <td style={td}>{r.deducted_by}</td>
                    <td style={{ ...td, color: C.textMuted }}>{r.source}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <Btn size='xs' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
                        <Btn size='xs' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Del</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit TDS / TCS Entry' : 'Add TDS / TCS Entry'} width={640}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Invoice' required hint='Type the invoice number and pick from the list.'>
            <Input list='tds-invoice-options' value={form.invoice_text} onChange={e => setF('invoice_text', e.target.value)} placeholder='Invoice number' />
            <datalist id='tds-invoice-options'>
              {invoiceChoices.map(i => <option key={i.id} value={choiceLabel(i)} />)}
            </datalist>
          </FormRow>
          {formInv && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 14px', display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px', fontSize: '12px' }}>
              <div><div style={{ color: C.textMuted }}>Date</div><strong>{fmtDate(formInv.invoice_date)}</strong></div>
              <div><div style={{ color: C.textMuted }}>Taxable value</div><strong>{formatINR(formInv.taxable_amount)}</strong></div>
              <div><div style={{ color: C.textMuted }}>Invoice total</div><strong>{formatINR(formInv.total_amount)}</strong></div>
              <div><div style={{ color: C.textMuted }}>{form.entry_type === 'tds' ? 'Deducted by' : 'Collected by'}</div>
                <strong>{entName(form.entry_type === 'tds' ? formInv.buyer_entity_id : formInv.seller_entity_id)}</strong></div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Type' required>
              <Select value={form.entry_type} onChange={e => setF('entry_type', e.target.value)}>
                <option value='tds'>TDS</option>
                <option value='tcs'>TCS</option>
              </Select>
            </FormRow>
            <FormRow label='Section' required>
              <Select value={form.section_code} onChange={e => setF('section_code', e.target.value)}>
                <option value=''>Select</option>
                {sections.map(s => <option key={s} value={s}>{s} — {sectionLabels[s]}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Rate %'><Input type='number' value={form.rate} onChange={e => setF('rate', e.target.value)} /></FormRow>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <FormRow label='Base (invoice value)' hint='Defaults to the taxable value'><Input type='number' value={form.base_amount} onChange={e => setF('base_amount', e.target.value)} /></FormRow>
            <FormRow label='Amount' required hint={form.amount_touched ? 'Entered by hand' : 'Base × rate'}><Input type='number' value={form.amount} onChange={e => setF('amount', e.target.value)} /></FormRow>
            <FormRow label='Date' required><Input type='date' value={form.entry_date} onChange={e => setF('entry_date', e.target.value)} /></FormRow>
          </div>
          <div style={{ fontSize: '12px', color: C.textMuted }}>
            {form.entry_type === 'tds' ? 'TDS reduces this invoice’s pending amount.' : 'TCS is a record only. It doesn’t change the invoice’s pending amount.'}
          </div>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Entry'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Entry' message={`Delete the ${confirmDelete?.entry_type?.toUpperCase() || ''} entry on ${confirmDelete?.invoice_no || ''}?`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

function defaultRatesFor(type) {
  return type === 'tcs' ? TCS_DEFAULT_RATES : TDS_DEFAULT_RATES
}
