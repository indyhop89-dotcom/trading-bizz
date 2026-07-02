import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Textarea,
} from '../../components/UI/index'
import { fmtDate } from '../../utils/dates'

// ─── Reliance Portal Tracker ────────────────────────────────────────────────────
// Reads / writes reliance_vendor_id, reliance_sales_id, reliance_onboarded,
// reliance_notes fields directly on the entities table.

export default function Reliance() {
  const [entities, setEntities] = useState([])
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState('all')   // 'all' | 'onboarded' | 'pending'
  const [search, setSearch]     = useState('')
  const [editModal, setEditModal] = useState(null)   // entity record
  const [editForm, setEditForm]   = useState({})
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('entities')
      .select('id, name, short_name, type, state_name, gstin, reliance_vendor_id, reliance_sales_id, reliance_onboarded, reliance_notes, updated_at')
      .eq('is_deleted', false)
      .order('name')
    if (error) console.error(error.message)
    setEntities(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openEdit(entity) {
    setEditForm({
      reliance_onboarded: entity.reliance_onboarded || false,
      reliance_vendor_id: entity.reliance_vendor_id || '',
      reliance_sales_id:  entity.reliance_sales_id  || '',
      reliance_notes:     entity.reliance_notes     || '',
    })
    setEditModal(entity)
  }

  async function handleSave() {
    setSaving(true)
    const { error } = await supabase.from('entities').update({
      reliance_onboarded: editForm.reliance_onboarded,
      reliance_vendor_id: editForm.reliance_vendor_id || null,
      reliance_sales_id:  editForm.reliance_sales_id  || null,
      reliance_notes:     editForm.reliance_notes     || null,
      updated_at:         new Date().toISOString(),
    }).eq('id', editModal.id)
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${editModal.short_name || editModal.name} updated`, type: 'success' })
    setEditModal(null)
    load()
  }

  const onboardedCount = entities.filter(e => e.reliance_onboarded).length
  const pendingCount   = entities.filter(e => !e.reliance_onboarded).length

  const filtered = entities.filter(e => {
    const mf = filter === 'all' ? true : filter === 'onboarded' ? e.reliance_onboarded : !e.reliance_onboarded
    const ms = !search
      || e.name?.toLowerCase().includes(search.toLowerCase())
      || e.short_name?.toLowerCase().includes(search.toLowerCase())
      || e.gstin?.toLowerCase().includes(search.toLowerCase())
      || e.reliance_vendor_id?.toLowerCase().includes(search.toLowerCase())
    return mf && ms
  })

  const columns = [
    { label: 'S.No.', render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    { label: 'Entity', render: e => (
      <div>
        <div style={{ fontSize: '13px', fontWeight: 600 }}>{e.short_name || e.name}</div>
        {e.short_name && e.name !== e.short_name && <div style={{ fontSize: '11px', color: C.textMuted }}>{e.name}</div>}
      </div>
    )},
    { label: 'Type',  render: e => <Badge status={e.type} label={e.type} /> },
    { label: 'State', render: e => <span style={{ fontSize: '12px', color: C.textSoft }}>{e.state_name || '—'}</span> },
    { label: 'GSTIN', render: e => <span style={{ fontSize: '11px', fontFamily: 'monospace', color: C.textSoft }}>{e.gstin || '—'}</span> },
    { label: 'Status', render: e => (
      e.reliance_onboarded
        ? <Badge status='active' label='Onboarded' />
        : <Badge status='pending' label='Pending' />
    )},
    { label: 'Vendor ID', render: e => (
      <span style={{ fontSize: '12px', fontFamily: 'monospace', color: e.reliance_vendor_id ? C.text : C.textMuted }}>
        {e.reliance_vendor_id || '—'}
      </span>
    )},
    { label: 'Sales ID', render: e => (
      <span style={{ fontSize: '12px', fontFamily: 'monospace', color: e.reliance_sales_id ? C.text : C.textMuted }}>
        {e.reliance_sales_id || '—'}
      </span>
    )},
    { label: 'Notes', render: e => (
      <span style={{ fontSize: '12px', color: C.textSoft, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', whiteSpace: 'nowrap' }} title={e.reliance_notes || ''}>
        {e.reliance_notes || '—'}
      </span>
    )},
    { label: '', render: e => (
      <Btn size='sm' variant='ghost' onClick={() => openEdit(e)}>Edit</Btn>
    )},
  ]

  return (
    <div>
      <PageHeader
        title='Reliance Portal Tracker'
        subtitle='Track Reliance onboarding status, Vendor ID and Sales ID per entity'
      />

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Total Entities', value: entities.length,  color: C.accent },
          { label: 'Onboarded',      value: onboardedCount,   color: C.success },
          { label: 'Pending',        value: pendingCount,     color: C.warning },
        ].map(s => (
          <div key={s.label} style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px',
            padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '4px',
          }}>
            <div style={{ fontSize: '11px', color: C.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      {entities.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: C.textMuted, marginBottom: '6px' }}>
            <span>Onboarding Progress</span>
            <span>{onboardedCount} / {entities.length} entities onboarded ({Math.round(onboardedCount / entities.length * 100)}%)</span>
          </div>
          <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.round(onboardedCount / entities.length * 100)}%`,
              background: onboardedCount === entities.length ? C.success : C.accent,
              borderRadius: 4,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', borderRadius: '6px', border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          {[
            { key: 'all',       label: 'All' },
            { key: 'pending',   label: `Pending (${pendingCount})` },
            { key: 'onboarded', label: `Onboarded (${onboardedCount})` },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '6px 14px', fontSize: '12px', fontWeight: 600,
                background: filter === f.key ? C.accent : 'transparent',
                color: filter === f.key ? '#f5f0e8' : C.textMuted,
                border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder='Search entity name, GSTIN, Vendor ID…'
          style={{
            flex: 1, minWidth: 200, padding: '7px 12px',
            border: `1.5px solid ${C.border}`, borderRadius: '6px',
            background: C.surface, fontSize: '13px', outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table
              columns={columns}
              rows={filtered}
              emptyState={<EmptyState icon='🏢' title='No entities' />}
            />
        }
      </Card>

      {/* Edit Modal */}
      <Modal open={!!editModal} onClose={() => setEditModal(null)} title={`Reliance Portal — ${editModal?.short_name || editModal?.name}`} width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Onboarded toggle */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', background: editForm.reliance_onboarded ? '#edf7f1' : '#fef6e4',
            border: `1px solid ${editForm.reliance_onboarded ? '#b8dfca' : '#f0d890'}`,
            borderRadius: '6px',
          }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: editForm.reliance_onboarded ? C.success : C.warning }}>
                {editForm.reliance_onboarded ? '✓ Onboarded' : '⏳ Pending Onboarding'}
              </div>
              <div style={{ fontSize: '12px', color: C.textSoft, marginTop: '2px' }}>
                {editForm.reliance_onboarded ? 'Entity is registered on Reliance portal' : 'Entity not yet registered on Reliance portal'}
              </div>
            </div>
            <button
              onClick={() => setEditForm(f => ({ ...f, reliance_onboarded: !f.reliance_onboarded }))}
              style={{
                padding: '6px 16px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
                background: editForm.reliance_onboarded ? C.success : C.accent,
                color: '#f5f0e8', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {editForm.reliance_onboarded ? 'Mark Pending' : 'Mark Onboarded'}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Vendor ID'>
              <Input
                value={editForm.reliance_vendor_id}
                onChange={e => setEditForm(f => ({ ...f, reliance_vendor_id: e.target.value }))}
                placeholder='Reliance Vendor ID'
              />
            </FormRow>
            <FormRow label='Sales ID'>
              <Input
                value={editForm.reliance_sales_id}
                onChange={e => setEditForm(f => ({ ...f, reliance_sales_id: e.target.value }))}
                placeholder='Reliance Sales ID'
              />
            </FormRow>
          </div>
          <FormRow label='Notes'>
            <Textarea
              value={editForm.reliance_notes}
              onChange={e => setEditForm(f => ({ ...f, reliance_notes: e.target.value }))}
              rows={3}
              placeholder='Any notes about onboarding status, pending items, contacts…'
            />
          </FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setEditModal(null)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
