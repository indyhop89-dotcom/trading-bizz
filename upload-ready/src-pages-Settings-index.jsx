import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Modal, ConfirmModal, Toast, EmptyState,
  Card, FormRow, Input, Select, Textarea, SectionDivider, Badge,
} from '../../components/UI/index'
import { fmtDate } from '../../utils/dates'
import { formatSlabSummary } from '../../utils/hsn'
import { downloadTemplate } from '../../utils/csvTemplate'

const TABS = ['Financial Years', 'Entity Groups', 'HSN Master', 'Users', 'Reliance Tracker']

// ─── Financial Years ──────────────────────────────────────────────────────────
function FYSettings() {
  const [fys, setFys]       = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]     = useState({ name: '', start_date: '', end_date: '', is_active: true })
  const [saving, setSaving] = useState(false)
  const [toast, setToast]   = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('financial_years').select('*').order('start_date', { ascending: false })
    setFys(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function openNew() {
    setEditing(null)
    setForm({ name: '', start_date: '', end_date: '', is_active: true })
    setModalOpen(true)
  }

  function openEdit(fy) {
    setEditing(fy)
    setForm({ name: fy.name, start_date: fy.start_date, end_date: fy.end_date, is_active: fy.is_active })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name || !form.start_date || !form.end_date) return setToast({ message: 'All fields required', type: 'error' })
    setSaving(true)
    let error
    if (editing) {
      const res = await supabase.from('financial_years').update(form).eq('id', editing.id)
      error = res.error
    } else {
      const res = await supabase.from('financial_years').insert(form)
      error = res.error
    }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'FY updated' : 'FY created', type: 'success' })
    setModalOpen(false)
    load()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ fontWeight: 700 }}>Financial Years</div>
        <Btn size='sm' onClick={openNew}>+ Add FY</Btn>
      </div>
      <Card>
        {loading
          ? <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : fys.length === 0
            ? <EmptyState icon='📅' title='No financial years' action={<Btn onClick={openNew}>+ Add FY</Btn>} />
            : fys.map(fy => (
              <div key={fy.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{fy.name}</div>
                  <div style={{ fontSize: '12px', color: C.textSoft }}>{fmtDate(fy.start_date)} → {fmtDate(fy.end_date)}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <Badge status={fy.is_active ? 'active' : 'cancelled'} label={fy.is_active ? 'Active' : 'Inactive'} />
                  <Btn size='sm' variant='ghost' onClick={() => openEdit(fy)}>Edit</Btn>
                </div>
              </div>
            ))
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit FY' : 'New Financial Year'} width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Name' required hint='e.g. FY 2025-26'>
            <Input value={form.name} onChange={e => setF('name', e.target.value)} placeholder='FY 2025-26' />
          </FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Start Date' required><Input type='date' value={form.start_date} onChange={e => setF('start_date', e.target.value)} /></FormRow>
            <FormRow label='End Date' required><Input type='date' value={form.end_date} onChange={e => setF('end_date', e.target.value)} /></FormRow>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='fy_active' checked={form.is_active} onChange={e => setF('is_active', e.target.checked)} style={{ width: '14px', height: '14px' }} />
            <label htmlFor='fy_active' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>Active</label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Entity Groups ────────────────────────────────────────────────────────────
function GroupSettings() {
  const [groups, setGroups]   = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState({ name: '', description: '' })
  const [saving, setSaving]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]     = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('entity_groups').select('*, entities(count)').order('name')
    setGroups(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openNew()    { setEditing(null); setForm({ name: '', description: '' }); setModalOpen(true) }
  function openEdit(g)  { setEditing(g); setForm({ name: g.name, description: g.description || '' }); setModalOpen(true) }

  async function handleSave() {
    if (!form.name) return setToast({ message: 'Name required', type: 'error' })
    setSaving(true)
    let error
    if (editing) {
      const res = await supabase.from('entity_groups').update(form).eq('id', editing.id)
      error = res.error
    } else {
      const res = await supabase.from('entity_groups').insert(form)
      error = res.error
    }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'Group updated' : 'Group created', type: 'success' })
    setModalOpen(false)
    load()
  }

  async function handleDelete() {
    await supabase.from('entity_groups').delete().eq('id', confirmDelete.id)
    setConfirmDelete(null)
    load()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ fontWeight: 700 }}>Entity Groups</div>
        <Btn size='sm' onClick={openNew}>+ Add Group</Btn>
      </div>
      <Card>
        {loading
          ? <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : groups.length === 0
            ? <EmptyState icon='🏷️' title='No groups' action={<Btn onClick={openNew}>+ Add Group</Btn>} />
            : groups.map(g => (
              <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  {g.description && <div style={{ fontSize: '12px', color: C.textSoft }}>{g.description}</div>}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Btn size='sm' variant='ghost' onClick={() => openEdit(g)}>Edit</Btn>
                  <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(g)} style={{ color: C.danger }}>Delete</Btn>
                </div>
              </div>
            ))
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Group' : 'New Group'} width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <FormRow label='Name' required><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></FormRow>
          <FormRow label='Description'><Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>
      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Group' message={`Delete "${confirmDelete?.name}"?`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Users ────────────────────────────────────────────────────────────────────
