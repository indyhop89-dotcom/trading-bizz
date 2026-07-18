import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider, StatCard,
} from '../../components/UI/index'
import { formatINR, toNum, roundRupees, round2 } from '../../utils/money'
import { fmtDate, today, currentFYLabel } from '../../utils/dates'
import DocumentAttachments from '../../components/DocumentAttachments'
import { useAuth } from '../../hooks/useAuth' // CHANGED: master-only delete, same convention as PI/PO/Invoices
import { useEntityAccess } from '../../hooks/useEntityAccess'
import { suggestNextNo } from '../../utils/numbering' // CHANGED: replaces the unconfirmed next_exp_no RPC

const GST_RATES     = [0, 5, 12, 18, 28]

const EMPTY = {
  expense_date: today(), entity_id: '', expense_type: '',
  description: '', amount: '', gst_rate: 0,
  vendor_entity_id: '', vendor_name: '', vendor_gstin: '',
  order_id: '', order_leg_id: '', status: 'unpaid', notes: '',
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
  const canDelete = profile?.role === 'master'
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
  const [categories, setCategories] = useState([]) // CHANGED: loaded from expense_categories master table
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [typeFilter, setType]   = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]         = useState(EMPTY)
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: exps }, { data: es }, { data: os }, { data: cats }] = await Promise.all([
      supabase.from('expenses')
        .select('*, entity:entity_id(name,short_name), vendor:vendor_entity_id(name,short_name), orders(name)')
        .eq('is_deleted', false).order('expense_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('orders').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('expense_categories').select('id,name').eq('is_active', true).order('sort_order'), // CHANGED
    ])
    setExpenses(exps || [])
    setEntities(es || [])
    setOrders(os || [])
    setCategories((cats || []).map(c => c.name)) // CHANGED: keep same string[] shape the UI already expects
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }

  const previewAmount  = toNum(form.amount)
  const previewGST     = roundRupees(round2(previewAmount * Number(form.gst_rate) / 100))
  const previewTotal   = previewAmount + previewGST

  async function handleSave() {
    if (!form.entity_id || !form.description) return setToast({ message: 'Entity and description are required', type: 'error' })
    if (!form.expense_type) return setToast({ message: 'Expense type is required', type: 'error' })
    const amount    = roundRupees(toNum(form.amount))
    if (!amount) return setToast({ message: 'Amount is required', type: 'error' })
    setSaving(true)
    const fy = await resolveFY()
    if (!fy) { setSaving(false); return setToast({ message: 'No financial year found', type: 'error' }) }
    // CHANGED: next_exp_no was calling an RPC of unconfirmed reliability —
    // same shape as the next_pi_no/next_po_no/next_inv_no functions already
    // confirmed missing on the live DB. Switched to suggestNextNo(), the
    // same client-side approach already proven for PI/PO/Invoices, so
    // expense numbering can't silently fail the same way. Stays fully
    // auto-generated — no manual override field, as requested.
    const entity = entities.find(e => e.id === form.entity_id)
    const expNo = await suggestNextNo({ table: 'expenses', noCol: 'expense_no', entityShort: entity?.short_name || entity?.name, fyCode: fy.code })
    const gst_amount   = roundRupees(round2(amount * Number(form.gst_rate) / 100))
    const total_amount = amount + gst_amount
    const payload = {
      expense_no:      expNo,
      financial_year_id: fy.id,
      expense_date:    form.expense_date,
      entity_id:       form.entity_id,
      category:        form.expense_type || form.category || 'other',
      description:     form.description,
      amount,
      gst_rate:        Number(form.gst_rate),
      gst_amount,
      total_amount,
      vendor_entity_id: form.vendor_entity_id || null,
      vendor_name:     form.vendor_name || null,
      vendor_gstin:    form.vendor_gstin || null,
      order_id:        form.order_id || null,
      status:          form.status,
      notes:           form.notes || null,
    }
    const { error } = await supabase.from('expenses').insert(payload)
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: 'Expense recorded', type: 'success' })
    setModalOpen(false)
    load()
  }

  const totalUnpaid = expenses.filter(e => e.status === 'unpaid').reduce((s, e) => s + e.total_amount, 0)
  const totalPaid   = expenses.filter(e => e.status === 'paid').reduce((s, e) => s + e.total_amount, 0)

  const filtered = expenses.filter(e => {
    const ms = !search || e.description.toLowerCase().includes(search.toLowerCase()) || e.entity?.name?.toLowerCase().includes(search.toLowerCase())
    const mt = typeFilter === 'all' || e.expense_type === typeFilter // CHANGED: now included in return
    return ms && mt // CHANGED: removed dateFrom/dateTo (undeclared state; date filter not in UI)
  })

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
    { label: 'No',       render: e => <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{e.expense_no || '—'}</span> },
    { label: 'Date',     render: e => <span style={{ fontSize: '12px' }}>{fmtDate(e.expense_date)}</span> },
    { label: 'Entity',   render: e => <span style={{ fontSize: '12px' }}>{e.entity?.short_name || e.entity?.name}</span> },
    { label: 'Type',     render: e => <Badge status={e.expense_type} label={e.expense_type} /> },
    { label: 'Desc',     render: e => <span style={{ fontSize: '12px' }}>{e.description}</span> },
    { label: 'Vendor',   render: e => <span style={{ fontSize: '12px', color: C.textSoft }}>{e.vendor?.short_name || e.vendor?.name || e.vendor_name || '—'}</span> },
    { label: 'Total',    right: true, render: e => <span style={{ fontWeight: 600 }}>{formatINR(e.total_amount)}</span> },
    { label: 'Status',   render: e => <Badge status={e.status} /> },
    { label: 'Docs',     render: e => <DocumentAttachments sourceType='expenses' sourceId={e.id} entityId={e.entity_id} entityName={e.entity?.name || 'General'} compact /> }, // CHANGED: entityId added
    // CHANGED: per-row delete, master-only
    ...(canDelete ? [{
      label: '', render: e => <Btn size='sm' variant='ghost' onClick={ev => { ev.stopPropagation(); setConfirmDelete(e) }} style={{ color: C.danger }}>Delete</Btn>,
    }] : []),
  ]

  return (
    <div>
      <PageHeader title='Expenses' subtitle='All costs associated with orders and entities'
        action={<Btn onClick={() => { setForm({ ...EMPTY, entity_id: defaultEntityId }); setModalOpen(true) }}>+ New Expense</Btn>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label='Unpaid' value={formatINR(totalUnpaid)} color={C.warning} />
        <StatCard label='Paid'   value={formatINR(totalPaid)} color={C.success} />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search description, entity…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, minWidth: '180px', fontFamily: 'inherit' }} />
        <select value={typeFilter} onChange={e => setType(e.target.value)}
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All types</option>
          {categories.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
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
              emptyState={<EmptyState icon='📊' title='No expenses' action={<Btn onClick={() => setModalOpen(true)}>+ New Expense</Btn>} />} />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Expense' width={600}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Date' required>
              <Input type='date' value={form.expense_date} onChange={e => setF('expense_date', e.target.value)} />
            </FormRow>
            <FormRow label='Entity' required hint={entityFrozen ? 'Locked to the only entity you have access to' : undefined}>
              <Select value={form.entity_id} onChange={e => setF('entity_id', e.target.value)} disabled={entityFrozen}>
                <option value=''>Select entity</option>
                {accessEntities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Expense Type' required>
              <Select value={form.expense_type} onChange={e => setF('expense_type', e.target.value)}>
                <option value=''>Select category</option>
                {categories.map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Status'>
              <Select value={form.status} onChange={e => setF('status', e.target.value)}>
                <option value='unpaid'>Unpaid</option>
                <option value='paid'>Paid</option>
              </Select>
            </FormRow>
          </div>
          <FormRow label='Description' required>
            <Input value={form.description} onChange={e => setF('description', e.target.value)} placeholder='What is this expense for?' />
          </FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Amount (₹)' required>
              <Input type='number' value={form.amount} onChange={e => setF('amount', e.target.value)} placeholder='0.00' />
            </FormRow>
            <FormRow label='GST %'>
              <Select value={form.gst_rate} onChange={e => setF('gst_rate', e.target.value)}>
                {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
              </Select>
            </FormRow>
          </div>
          {previewAmount > 0 && (
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 14px', fontSize: '13px', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: C.textSoft }}>Total incl. GST</span>
              <span style={{ fontWeight: 700 }}>{formatINR(previewTotal)}</span>
            </div>
          )}
          <SectionDivider label='Vendor' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Vendor (In System)'>
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
            <FormRow label='Vendor GSTIN'>
              <Input value={form.vendor_gstin} onChange={e => setF('vendor_gstin', e.target.value)} />
            </FormRow>
          </div>
          <SectionDivider label='Link to Order' />
          <FormRow label='Order'>
            <Select value={form.order_id} onChange={e => setF('order_id', e.target.value)}>
              <option value=''>No order</option>
              {orders.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </FormRow>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Expense'}</Btn>
          </div>
        </div>
      </Modal>

      {/* CHANGED: delete confirmation modals */}
      <ConfirmModal open={confirmBulkDelete} onClose={() => setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Expenses' message={`Delete ${selected.size} selected expense(s)? This cannot be undone.`} danger />
      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Expense' message={`Delete "${confirmDelete?.description || 'this expense'}"? This cannot be undone.`} danger />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
