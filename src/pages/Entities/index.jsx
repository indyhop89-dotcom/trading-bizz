import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider,
} from '../../components/UI/index'
import { GST_STATES } from '../../constants/states'

const ENTITY_TYPES = ['group', 'associate', 'external']
const GST_UNITS    = ['Nos', 'Kg', 'Pcs', 'Box', 'Mtr', 'Ltr', 'Set']

const EMPTY_FORM = {
  name: '', short_name: '', type: 'associate',
  gstin: '', pan: '', state_code: '', state_name: '',
  address: '', city: '', pincode: '', email: '', phone: '',
  bank_name: '', bank_account_no: '', bank_ifsc: '', bank_branch: '',
  reliance_vendor_id: '', reliance_sales_id: '',
  reliance_onboarded: false, reliance_notes: '',
  is_active: true,
}

export default function Entities() {
  const [entities, setEntities]   = useState([])
  const [groups, setGroups]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]     = useState(null)   // null = new
  const [form, setForm]           = useState(EMPTY_FORM)
  const [saving, setSaving]       = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]         = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('entities')
      .select('*, entity_groups(name)')
      .eq('is_deleted', false)
      .order('name')
    setEntities(data || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    supabase.from('entity_groups').select('*').order('name').then(({ data }) => setGroups(data || []))
  }, [load])

  function openNew() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setModalOpen(true)
  }

  function openEdit(entity) {
    setEditing(entity)
    setForm({
      name:               entity.name || '',
      short_name:         entity.short_name || '',
      type:               entity.type || 'associate',
      group_id:           entity.group_id || '',
      gstin:              entity.gstin || '',
      pan:                entity.pan || '',
      state_code:         entity.state_code || '',
      state_name:         entity.state_name || '',
      address:            entity.address || '',
      city:               entity.city || '',
      pincode:            entity.pincode || '',
      email:              entity.email || '',
      phone:              entity.phone || '',
      bank_name:          entity.bank_name || '',
      bank_account_no:    entity.bank_account_no || '',
      bank_ifsc:          entity.bank_ifsc || '',
      bank_branch:        entity.bank_branch || '',
      reliance_vendor_id: entity.reliance_vendor_id || '',
      reliance_sales_id:  entity.reliance_sales_id || '',
      reliance_onboarded: entity.reliance_onboarded || false,
      reliance_notes:     entity.reliance_notes || '',
      is_active:          entity.is_active !== false,
    })
    setModalOpen(true)
  }

  function setF(key, val) {
    setForm(f => {
      const updated = { ...f, [key]: val }
      // auto-fill state_name from state_code
      if (key === 'state_code') {
        const st = GST_STATES.find(s => s.code === val)
        updated.state_name = st?.name || ''
      }
      return updated
    })
  }

  async function handleSave() {
    if (!form.name.trim()) return setToast({ message: 'Name is required', type: 'error' })
    setSaving(true)
    const payload = { ...form }
    if (!payload.group_id) delete payload.group_id

    let error
    if (editing) {
      const res = await supabase.from('entities').update({ ...payload, updated_at: new Date() }).eq('id', editing.id)
      error = res.error
    } else {
      const res = await supabase.from('entities').insert(payload)
      error = res.error
    }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'Entity updated' : 'Entity created', type: 'success' })
    setModalOpen(false)
    load()
  }

  async function handleDelete() {
    const { error } = await supabase
      .from('entities')
      .update({ is_deleted: true })
      .eq('id', confirmDelete.id)
    setConfirmDelete(null)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: 'Entity deleted', type: 'success' })
    load()
  }

  const filtered = entities.filter(e => {
    const matchSearch = !search || e.name.toLowerCase().includes(search.toLowerCase()) ||
      (e.short_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (e.gstin || '').toLowerCase().includes(search.toLowerCase())
    const matchType = typeFilter === 'all' || e.type === typeFilter
    return matchSearch && matchType
  })

  const columns = [
    {
      label: 'Entity', key: 'name',
      render: e => (
        <div>
          <div style={{ fontWeight: 600, color: C.text }}>{e.name}</div>
          {e.short_name && <div style={{ fontSize: '11px', color: C.textMuted }}>{e.short_name}</div>}
        </div>
      ),
    },
    { label: 'Type',   render: e => <Badge status={e.type} /> },
    { label: 'Group',  render: e => <span style={{ fontSize: '12px', color: C.textSoft }}>{e.entity_groups?.name || '—'}</span> },
    { label: 'GSTIN',  render: e => <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{e.gstin || '—'}</span> },
    { label: 'State',  render: e => <span style={{ fontSize: '12px' }}>{e.state_name || '—'}</span> },
    { label: 'Status', render: e => <Badge status={e.is_active ? 'active' : 'cancelled'} label={e.is_active ? 'Active' : 'Inactive'} /> },
    {
      label: 'Actions',
      render: e => (
        <div style={{ display: 'flex', gap: '6px' }} onClick={ev => ev.stopPropagation()}>
          <Btn size='sm' variant='ghost' onClick={() => openEdit(e)}>Edit</Btn>
          <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(e)} style={{ color: C.danger }}>Delete</Btn>
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title='Entities'
        subtitle={`${entities.length} entities across the group`}
        action={<Btn onClick={openNew}>+ New Entity</Btn>}
      />

      {/* filters */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder='Search by name, short name, GSTIN…'
          style={{
            padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px',
            background: C.surface, fontSize: '13px', color: C.text,
            outline: 'none', flex: '1', minWidth: '200px', fontFamily: 'inherit',
          }}
        />
        <select
          value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{
            padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px',
            background: C.surface, fontSize: '13px', color: C.text,
            outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <option value='all'>All types</option>
          {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <Card>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        ) : (
          <Table
            columns={columns}
            rows={filtered}
            emptyState={<EmptyState icon='🏢' title='No entities yet' message='Add your first entity to get started.' action={<Btn onClick={openNew}>+ New Entity</Btn>} />}
          />
        )}
      </Card>

      {/* Entity Form Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? `Edit — ${editing.name}` : 'New Entity'} width={720}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SectionDivider label='Basic Info' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Entity Name' required>
              <Input value={form.name} onChange={e => setF('name', e.target.value)} placeholder='Full legal name' />
            </FormRow>
            <FormRow label='Short Name' hint='Used in tables and reports'>
              <Input value={form.short_name} onChange={e => setF('short_name', e.target.value)} placeholder='e.g. Siddi' />
            </FormRow>
            <FormRow label='Type' required>
              <Select value={form.type} onChange={e => setF('type', e.target.value)}>
                {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Group'>
              <Select value={form.group_id || ''} onChange={e => setF('group_id', e.target.value)}>
                <option value=''>No group</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            </FormRow>
          </div>

          <SectionDivider label='Tax & Compliance' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='GSTIN'>
              <Input value={form.gstin} onChange={e => setF('gstin', e.target.value.toUpperCase())} placeholder='22AAAAA0000A1Z5' />
            </FormRow>
            <FormRow label='PAN'>
              <Input value={form.pan} onChange={e => setF('pan', e.target.value.toUpperCase())} placeholder='AAAAA0000A' />
            </FormRow>
            <FormRow label='State'>
              <Select value={form.state_code} onChange={e => setF('state_code', e.target.value)}>
                <option value=''>Select state</option>
                {GST_STATES.map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='State Name'>
              <Input value={form.state_name} onChange={e => setF('state_name', e.target.value)} readOnly />
            </FormRow>
          </div>

          <SectionDivider label='Contact & Address' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Email'>
              <Input type='email' value={form.email} onChange={e => setF('email', e.target.value)} />
            </FormRow>
            <FormRow label='Phone'>
              <Input value={form.phone} onChange={e => setF('phone', e.target.value)} />
            </FormRow>
            <FormRow label='City'>
              <Input value={form.city} onChange={e => setF('city', e.target.value)} />
            </FormRow>
            <FormRow label='Pincode'>
              <Input value={form.pincode} onChange={e => setF('pincode', e.target.value)} />
            </FormRow>
          </div>
          <FormRow label='Address'>
            <Textarea value={form.address} onChange={e => setF('address', e.target.value)} placeholder='Full address' rows={2} />
          </FormRow>

          <SectionDivider label='Bank Details' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Bank Name'>
              <Input value={form.bank_name} onChange={e => setF('bank_name', e.target.value)} />
            </FormRow>
            <FormRow label='Account No'>
              <Input value={form.bank_account_no} onChange={e => setF('bank_account_no', e.target.value)} />
            </FormRow>
            <FormRow label='IFSC Code'>
              <Input value={form.bank_ifsc} onChange={e => setF('bank_ifsc', e.target.value.toUpperCase())} />
            </FormRow>
            <FormRow label='Branch'>
              <Input value={form.bank_branch} onChange={e => setF('bank_branch', e.target.value)} />
            </FormRow>
          </div>

          <SectionDivider label='Reliance Portal' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Vendor ID'>
              <Input value={form.reliance_vendor_id} onChange={e => setF('reliance_vendor_id', e.target.value)} />
            </FormRow>
            <FormRow label='Sales ID'>
              <Input value={form.reliance_sales_id} onChange={e => setF('reliance_sales_id', e.target.value)} />
            </FormRow>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type='checkbox' id='reliance_onboarded'
              checked={form.reliance_onboarded}
              onChange={e => setF('reliance_onboarded', e.target.checked)}
              style={{ width: '14px', height: '14px', cursor: 'pointer' }}
            />
            <label htmlFor='reliance_onboarded' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>
              Onboarded on Reliance portal
            </label>
          </div>
          <FormRow label='Reliance Notes'>
            <Textarea value={form.reliance_notes} onChange={e => setF('reliance_notes', e.target.value)} rows={2} />
          </FormRow>

          <SectionDivider label='Status' />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type='checkbox' id='is_active'
              checked={form.is_active}
              onChange={e => setF('is_active', e.target.checked)}
              style={{ width: '14px', height: '14px', cursor: 'pointer' }}
            />
            <label htmlFor='is_active' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>
              Active
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Entity'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title='Delete Entity'
        message={`Delete "${confirmDelete?.name}"? This action cannot be undone.`}
        danger
      />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