function UserSettings() {
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    supabase.from('profiles').select('*').order('full_name').then(({ data }) => {
      setProfiles(data || [])
      setLoading(false)
    })
  }, [])

  return (
    <div>
      <div style={{ fontWeight: 700, marginBottom: '16px' }}>Users</div>
      <Card>
        {loading
          ? <div style={{ padding: '32px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : profiles.length === 0
            ? <EmptyState icon='👤' title='No users' message='Users are managed via Supabase Authentication.' />
            : profiles.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.full_name || p.email || p.id.slice(0, 8)}</div>
                  <div style={{ fontSize: '12px', color: C.textSoft }}>{p.email}</div>
                </div>
                <Badge status='active' label={p.role || 'user'} />
              </div>
            ))
        }
      </Card>
      <div style={{ marginTop: '12px', fontSize: '12px', color: C.textMuted }}>
        To add or remove users, use the Supabase dashboard → Authentication → Users.
      </div>
    </div>
  )
}

// ─── HSN Master ───────────────────────────────────────────────────────────────
const EMPTY_HSN = {
  hsn_code: '', description: '', rate_type: 'fixed',
  fixed_rate: '', is_active: true,
}

// Default empty slab row
const EMPTY_SLAB = { max_rate_rupees: '', gst_rate: '' }

function HSNMasterSettings() {
  const [rows, setRows]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]     = useState(null)
  const [form, setForm]           = useState(EMPTY_HSN)
  const [slabs, setSlabs]         = useState([EMPTY_SLAB])
  const [saving, setSaving]       = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]         = useState(null)
  // CSV upload
  const [csvText, setCsvText]     = useState('')
  const [csvModal, setCsvModal]   = useState(false)
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('hsn_master').select('*').order('hsn_code')
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function openNew() {
    setEditing(null)
    setForm(EMPTY_HSN)
    setSlabs([{ ...EMPTY_SLAB }])
    setModalOpen(true)
  }

  function openEdit(row) {
    setEditing(row)
    setForm({
      hsn_code:    row.hsn_code,
      description: row.description || '',
      rate_type:   row.rate_type,
      fixed_rate:  row.fixed_rate != null ? String(row.fixed_rate) : '',
      is_active:   row.is_active,
    })
    if (row.rate_type === 'slab' && Array.isArray(row.slabs)) {
      setSlabs(row.slabs.map(s => ({
        max_rate_rupees: s.max_rate != null ? String(s.max_rate) : '',
        gst_rate:        String(s.gst_rate),
      })))
    } else {
      setSlabs([{ ...EMPTY_SLAB }])
    }
    setModalOpen(true)
  }

  // Slab helpers
  function addSlab()           { setSlabs(s => [...s, { ...EMPTY_SLAB }]) }
  function removeSlab(i)       { setSlabs(s => s.filter((_, idx) => idx !== i)) }
  function updateSlab(i, k, v) { setSlabs(s => { const n = [...s]; n[i] = { ...n[i], [k]: v }; return n }) }

  // Build slabs jsonb (max_rate in rupees)
  function buildSlabsPayload() {
    return slabs.map(s => ({
      max_rate: s.max_rate_rupees !== '' && s.max_rate_rupees !== null
        ? Number(s.max_rate_rupees)
        : null,
      gst_rate: Number(s.gst_rate),
    }))
  }

  async function handleSave() {
    if (!form.hsn_code.trim()) return setToast({ message: 'HSN code is required', type: 'error' })
    if (form.rate_type === 'fixed' && (form.fixed_rate === '' || isNaN(Number(form.fixed_rate))))
      return setToast({ message: 'GST rate is required for fixed type', type: 'error' })
    if (form.rate_type === 'slab') {
      for (const s of slabs) {
        if (s.gst_rate === '' || isNaN(Number(s.gst_rate)))
          return setToast({ message: 'All slab GST rates are required', type: 'error' })
      }
      // Last slab must have null max_rate (open-ended)
      const last = slabs[slabs.length - 1]
      if (last.max_rate_rupees !== '' && last.max_rate_rupees !== null)
        return setToast({ message: 'Last slab must have no upper limit (leave threshold blank)', type: 'error' })
    }

    setSaving(true)
    const payload = {
      hsn_code:    form.hsn_code.trim(),
      description: form.description || null,
      rate_type:   form.rate_type,
      fixed_rate:  form.rate_type === 'fixed' ? Number(form.fixed_rate) : null,
      slabs:       form.rate_type === 'slab' ? buildSlabsPayload() : null,
      is_active:   form.is_active,
      updated_at:  new Date(),
    }

    let error
    if (editing) {
      const res = await supabase.from('hsn_master').update(payload).eq('id', editing.id)
      error = res.error
    } else {
      const res = await supabase.from('hsn_master').insert(payload)
      error = res.error
    }
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: editing ? 'HSN updated' : 'HSN created', type: 'success' })
    setModalOpen(false)
    load()
  }

  async function handleDelete() {
    await supabase.from('hsn_master').delete().eq('id', confirmDelete.id)
    setConfirmDelete(null)
    setToast({ message: 'HSN deleted', type: 'success' })
    load()
  }

  // ── CSV Upload ─────────────────────────────────────────────────────────────
  // CSV format:
  // hsn_code,description,rate_type,fixed_rate,slabs
  // 6109,T-shirts,slab,,1000:5|null:12
  // 5208,Cotton fabric,fixed,5,
  //
  // Slab format: threshold_rupees:gst_rate pairs separated by |
  //   "null" threshold = open-ended final slab
  function parseCSV(text) {
    const lines = text.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) return { error: 'CSV must have header + at least 1 row' }

    const header = lines[0].split(',').map(h => h.trim().toLowerCase())
    const required = ['hsn_code', 'rate_type']
    for (const r of required) {
      if (!header.includes(r)) return { error: `Missing column: ${r}` }
    }

    const results = []
    const errors  = []

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })

      if (!row.hsn_code) { errors.push(`Row ${i + 1}: hsn_code missing`); continue }
      if (!['fixed', 'slab'].includes(row.rate_type)) {
        errors.push(`Row ${i + 1}: rate_type must be 'fixed' or 'slab'`); continue
      }

      const parsed = {
        hsn_code:    row.hsn_code.trim(),
        description: row.description || null,
        rate_type:   row.rate_type,
        fixed_rate:  null,
        slabs:       null,
        is_active:   true,
      }

      if (row.rate_type === 'fixed') {
        if (!row.fixed_rate || isNaN(Number(row.fixed_rate))) {
          errors.push(`Row ${i + 1}: fixed_rate required for fixed type`); continue
        }
        parsed.fixed_rate = Number(row.fixed_rate)
      }

      if (row.rate_type === 'slab') {
        if (!row.slabs) { errors.push(`Row ${i + 1}: slabs required for slab type`); continue }
        try {
          parsed.slabs = row.slabs.split('|').map(pair => {
            const [maxRaw, gstRaw] = pair.trim().split(':')
            return {
              max_rate: maxRaw === 'null' || maxRaw === '' ? null : Number(maxRaw),
              gst_rate: Number(gstRaw),
            }
          })
        } catch {
          errors.push(`Row ${i + 1}: invalid slab format — use "threshold_rupees:gst|null:gst"`); continue
        }
      }

      results.push(parsed)
    }

    return { rows: results, errors }
  }

  async function handleCSVUpload() {
    const parsed = parseCSV(csvText)
    if (parsed.error) return setToast({ message: parsed.error, type: 'error' })

    setCsvSaving(true)
    const { rows: toUpsert, errors } = parsed

    let upserted = 0, failed = 0
    for (const row of toUpsert) {
      const { error } = await supabase
        .from('hsn_master')
        .upsert({ ...row, updated_at: new Date() }, { onConflict: 'hsn_code' })
      if (error) { failed++; errors.push(`${row.hsn_code}: ${error.message}`) }
      else upserted++
    }

    setCsvSaving(false)
    setCsvResult({ upserted, failed, errors })
    load()
  }

  const filtered = rows.filter(r => {
    const ms = !search || r.hsn_code.includes(search) ||
      (r.description || '').toLowerCase().includes(search.toLowerCase())
    const mt = typeFilter === 'all' || r.rate_type === typeFilter
    return ms && mt
  })

  // ── styles ─────────────────────────────────────────────────────────────────
  const inlineInput = {
    padding: '6px 10px', border: `1.5px solid ${C.border}`, borderRadius: '5px',
    background: '#fffdf6', fontSize: '13px', fontFamily: 'inherit', outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ fontWeight: 700, fontSize: '15px' }}>HSN Master</div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Btn size='sm' variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>
            ↑ CSV Upload
          </Btn>
          <Btn size='sm' onClick={openNew}>+ Add HSN</Btn>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder='Search HSN code or description…'
          style={{ ...inlineInput, flex: 1, minWidth: '180px' }}
        />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{ ...inlineInput, cursor: 'pointer' }}>
          <option value='all'>All types</option>
          <option value='fixed'>Fixed rate</option>
          <option value='slab'>Slab (rate-dependent)</option>
        </select>
      </div>

      {/* Summary */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '12px', fontSize: '12px', color: C.textSoft }}>
        <span><strong style={{ color: C.text }}>{rows.length}</strong> HSN codes</span>
        <span><strong style={{ color: C.text }}>{rows.filter(r => r.rate_type === 'slab').length}</strong> slab-based</span>
        <span><strong style={{ color: C.text }}>{rows.filter(r => !r.is_active).length}</strong> inactive</span>
      </div>

      <Card>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <EmptyState icon='🏷️' title='No HSN codes' message='Add HSN codes to enable auto GST calculation in line items.'
            action={<Btn onClick={openNew}>+ Add HSN</Btn>} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  {['HSN Code', 'Description', 'Type', 'Rate / Slabs', 'Status', 'Actions'].map((h, i) => (
                    <th key={i} style={{
                      padding: '9px 14px', background: C.bg, borderBottom: `1px solid ${C.border}`,
                      fontSize: '11px', fontWeight: 700, color: C.textSoft,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      textAlign: i >= 3 ? 'left' : 'left', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, i) => (
                  <tr key={row.id} style={{ background: i % 2 === 0 ? '#fffdf6' : '#faf6ed' }}>
                    <td style={{ padding: '10px 14px', borderBottom: `1px solid #f0e8d8`, fontFamily: 'monospace', fontWeight: 700, fontSize: '13px' }}>
                      {row.hsn_code}
                    </td>
                    <td style={{ padding: '10px 14px', borderBottom: `1px solid #f0e8d8`, color: C.textMid, maxWidth: '220px' }}>
                      {row.description || <span style={{ color: C.textMuted }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 14px', borderBottom: `1px solid #f0e8d8` }}>
                      {row.rate_type === 'fixed'
                        ? <span style={{ fontSize: '11px', fontWeight: 700, background: '#e8f0f3', color: '#1a4a6a', padding: '2px 7px', borderRadius: '4px' }}>Fixed</span>
                        : <span style={{ fontSize: '11px', fontWeight: 700, background: '#ede8f3', color: '#3a1a6a', padding: '2px 7px', borderRadius: '4px' }}>Slab</span>
                      }
                    </td>
                    <td style={{ padding: '10px 14px', borderBottom: `1px solid #f0e8d8`, fontSize: '12px', color: C.textMid }}>
                      {row.rate_type === 'fixed'
                        ? <strong style={{ color: C.text }}>{row.fixed_rate}%</strong>
                        : <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{formatSlabSummary(row.slabs)}</span>
                      }
                    </td>
                    <td style={{ padding: '10px 14px', borderBottom: `1px solid #f0e8d8` }}>
                      <Badge status={row.is_active ? 'active' : 'cancelled'} label={row.is_active ? 'Active' : 'Inactive'} />
                    </td>
                    <td style={{ padding: '10px 14px', borderBottom: `1px solid #f0e8d8` }}>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <Btn size='sm' variant='ghost' onClick={() => openEdit(row)}>Edit</Btn>
                        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(row)} style={{ color: C.danger }}>Delete</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Add / Edit Modal ── */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? `Edit HSN — ${editing.hsn_code}` : 'Add HSN Code'} width={600}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          <SectionDivider label='HSN Details' />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '12px' }}>
            <FormRow label='HSN Code' required>
              <Input value={form.hsn_code} onChange={e => setF('hsn_code', e.target.value)}
                placeholder='e.g. 6109' disabled={!!editing} />
            </FormRow>
            <FormRow label='Description'>
              <Input value={form.description} onChange={e => setF('description', e.target.value)}
                placeholder='Short description of goods' />
            </FormRow>
          </div>

          <SectionDivider label='GST Rate Rule' />

          {/* Rate type toggle */}
          <div style={{ display: 'flex', gap: '0', border: `1.5px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden', alignSelf: 'flex-start' }}>
            {['fixed', 'slab'].map(t => (
              <button key={t} onClick={() => setF('rate_type', t)}
                style={{
                  padding: '7px 20px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  fontWeight: 600, fontSize: '13px',
                  background: form.rate_type === t ? C.accent : C.surface,
                  color:      form.rate_type === t ? '#f5f0e8' : C.textSoft,
                  transition: 'all 0.15s',
                }}>
                {t === 'fixed' ? 'Fixed Rate' : 'Slab (rate-dependent)'}
              </button>
            ))}
          </div>

          {/* Fixed rate */}
          {form.rate_type === 'fixed' && (
            <FormRow label='GST Rate %' required hint='Applied to all transactions with this HSN code'>
              <Select value={form.fixed_rate} onChange={e => setF('fixed_rate', e.target.value)}
                style={{ maxWidth: '180px' }}>
                <option value=''>Select rate</option>
                {[0, 3, 5, 12, 18, 28].map(r => <option key={r} value={r}>{r}%</option>)}
              </Select>
            </FormRow>
          )}

          {/* Slab rules */}
          {form.rate_type === 'slab' && (
            <div>
              <div style={{ fontSize: '12px', color: C.textSoft, marginBottom: '10px', lineHeight: 1.6 }}>
                Define slabs in ascending order. <strong>Leave the last slab's threshold blank</strong> — it becomes the fallback for all values above the previous threshold.
                Threshold is the <strong>rate per unit in ₹</strong>.
              </div>

              <div style={{ border: `1px solid ${C.border}`, borderRadius: '7px', overflow: 'hidden' }}>
                {/* Header */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 32px', background: C.bg, borderBottom: `1px solid ${C.border}`, padding: '7px 12px', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.04em', gap: '8px' }}>
                  <span>Upper threshold (₹/unit)</span>
                  <span>GST Rate %</span>
                  <span></span>
                </div>

                {slabs.map((slab, i) => {
                  const isLast = i === slabs.length - 1
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 32px', gap: '8px', padding: '8px 12px', borderBottom: i < slabs.length - 1 ? `1px solid ${C.border}` : 'none', alignItems: 'center', background: i % 2 === 0 ? '#fffdf6' : '#faf6ed' }}>
                      <div>
                        {isLast ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <input disabled value='' placeholder='No limit (fallback)'
                              style={{ padding: '6px 10px', border: `1.5px solid ${C.border}`, borderRadius: '5px', background: C.bg, fontSize: '12px', fontFamily: 'inherit', width: '100%', color: C.textMuted, cursor: 'not-allowed', boxSizing: 'border-box' }} />
                          </div>
                        ) : (
                          <input type='number' value={slab.max_rate_rupees}
                            onChange={e => updateSlab(i, 'max_rate_rupees', e.target.value)}
                            placeholder='e.g. 1000'
                            style={{ padding: '6px 10px', border: `1.5px solid ${C.border}`, borderRadius: '5px', background: '#fffdf6', fontSize: '12px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box', outline: 'none' }} />
                        )}
                        {!isLast && slab.max_rate_rupees && (
                          <div style={{ fontSize: '10px', color: C.textMuted, marginTop: '2px' }}>
                            Applies when rate ≤ ₹{Number(slab.max_rate_rupees).toLocaleString('en-IN')}
                          </div>
                        )}
                        {isLast && (
                          <div style={{ fontSize: '10px', color: C.textMuted, marginTop: '2px' }}>
                            Applies when rate is above all other thresholds
                          </div>
                        )}
                      </div>

                      <div>
                        <select value={slab.gst_rate} onChange={e => updateSlab(i, 'gst_rate', e.target.value)}
                          style={{ padding: '6px 10px', border: `1.5px solid ${C.border}`, borderRadius: '5px', background: '#fffdf6', fontSize: '12px', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box', outline: 'none', cursor: 'pointer' }}>
                          <option value=''>— select %</option>
                          {[0, 3, 5, 12, 18, 28].map(r => <option key={r} value={r}>{r}%</option>)}
                        </select>
                      </div>

                      <div style={{ textAlign: 'center' }}>
                        {slabs.length > 1 && (
                          <button onClick={() => removeSlab(i)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.danger, fontSize: '16px', padding: '2px 5px' }}>
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Btn size='sm' variant='ghost' onClick={addSlab}>+ Add Slab</Btn>
                <span style={{ fontSize: '11px', color: C.textMuted }}>
                  Add slabs in ascending threshold order. Last slab = open-ended fallback.
                </span>
              </div>

              {/* Live preview */}
              {slabs.some(s => s.gst_rate !== '') && (
                <div style={{ marginTop: '10px', background: '#f0ebe0', border: `1px solid ${C.borderDark}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
                  <div style={{ fontWeight: 700, color: C.textMid, marginBottom: '5px' }}>Preview</div>
                  {slabs.map((s, i) => {
                    const prev = slabs[i - 1]
                    const lower = prev?.max_rate_rupees ? `> ₹${Number(prev.max_rate_rupees).toLocaleString('en-IN')}` : null
                    const upper = s.max_rate_rupees ? `≤ ₹${Number(s.max_rate_rupees).toLocaleString('en-IN')}` : null
                    const range = [lower, upper].filter(Boolean).join(' & ') || 'All values'
                    return (
                      <div key={i} style={{ color: C.textMid, marginBottom: '2px' }}>
                        {range} → <strong>{s.gst_rate || '?'}%</strong>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          <SectionDivider label='Status' />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='hsn_active' checked={form.is_active} onChange={e => setF('is_active', e.target.checked)}
              style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
            <label htmlFor='hsn_active' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>Active</label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add HSN'}</Btn>
          </div>
        </div>
      </Modal>

      {/* ── CSV Upload Modal ── */}
      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='Bulk Upload HSN Master (CSV)' width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px', color: C.textMid, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <strong>CSV Format:</strong>
              <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('hsn_master')}>↓ Download Template</Btn>
            </div>
            <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>hsn_code,description,rate_type,fixed_rate,slabs</code><br /><br />
            <strong>Examples:</strong><br />
            <code style={{ fontFamily: 'monospace', fontSize: '11px', display: 'block', marginTop: '2px' }}>
              5208,Cotton woven fabric,fixed,5,<br />
              6109,T-shirts knitted,slab,,1000:5|null:12<br />
              6201,Mens overcoats,slab,,1000:5|5000:12|null:18
            </code><br />
            <strong>Slab format:</strong> <code style={{ fontFamily: 'monospace' }}>threshold_rupees:gst_rate</code> pairs separated by <code>|</code>.
            Use <code>null</code> for the open-ended final slab.
            Threshold is rate per unit in <strong>rupees</strong> (e.g. 1000 = ₹1,000).
          </div>

          <FormRow label='Paste CSV'>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)}
              rows={10} placeholder='Paste CSV data here…'
              style={{ padding: '8px 11px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: '#fffdf6', fontSize: '12px', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', resize: 'vertical', outline: 'none' }} />
          </FormRow>

          {csvResult && (
            <div style={{ background: csvResult.failed > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.failed > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '12px 14px', fontSize: '12px' }}>
              <div style={{ fontWeight: 700, marginBottom: '4px', color: C.text }}>
                Upload complete: {csvResult.upserted} upserted{csvResult.failed > 0 ? `, ${csvResult.failed} failed` : ''}
              </div>
              {csvResult.errors.length > 0 && (
                <div style={{ color: '#7a5000', marginTop: '6px' }}>
                  {csvResult.errors.map((e, i) => <div key={i}>• {e}</div>)}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSVUpload} disabled={csvSaving || !csvText.trim()}>
              {csvSaving ? 'Uploading…' : 'Upload CSV'}
            </Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete HSN' message={`Delete HSN ${confirmDelete?.hsn_code}? All PI/Invoice lines with this HSN will lose auto-rate detection.`} danger />

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}


// ─── Reliance Tracker ─────────────────────────────────────────────────────────
function RelianceSettings() {
  const [entities, setEntities] = useState([])
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState('all')
  const [search, setSearch]     = useState('')
  const [editModal, setEditModal] = useState(null)
  const [editForm, setEditForm]   = useState({})
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('entities')
      .select('id,name,short_name,type,state_name,gstin,reliance_vendor_id,reliance_sales_id,reliance_onboarded,reliance_notes')
      .eq('is_deleted', false).order('name')
    setEntities(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openEdit(e) {
    setEditForm({ reliance_onboarded: e.reliance_onboarded || false, reliance_vendor_id: e.reliance_vendor_id || '', reliance_sales_id: e.reliance_sales_id || '', reliance_notes: e.reliance_notes || '' })
    setEditModal(e)
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

  const onboarded = entities.filter(e => e.reliance_onboarded).length
  const pending   = entities.filter(e => !e.reliance_onboarded).length

  const filtered = entities.filter(e => {
    const mf = filter === 'all' ? true : filter === 'onboarded' ? e.reliance_onboarded : !e.reliance_onboarded
    const ms = !search || e.name?.toLowerCase().includes(search.toLowerCase()) || e.short_name?.toLowerCase().includes(search.toLowerCase()) || (e.reliance_vendor_id || '').toLowerCase().includes(search.toLowerCase())
    return mf && ms
  })

  return (
    <div>
      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '20px' }}>
        {[['Total', entities.length, C.accent], ['Onboarded', onboarded, C.success], ['Pending', pending, C.warning]].map(([l,v,c]) => (
          <div key={l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '14px 16px' }}>
            <div style={{ fontSize: '11px', color: C.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{l}</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: c, lineHeight: 1, marginTop: '4px' }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      {entities.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: C.textMuted, marginBottom: '6px' }}>
            <span>Onboarding Progress</span>
            <span>{onboarded}/{entities.length} ({Math.round(onboarded/entities.length*100)}%)</span>
          </div>
          <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(onboarded/entities.length*100)}%`, background: onboarded===entities.length ? C.success : C.accent, borderRadius: 4, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', borderRadius: '6px', border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          {[['all','All'],[' pending',`Pending (${pending})`],['onboarded',`Onboarded (${onboarded})`]].map(([k,l]) => (
            <button key={k} onClick={() => setFilter(k.trim())} style={{ padding: '6px 14px', fontSize: '12px', fontWeight: 600, background: filter===k.trim() ? C.accent : 'transparent', color: filter===k.trim() ? '#f5f0e8' : C.textMuted, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>{l}</button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search entity, vendor ID…' style={{ flex: 1, minWidth: 180, padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', fontFamily: 'inherit' }} />
      </div>

      {/* Table */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr>{['Entity','Type','GSTIN','Status','Vendor ID','Sales ID','Notes',''].map((h,i) => (
                <th key={i} style={{ padding: '8px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', background: C.bg, borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={8} style={{ padding: '32px', textAlign: 'center', color: C.textMuted }}>No entities found.</td></tr>}
              {filtered.map((e, ri) => (
                <tr key={e.id} style={{ background: ri%2===0 ? C.surface : '#faf6ed' }}>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ fontWeight: 600 }}>{e.short_name || e.name}</div>
                    {e.short_name && <div style={{ fontSize: '11px', color: C.textMuted }}>{e.name}</div>}
                  </td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}><Badge status={e.type} label={e.type} /></td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontSize: '11px', fontFamily: 'monospace', color: C.textSoft }}>{e.gstin || '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}>
                    {e.reliance_onboarded ? <Badge status='active' label='Onboarded' /> : <Badge status='pending' label='Pending' />}
                  </td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontFamily: 'monospace', fontSize: '12px', color: e.reliance_vendor_id ? C.text : C.textMuted }}>{e.reliance_vendor_id || '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontFamily: 'monospace', fontSize: '12px', color: e.reliance_sales_id ? C.text : C.textMuted }}>{e.reliance_sales_id || '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontSize: '12px', color: C.textSoft, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.reliance_notes || '—'}</td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}>
                    <Btn size='sm' variant='ghost' onClick={() => openEdit(e)}>Edit</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Edit Modal */}
      <Modal open={!!editModal} onClose={() => setEditModal(null)} title={`Reliance — ${editModal?.short_name || editModal?.name}`} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: editForm.reliance_onboarded ? '#edf7f1' : '#fef6e4', border: `1px solid ${editForm.reliance_onboarded ? '#b8dfca' : '#f0d890'}`, borderRadius: '6px' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: editForm.reliance_onboarded ? C.success : C.warning }}>{editForm.reliance_onboarded ? '✓ Onboarded' : '⏳ Pending'}</div>
              <div style={{ fontSize: '12px', color: C.textSoft, marginTop: '2px' }}>{editForm.reliance_onboarded ? 'Registered on Reliance portal' : 'Not yet registered'}</div>
            </div>
            <button onClick={() => setEditForm(f => ({ ...f, reliance_onboarded: !f.reliance_onboarded }))} style={{ padding: '6px 16px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: editForm.reliance_onboarded ? C.success : C.accent, color: '#f5f0e8', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              {editForm.reliance_onboarded ? 'Mark Pending' : 'Mark Onboarded'}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Vendor ID'><Input value={editForm.reliance_vendor_id} onChange={e => setEditForm(f => ({...f, reliance_vendor_id: e.target.value}))} placeholder='Reliance Vendor ID' /></FormRow>
            <FormRow label='Sales ID'><Input value={editForm.reliance_sales_id} onChange={e => setEditForm(f => ({...f, reliance_sales_id: e.target.value}))} placeholder='Reliance Sales ID' /></FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={editForm.reliance_notes} onChange={e => setEditForm(f => ({...f, reliance_notes: e.target.value}))} rows={3} /></FormRow>
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

export default function Settings() {
  const [tab, setTab] = useState('Financial Years')

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: C.text, margin: 0 }}>Settings</h1>
        <p style={{ fontSize: '13px', color: C.textMuted, margin: '4px 0 0' }}>Manage financial years, groups, HSN master, and users</p>
      </div>

      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `2px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '8px 18px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontWeight: tab === t ? 700 : 500, fontSize: '13px',
              color: tab === t ? C.text : C.textSoft,
              background: 'transparent',
              borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
              marginBottom: '-2px',
            }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Financial Years'  && <FYSettings />}
      {tab === 'Entity Groups'    && <GroupSettings />}
      {tab === 'HSN Master'       && <HSNMasterSettings />}
      {tab === 'Users'            && <UserSettings />}
      {tab === 'Reliance Tracker' && <RelianceSettings />}
    </div>
  )
}
