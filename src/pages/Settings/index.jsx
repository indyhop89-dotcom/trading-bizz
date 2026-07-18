import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, StatCard, CsvFileDrop,
} from '../../components/UI/index'
import { toNum } from '../../utils/money'
import { fmtDate, today } from '../../utils/dates'
import { formatSlabSummary } from '../../utils/hsn'
import { downloadTemplate, downloadCSV, detectDelimiter } from '../../utils/csvTemplate'
import { useAuth } from '../../hooks/useAuth'
import { hasFullAccess } from '../../utils/roles'
import { isValidGSTIN, isValidPAN, GSTIN_ERROR, PAN_ERROR } from '../../utils/validation'

// REBUILT — this file was found to contain a copy of the Invoices module
// (src/pages/Invoices/index.jsx) instead of Settings, which is why /settings
// was rendering the invoice list. Rebuilt from scratch against the actual
// schema (financial_years, entity_groups, hsn_master, profiles) and the
// existing hsn_master CSV template format already defined in csvTemplate.js.
// If a better version turns up in git history, prefer that over this file.

const TABS = ['My Profile', 'Financial Years', 'Entity Groups', 'HSN Master', 'Parties', 'Users']

// ─── My Profile Tab ─────────────────────────────────────────────────────────────
// Self-service name/phone editing, available to every role (master included) —
// RLS already permits a user to update their own profiles row
// (profiles_update: is_super_admin() OR id = auth.uid()); this is just the
// missing UI for it. Deliberately scoped to full_name/phone only — role,
// is_active, and entity grants stay admin-managed (Users tab).
function MyProfile() {
  const { profile, refreshProfile } = useAuth()
  const [fullName, setFullName] = useState('')
  const [phone, setPhone]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  useEffect(() => {
    if (profile) { setFullName(profile.full_name || ''); setPhone(profile.phone || '') }
  }, [profile])

  async function handleSave() {
    if (!fullName.trim()) return setToast({ message: 'Name is required', type: 'error' })
    setSaving(true)
    const { error } = await supabase.from('profiles')
      .update({ full_name: fullName.trim(), phone: phone.trim() || null, updated_at: new Date() })
      .eq('id', profile.id)
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    await refreshProfile()
    setToast({ message: 'Profile updated', type: 'success' })
  }

  return (
    <div style={{ maxWidth: '420px' }}>
      <Card style={{ padding: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Full Name' required>
            <Input value={fullName} onChange={e => setFullName(e.target.value)} placeholder='Your full name' />
          </FormRow>
          <FormRow label='Email'><Input value={profile?.email || ''} disabled /></FormRow>
          <FormRow label='Phone'><Input value={phone} onChange={e => setPhone(e.target.value)} placeholder='Optional' /></FormRow>
          <FormRow label='Role' hint='Managed by your administrator'><Input value={profile?.role || ''} disabled /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
          </div>
        </div>
      </Card>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Financial Years Tab ───────────────────────────────────────────────────────
const EMPTY_FY = { name: '', code: '', start_date: '', end_date: '', is_active: false }

function FinancialYears() {
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_FY)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('financial_years').select('*').order('start_date', { ascending: false })
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function openNew()  { setEditing(null); setForm(EMPTY_FY); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({ name: r.name || '', code: r.code || '', start_date: r.start_date || '', end_date: r.end_date || '', is_active: !!r.is_active })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim() || !form.code.trim() || !form.start_date || !form.end_date)
      return setToast({ message: 'Name, code, start and end date are required', type: 'error' })
    setSaving(true)
    const payload = { name: form.name.trim(), code: form.code.trim(), start_date: form.start_date, end_date: form.end_date, is_active: form.is_active }
    const res = editing
      ? await supabase.from('financial_years').update(payload).eq('id', editing.id)
      : await supabase.from('financial_years').insert(payload)
    setSaving(false)
    if (res.error) return setToast({ message: res.error.message, type: 'error' })
    setModalOpen(false)
    setToast({ message: editing ? 'Financial year updated' : 'Financial year added', type: 'success' })
    load()
  }

  // CHANGED: check usage before attempting delete, so an in-use FY gets a
  // clear "X orders / Y stock rows linked" message instead of a raw
  // Postgres FK-violation error surfaced straight from the delete attempt.
  async function handleDelete() {
    if (!confirmDelete) return
    setSaving(true)

    const [{ count: orderCount }, { count: stockCount }] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact', head: true }).eq('financial_year_id', confirmDelete.id),
      supabase.from('stock_opening_balance').select('id', { count: 'exact', head: true }).eq('financial_year_id', confirmDelete.id),
    ])

    if (orderCount > 0 || stockCount > 0) {
      setSaving(false)
      setConfirmDelete(null)
      return setToast({
        message: `Can't delete "${confirmDelete.name}" — it has ${orderCount} order(s) and ${stockCount} opening stock row(s) linked to it.`,
        type: 'error',
      })
    }

    // CHANGED: safe to delete — order_sequence has a UNIQUE, non-cascading
    // FK on financial_year_id, so it must be cleared before the FY itself.
    await supabase.from('order_sequence').delete().eq('financial_year_id', confirmDelete.id)
    const { error } = await supabase.from('financial_years').delete().eq('id', confirmDelete.id)
    setSaving(false)
    if (error) setToast({ message: error.message, type: 'error' })
    else setToast({ message: 'Financial year deleted', type: 'success' })
    setConfirmDelete(null)
    load()
  }

  const columns = [
    { label: 'S.No.', render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Name',   render: r => <span style={{ fontWeight: 600 }}>{r.name}</span> },
    { label: 'Code',   render: r => <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{r.code}</span> },
    { label: 'Start',  render: r => fmtDate(r.start_date) },
    { label: 'End',    render: r => fmtDate(r.end_date) },
    { label: 'Status', render: r => <Badge status={r.is_active ? 'active' : 'cancelled'} label={r.is_active ? 'Active' : 'Inactive'} /> },
    { label: 'Actions', render: r => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Delete</Btn>
      </div>
    )},
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <Btn onClick={openNew}>+ New Financial Year</Btn>
      </div>
      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={rows}
              emptyState={<EmptyState icon='📅' title='No financial years' action={<Btn onClick={openNew}>+ New Financial Year</Btn>} />}
            />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Financial Year' : 'New Financial Year'} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Name' required><Input value={form.name} onChange={e => setF('name', e.target.value)} placeholder='FY 2026-27' /></FormRow>
          <FormRow label='Code' required><Input value={form.code} onChange={e => setF('code', e.target.value)} placeholder='2627' style={{ fontFamily: 'monospace' }} /></FormRow>
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
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Financial Year' message={`Delete "${confirmDelete?.name}"? This cannot be undone.`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Entity Groups Tab ──────────────────────────────────────────────────────────
const EMPTY_GROUP = { name: '', description: '' }

function EntityGroups() {
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_GROUP)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('entity_groups').select('*').order('name')
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function openNew()  { setEditing(null); setForm(EMPTY_GROUP); setModalOpen(true) }
  function openEdit(r) { setEditing(r); setForm({ name: r.name || '', description: r.description || '' }); setModalOpen(true) }

  async function handleSave() {
    if (!form.name.trim()) return setToast({ message: 'Name is required', type: 'error' })
    setSaving(true)
    const payload = { name: form.name.trim(), description: form.description || null }
    const res = editing
      ? await supabase.from('entity_groups').update(payload).eq('id', editing.id)
      : await supabase.from('entity_groups').insert(payload)
    setSaving(false)
    if (res.error) return setToast({ message: res.error.message, type: 'error' })
    setModalOpen(false)
    setToast({ message: editing ? 'Group updated' : 'Group added', type: 'success' })
    load()
  }

  async function handleDelete() {
    if (!confirmDelete) return
    const { error } = await supabase.from('entity_groups').delete().eq('id', confirmDelete.id)
    // Entities reference group_id without ON DELETE CASCADE in the schema on
    // record, so a group that's in use will fail here rather than silently
    // orphaning/cascading — surfaced to the user rather than swallowed.
    if (error) setToast({ message: `Could not delete — ${error.message}`, type: 'error' })
    setConfirmDelete(null)
    load()
  }

  const columns = [
    { label: 'S.No.',       render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Name',        render: r => <span style={{ fontWeight: 600 }}>{r.name}</span> },
    { label: 'Description', render: r => <span style={{ color: C.textMid }}>{r.description || '—'}</span> },
    { label: 'Created',     render: r => fmtDate(r.created_at) },
    { label: 'Actions', render: r => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Delete</Btn>
      </div>
    )},
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <Btn onClick={openNew}>+ New Group</Btn>
      </div>
      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={rows}
              emptyState={<EmptyState icon='🏢' title='No entity groups' action={<Btn onClick={openNew}>+ New Group</Btn>} />}
            />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Group' : 'New Group'} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Name' required><Input value={form.name} onChange={e => setF('name', e.target.value)} /></FormRow>
          <FormRow label='Description'><Textarea value={form.description} onChange={e => setF('description', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Group' message={`Delete "${confirmDelete?.name}"?`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── HSN Master Tab ─────────────────────────────────────────────────────────────
const EMPTY_HSN = { hsn_code: '', description: '', rate_type: 'fixed', fixed_rate: '18', slabs: [{ max_rate: '', gst_rate: '' }], effective_from: '' }

// "1000:5|null:12" → [{max_rate:1000,gst_rate:5},{max_rate:null,gst_rate:12}]
// Matches the format already defined in csvTemplate.js's hsn_master template.
function parseSlabsString(s) {
  if (!s) return []
  return s.split('|').map(part => {
    const [maxStr, gstStr] = part.split(':').map(x => x.trim())
    return { max_rate: maxStr === 'null' || maxStr === '' ? null : toNum(maxStr), gst_rate: toNum(gstStr) }
  })
}

function HsnMaster() {
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_HSN)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]       = useState(null)
  const [csvModal, setCsvModal]   = useState(false)
  const [csvText, setCsvText]     = useState('')
  const [csvResult, setCsvResult] = useState(null)
  const [csvSaving, setCsvSaving] = useState(false)
  const [historyFor, setHistoryFor]     = useState(null) // hsn_code currently shown, or null
  const [historyRows, setHistoryRows]   = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [openActionsFor, setOpenActionsFor] = useState(null) // CHANGED: row id whose Actions menu is open
  const [confirmHardDelete, setConfirmHardDelete] = useState(null) // CHANGED: real delete, distinct from Deactivate

  // Only the current (open-ended) version of each code shows in the main
  // table — past versions are versioned history, viewed via "History".
  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('hsn_master').select('*').is('effective_to', null).order('hsn_code')
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function openNew()  { setEditing(null); setForm({ ...EMPTY_HSN, effective_from: today() }); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({
      hsn_code: r.hsn_code || '', description: r.description || '', rate_type: r.rate_type || 'fixed',
      fixed_rate: r.fixed_rate != null ? String(r.fixed_rate) : '18',
      slabs: Array.isArray(r.slabs) && r.slabs.length ? r.slabs.map(s => ({ max_rate: s.max_rate ?? '', gst_rate: s.gst_rate ?? '' })) : [{ max_rate: '', gst_rate: '' }],
      effective_from: today(), // date the NEW version starts — not the old row's date
    })
    setModalOpen(true)
  }

  async function openHistory(hsnCode) {
    setHistoryFor(hsnCode)
    setHistoryLoading(true)
    const { data } = await supabase.from('hsn_master').select('*').eq('hsn_code', hsnCode).order('effective_from', { ascending: false })
    setHistoryRows(data || [])
    setHistoryLoading(false)
  }

  function setSlab(i, k, v) { setForm(f => ({ ...f, slabs: f.slabs.map((s, si) => si === i ? { ...s, [k]: v } : s) })) }
  function addSlab()        { setForm(f => ({ ...f, slabs: [...f.slabs, { max_rate: '', gst_rate: '' }] })) }
  function removeSlab(i)    { setForm(f => ({ ...f, slabs: f.slabs.filter((_, si) => si !== i) })) }

  // Every save (new code or editing an existing one) goes through the same
  // hsn_master_insert_version RPC: it closes out whatever version is
  // currently open for that code (if any) and inserts the new one dated
  // from effective_from, atomically. This is what makes past documents
  // immune to future rate edits — they resolve against whichever version
  // was open on their own date, not the latest one. The old direct
  // UPDATE-in-place is gone entirely; there is no way to silently rewrite
  // history through this form anymore.
  async function handleSave() {
    if (!form.hsn_code.trim()) return setToast({ message: 'HSN code is required', type: 'error' })
    if (form.rate_type === 'fixed' && !form.fixed_rate) return setToast({ message: 'Fixed rate is required', type: 'error' })
    if (!form.effective_from) return setToast({ message: 'Effective from date is required', type: 'error' })
    setSaving(true)
    const { error } = await supabase.rpc('hsn_master_insert_version', {
      p_hsn_code: form.hsn_code.trim(),
      p_description: form.description || null,
      p_rate_type: form.rate_type,
      p_fixed_rate: form.rate_type === 'fixed' ? toNum(form.fixed_rate) : null,
      p_slabs: form.rate_type === 'slab'
        ? form.slabs.filter(s => s.gst_rate !== '').map(s => ({ max_rate: s.max_rate === '' ? null : toNum(s.max_rate), gst_rate: toNum(s.gst_rate) }))
        : null,
      p_effective_from: form.effective_from,
    })
    setSaving(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setModalOpen(false)
    setToast({ message: editing ? 'New rate version saved' : 'HSN entry added', type: 'success' })
    load()
  }

  // CHANGED: this now toggles both ways — Deactivate (is_active=false) for an
  // active entry, or Reactivate (is_active=true) for one already inactive —
  // so the same confirm flow serves the "Reactivate" menu item too.
  async function handleDelete() {
    if (!confirmDelete) return
    const { error } = await supabase.from('hsn_master').update({ is_active: !confirmDelete.is_active }).eq('id', confirmDelete.id)
    if (error) setToast({ message: error.message, type: 'error' })
    setConfirmDelete(null)
    load()
  }

  // CHANGED: real delete — removes this rate version permanently, unlike
  // Deactivate (is_active=false) which just hides it from dropdowns while
  // keeping the row so historical documents on old dates still resolve
  // against it. No FK references hsn_master.id (documents store hsn_code as
  // text via buildHSNMap), so this is safe at the DB level; the warning in
  // the confirm dialog covers the app-level risk of removing the only
  // currently-open version for a code.
  async function handleHardDelete() {
    if (!confirmHardDelete) return
    const { error } = await supabase.from('hsn_master').delete().eq('id', confirmHardDelete.id)
    if (error) { setToast({ message: error.message, type: 'error' }); return }
    setConfirmHardDelete(null)
    setToast({ message: 'HSN entry deleted', type: 'success' })
    load()
  }

  // CSV: hsn_code,description,rate_type,fixed_rate,slabs,effective_from —
  // matches the downloadable template in csvTemplate.js exactly (slabs as
  // "threshold:gst_rate|threshold:gst_rate|null:gst_rate"). Routes through
  // the same hsn_master_insert_version RPC as the single-entry form — plain
  // upsert-by-hsn_code no longer works now that a code can have several
  // dated versions, and this keeps CSV imports subject to the same
  // effective-dating (each re-upload of a code adds a new version instead
  // of overwriting its history).
  async function handleCSV() {
    setCsvSaving(true)
    const lines = csvText.trim().split('\n').filter(l => l.trim())
    if (lines.length < 2) { setCsvSaving(false); return setToast({ message: 'Need header + data rows', type: 'error' }) }
    const delim = detectDelimiter(lines[0])
    const header = lines[0].split(delim).map(h => h.trim().toLowerCase())
    let added = 0, errors = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim).map(c => c.trim())
      const row  = {}
      header.forEach((h, j) => { row[h] = cols[j] || '' })
      if (!row.hsn_code) { errors.push(`Row ${i + 1}: hsn_code is required`); continue }
      const rateType = (row.rate_type || 'fixed').toLowerCase()
      if (!['fixed', 'slab'].includes(rateType)) { errors.push(`Row ${i + 1}: rate_type must be "fixed" or "slab"`); continue }
      const { error } = await supabase.rpc('hsn_master_insert_version', {
        p_hsn_code: row.hsn_code,
        p_description: row.description || null,
        p_rate_type: rateType,
        p_fixed_rate: rateType === 'fixed' ? (toNum(row.fixed_rate) || null) : null,
        p_slabs: rateType === 'slab' ? parseSlabsString(row.slabs) : null,
        p_effective_from: row.effective_from || today(),
      })
      if (error) errors.push(`Row ${i + 1} (${row.hsn_code}): ${error.message}`)
      else added++
    }
    setCsvResult({ added, errors })
    await load()
    setCsvSaving(false)
  }

  const filtered = rows.filter(r => !search || r.hsn_code.includes(search) || r.description?.toLowerCase().includes(search.toLowerCase()))

  const columns = [
    { label: 'S.No.',      render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'HSN Code',   render: r => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.hsn_code}</span> },
    { label: 'Description', render: r => <span style={{ fontSize: '12px', color: C.textMid }}>{r.description || '—'}</span> },
    { label: 'Rate Type',  render: r => <Badge status={r.rate_type === 'fixed' ? 'active' : 'pending'} label={r.rate_type === 'fixed' ? 'Fixed' : 'Slab'} /> },
    { label: 'Rate',       render: r => r.rate_type === 'fixed'
        ? <span style={{ fontWeight: 600 }}>{r.fixed_rate}%</span>
        : <span style={{ fontSize: '11px' }}>{formatSlabSummary(r.slabs)}</span> },
    { label: 'Status',     render: r => <Badge status={r.is_active ? 'active' : 'cancelled'} label={r.is_active ? 'Active' : 'Inactive'} /> },
    { label: 'Effective From', render: r => <span style={{ fontSize: '12px', color: C.textMid }}>{fmtDate(r.effective_from)}</span> },
    // CHANGED: consolidated into a single Actions dropdown (New Version,
    // History, Deactivate/Reactivate, Delete) instead of four separate buttons.
    { label: 'Actions', render: r => (
      <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => setOpenActionsFor(id => id === r.id ? null : r.id)}>Actions ▾</Btn>
        {openActionsFor === r.id && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setOpenActionsFor(null)} />
            <div style={{
              position: 'absolute', right: 0, top: '100%', marginTop: '4px', zIndex: 11,
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.12)', minWidth: '160px', overflow: 'hidden',
            }}>
              {[
                { label: 'New Version', onClick: () => openEdit(r) },
                { label: 'History', onClick: () => openHistory(r.hsn_code) },
                { label: r.is_active ? 'Deactivate' : 'Reactivate', onClick: () => setConfirmDelete(r), danger: r.is_active },
                { label: 'Delete', onClick: () => setConfirmHardDelete(r), danger: true },
              ].map(item => (
                <button key={item.label} onClick={() => { item.onClick(); setOpenActionsFor(null) }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px',
                    border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: '13px', color: item.danger ? C.danger : C.text,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = C.bg}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  {item.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    )},
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search HSN code or description…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, fontFamily: 'inherit' }} />
        <Btn variant='ghost' onClick={() => { setCsvText(''); setCsvResult(null); setCsvModal(true) }}>↑ CSV Upload</Btn>
        <Btn onClick={openNew}>+ New HSN Entry</Btn>
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered}
              emptyState={<EmptyState icon='📋' title='No HSN entries' action={<Btn onClick={openNew}>+ New HSN Entry</Btn>} />}
            />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? `New Rate Version — ${editing.hsn_code}` : 'New HSN Entry'} width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {editing && (
            <div style={{ fontSize: '12px', color: C.textMid, background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '8px 12px' }}>
              Current version effective since <b>{fmtDate(editing.effective_from)}</b>. Saving below closes that version out and starts a new one — it never overwrites history.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='HSN Code' required><Input value={form.hsn_code} onChange={e => setF('hsn_code', e.target.value)} disabled={!!editing} style={{ fontFamily: 'monospace' }} /></FormRow>
            <FormRow label='Rate Type'>
              <Select value={form.rate_type} onChange={e => setF('rate_type', e.target.value)}>
                <option value='fixed'>Fixed</option>
                <option value='slab'>Slab (by rate/unit)</option>
              </Select>
            </FormRow>
          </div>
          <FormRow label='Effective From' required>
            <Input type='date' value={form.effective_from} onChange={e => setF('effective_from', e.target.value)} />
          </FormRow>
          <FormRow label='Description'><Textarea value={form.description} onChange={e => setF('description', e.target.value)} rows={2} /></FormRow>

          {form.rate_type === 'fixed' ? (
            <FormRow label='GST Rate %' required><Input type='number' value={form.fixed_rate} onChange={e => setF('fixed_rate', e.target.value)} /></FormRow>
          ) : (
            <FormRow label='Slabs — rate/unit threshold → GST %'>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {form.slabs.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <Input type='number' placeholder='Max ₹/unit (blank = open-ended)' value={s.max_rate} onChange={e => setSlab(i, 'max_rate', e.target.value)} />
                    <Input type='number' placeholder='GST %' value={s.gst_rate} onChange={e => setSlab(i, 'gst_rate', e.target.value)} style={{ maxWidth: '90px' }} />
                    <Btn size='sm' variant='ghost' onClick={() => removeSlab(i)} style={{ color: C.danger }}>✕</Btn>
                  </div>
                ))}
                <Btn size='sm' variant='ghost' onClick={addSlab}>+ Add Slab</Btn>
                <div style={{ fontSize: '11px', color: C.textMuted }}>Leave the last slab's threshold blank for the open-ended fallback rate.</div>
              </div>
            </FormRow>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save as New Version' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>

      <Modal open={!!historyFor} onClose={() => setHistoryFor(null)} title={`Rate History — ${historyFor || ''}`} width={520}>
        {historyLoading
          ? <div style={{ padding: '24px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {historyRows.map(r => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: '6px', background: r.effective_to ? C.bg : '#e8f3ec' }}>
                  <div style={{ fontSize: '12px', color: C.textMid }}>
                    {fmtDate(r.effective_from)} → {r.effective_to ? fmtDate(r.effective_to) : 'current'}
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>
                    {r.rate_type === 'fixed' ? `${r.fixed_rate}%` : formatSlabSummary(r.slabs)}
                  </div>
                </div>
              ))}
              {historyRows.length === 0 && <div style={{ color: C.textMuted, fontSize: '13px' }}>No versions found.</div>}
            </div>
          )
        }
      </Modal>

      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='CSV Upload — HSN Master' width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: C.textMid }}>
            Columns: <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>hsn_code,description,rate_type,fixed_rate,slabs,effective_from</code><br />
            slabs format for rate_type=slab: <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>1000:5|null:12</code> (threshold:gst_rate pairs separated by |, null = open-ended).<br />
            effective_from is optional (blank = today). Re-uploading an existing HSN code adds a new dated version rather than overwriting its history.
          </div>
          <Btn size='sm' variant='ghost' onClick={() => downloadTemplate('hsn_master')}>↓ Download Template</Btn>
          <CsvFileDrop onText={setCsvText} />
          <Textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={6} placeholder='Or paste CSV text here…' style={{ fontFamily: 'monospace', fontSize: '11px' }} />
          {csvResult && (
            <div style={{ background: csvResult.errors.length > 0 ? '#fff3cc' : '#e8f3ec', border: `1px solid ${csvResult.errors.length > 0 ? '#e6c040' : '#b8dfc8'}`, borderRadius: '6px', padding: '10px 14px', fontSize: '12px' }}>
              {csvResult.added} added/updated, {csvResult.errors.length} error{csvResult.errors.length === 1 ? '' : 's'}.
              {csvResult.errors.map((e, i) => <div key={i} style={{ color: '#7a5000', marginTop: '4px' }}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setCsvModal(false)}>Close</Btn>
            <Btn onClick={handleCSV} disabled={csvSaving || !csvText.trim()}>{csvSaving ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title={confirmDelete?.is_active ? 'Deactivate HSN Entry' : 'Reactivate HSN Entry'}
        message={confirmDelete?.is_active
          ? `Deactivate "${confirmDelete?.hsn_code}"? It stays visible in History and old documents still resolve against it — it just won't show in dropdowns for new ones.`
          : `Reactivate "${confirmDelete?.hsn_code}"? It'll show in dropdowns again.`}
        danger={confirmDelete?.is_active} />
      {/* CHANGED: real delete — permanently removes this rate version, unlike Deactivate above. */}
      <ConfirmModal open={!!confirmHardDelete} onClose={() => setConfirmHardDelete(null)} onConfirm={handleHardDelete}
        title='Delete HSN Entry' danger
        message={`Permanently delete "${confirmHardDelete?.hsn_code}"${confirmHardDelete?.effective_to === null ? ' — this is its current rate version' : ''}? This cannot be undone. If any document still needs this rate on its own date, use Deactivate instead.`} />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Users Tab ──────────────────────────────────────────────────────────────────
// Editing existing profiles (role, active/revoked, entity grants) was always
// supported here. Creating new users now goes through the create-user Edge
// Function (supabase/functions/create-user) since profiles/user_entity_access
// have no client-writable INSERT policy for anyone but the SECURITY DEFINER
// signup trigger — only master and admin may call it. Master can create any
// role for any entity; admin can only create entity_user/viewer, scoped to
// entities the admin themselves already holds a grant for (enforced again,
// server-side, inside the Edge Function — this UI only mirrors that scoping
// so an admin never sees an option they'd be rejected for anyway).
const ROLES = ['master', 'admin', 'entity_user', 'viewer']

function Users() {
  const { profile: me } = useAuth()
  const myRole = me?.role
  const iAmMaster = myRole === 'master'
  const iAmAdmin  = myRole === 'admin'
  const canAddUsers = iAmMaster || iAmAdmin

  const [rows, setRows]         = useState([])
  const [entities, setEntities] = useState([])
  const [accessMap, setAccessMap] = useState({}) // user_id -> [entity_id, ...]
  // CHANGED: separate, additive map for time-bound access — kept apart from
  // accessMap so grantableEntities/entityLabel/column rendering (all built on
  // accessMap's array shape) don't need to change at all.
  const [accessExpiryMap, setAccessExpiryMap] = useState({}) // user_id -> {entity_id: expires_at | null}
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState({ role: 'entity_user', is_active: true, entityIds: [], expiryByEntity: {} })
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  // New-user modal state — separate from the edit modal above since the
  // fields (email, password) and the save path (Edge Function vs. direct
  // table update) are different.
  const EMPTY_NEW_USER = { full_name: '', email: '', role: 'entity_user', entityIds: [], expiryByEntity: {}, password: '' }
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [newUser, setNewUser]   = useState(EMPTY_NEW_USER)
  const [adding, setAdding]     = useState(false)

  // Master may assign any role; admin is limited to entity_user/viewer so an
  // admin can never mint another admin or a master (privilege escalation).
  const assignableRoles = iAmMaster ? ROLES : ['entity_user', 'viewer']
  // Master may grant any active entity; admin may only grant entities they
  // themselves have been granted (accessMap[me.id] — already scoped correctly
  // by RLS, since a non-master can only ever see their own access rows).
  const grantableEntities = iAmMaster ? entities : entities.filter(e => (accessMap[me?.id] || []).includes(e.id))

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: profiles }, { data: es }, { data: access }] = await Promise.all([
      supabase.from('profiles').select('*').order('full_name'),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('user_entity_access').select('user_id, entity_id, expires_at'),
    ])
    setRows(profiles || [])
    setEntities(es || [])
    const map = {}
    const expiryMap = {}
    for (const a of (access || [])) {
      if (!map[a.user_id]) map[a.user_id] = []
      map[a.user_id].push(a.entity_id)
      if (!expiryMap[a.user_id]) expiryMap[a.user_id] = {}
      expiryMap[a.user_id][a.entity_id] = a.expires_at
    }
    setAccessMap(map)
    setAccessExpiryMap(expiryMap)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openEdit(r) {
    setEditing(r)
    // Prefill each granted entity's expiry as a plain YYYY-MM-DD for the date
    // input; a still-permanent (null expires_at) entity is simply absent here.
    const expiryByEntity = {}
    for (const [entityId, expiresAt] of Object.entries(accessExpiryMap[r.id] || {})) {
      if (expiresAt) expiryByEntity[entityId] = expiresAt.slice(0, 10)
    }
    setForm({ role: r.role || 'entity_user', is_active: r.is_active !== false, entityIds: accessMap[r.id] || [], expiryByEntity })
    setModalOpen(true)
  }

  function toggleEntity(id) {
    setForm(f => ({ ...f, entityIds: f.entityIds.includes(id) ? f.entityIds.filter(x => x !== id) : [...f.entityIds, id] }))
  }

  // CHANGED: optional per-entity expiry — blank means permanent (unchanged
  // behavior). Stored as end-of-day so access holds through the chosen date.
  function setExpiry(entityId, dateStr) {
    setForm(f => {
      const next = { ...f.expiryByEntity }
      if (dateStr) next[entityId] = dateStr; else delete next[entityId]
      return { ...f, expiryByEntity: next }
    })
  }

  async function handleSave() {
    if (!editing) return
    setSaving(true)
    const { error } = await supabase.from('profiles').update({ role: form.role, is_active: form.is_active, updated_at: new Date() }).eq('id', editing.id)
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }

    // CHANGED: replace this user's entity grants wholesale with the
    // selected set — simplest correct approach given access rows have no
    // other fields we'd need to preserve (only access_level, always 'full'
    // here; view_only isn't exposed in this UI yet).
    const { error: delErr } = await supabase.from('user_entity_access').delete().eq('user_id', editing.id)
    if (delErr) { setSaving(false); return setToast({ message: `Role saved, but entity access failed: ${delErr.message}`, type: 'error' }) }
    if (form.entityIds.length > 0) {
      const { error: insErr } = await supabase.from('user_entity_access').insert(
        form.entityIds.map(entity_id => ({
          user_id: editing.id, entity_id, access_level: 'full',
          // CHANGED: optional time-bound access — end of the chosen day, or
          // permanent (null) if no expiry was set for this entity.
          expires_at: form.expiryByEntity[entity_id] ? `${form.expiryByEntity[entity_id]}T23:59:59` : null,
        }))
      )
      if (insErr) { setSaving(false); return setToast({ message: `Role saved, but entity access failed: ${insErr.message}`, type: 'error' }) }
    }

    setSaving(false)
    setModalOpen(false)
    setToast({ message: 'User updated', type: 'success' })
    load()
  }

  const [resettingPw, setResettingPw] = useState(false)
  // Mirrors the create-user Edge Function's role restriction client-side so
  // the button doesn't invite an admin into a reset that the function would
  // reject anyway — admin can only touch entity_user/viewer passwords.
  const canResetPassword = editing && (iAmMaster || (iAmAdmin && !['master', 'admin'].includes(editing.role)))

  async function handleResetPassword() {
    if (!editing) return
    setResettingPw(true)
    const { data, error } = await supabase.functions.invoke('update-user-password', {
      body: { user_id: editing.id },
    })
    setResettingPw(false)
    if (error) {
      let serverMessage = error.message
      try {
        if (error.context && typeof error.context.json === 'function') {
          const body = await error.context.json()
          serverMessage = body?.error || serverMessage
        }
      } catch { /* fall back to error.message below */ }
      return setToast({ message: serverMessage, type: 'error' })
    }
    if (data?.error) return setToast({ message: data.error, type: 'error' })
    setToast({ message: `Password reset. Temporary password: ${data?.temp_password}`, type: 'success' })
  }

  function openAddUser() {
    setNewUser(EMPTY_NEW_USER)
    setAddModalOpen(true)
  }

  function toggleNewUserEntity(id) {
    setNewUser(f => ({ ...f, entityIds: f.entityIds.includes(id) ? f.entityIds.filter(x => x !== id) : [...f.entityIds, id] }))
  }

  // CHANGED: optional per-entity expiry for a brand-new user, same idea as setExpiry() above.
  function setNewUserExpiry(entityId, dateStr) {
    setNewUser(f => {
      const next = { ...f.expiryByEntity }
      if (dateStr) next[entityId] = dateStr; else delete next[entityId]
      return { ...f, expiryByEntity: next }
    })
  }

  async function handleAddUser() {
    if (!newUser.full_name.trim() || !newUser.email.trim()) {
      return setToast({ message: 'Name and email are required', type: 'error' })
    }
    if (newUser.role !== 'master' && newUser.entityIds.length === 0) {
      return setToast({ message: 'Select at least one entity for this role', type: 'error' })
    }
    setAdding(true)
    // CHANGED: entity_expiries is optional and additive — omitting an entity
    // id from it (or the whole field) means permanent access, same as before.
    const entity_expiries = {}
    for (const [entityId, dateStr] of Object.entries(newUser.expiryByEntity)) {
      if (dateStr) entity_expiries[entityId] = `${dateStr}T23:59:59`
    }
    const { data, error } = await supabase.functions.invoke('create-user', {
      body: {
        full_name: newUser.full_name.trim(),
        email: newUser.email.trim(),
        role: newUser.role,
        entity_ids: newUser.entityIds,
        entity_expiries,
        password: newUser.password.trim() || undefined,
      },
    })
    setAdding(false)
    // Edge Function errors (4xx/5xx) surface through `error`, not `data`.
    // supabase-js wraps the raw Response on error.context rather than parsing
    // it — our function always replies with JSON `{ error: '...' }`, so pull
    // the real message out of that body instead of the generic HTTP message.
    if (error) {
      let serverMessage = error.message
      try {
        if (error.context && typeof error.context.json === 'function') {
          const body = await error.context.json()
          serverMessage = body?.error || serverMessage
        }
      } catch { /* fall back to error.message below */ }
      return setToast({ message: serverMessage, type: 'error' })
    }
    if (data?.error) return setToast({ message: data.error, type: 'error' })
    setAddModalOpen(false)
    setToast({
      message: data?.temp_password
        ? `User created. Temporary password: ${data.temp_password}`
        : 'User created',
      type: 'success',
    })
    load()
  }

  function entityLabel(entityIds, role) {
    if (role === 'master') return <span style={{ color: C.textMuted }}>All (master)</span>
    if (!entityIds || entityIds.length === 0) return <span style={{ color: C.danger }}>None assigned</span>
    const names = entityIds.map(id => entities.find(e => e.id === id)?.short_name || entities.find(e => e.id === id)?.name).filter(Boolean)
    return <span style={{ fontSize: '12px' }}>{names.join(', ')}</span>
  }

  const columns = [
    { label: 'S.No.',   render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Name',    render: r => <span style={{ fontWeight: 600 }}>{r.full_name}</span> },
    { label: 'Email',   render: r => <span style={{ fontSize: '12px', color: C.textMid }}>{r.email}</span> },
    { label: 'Phone',   render: r => r.phone || '—' },
    { label: 'Role',    render: r => <Badge status={r.role === 'master' ? 'active' : 'pending'} label={r.role} /> },
    { label: 'Entities', render: r => entityLabel(accessMap[r.id], r.role) },
    { label: 'Status',  render: r => <Badge status={r.is_active ? 'active' : 'cancelled'} label={r.is_active ? 'Active' : 'Revoked'} /> },
    { label: 'Actions', render: r => (
      <div onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
      </div>
    )},
  ]

  return (
    <div>
      {canAddUsers && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
          <Btn onClick={openAddUser}>+ Add User</Btn>
        </div>
      )}
      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={rows}
              emptyState={<EmptyState icon='👤' title='No users yet' message={canAddUsers ? 'Add a user above, or they’ll appear here once they sign in for the first time.' : 'Users appear here once they sign in for the first time.'} />}
            />
        }
      </Card>

      <Modal open={addModalOpen} onClose={() => setAddModalOpen(false)} title='Add User' width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Full Name' required>
            <Input value={newUser.full_name} onChange={e => setNewUser(f => ({ ...f, full_name: e.target.value }))} />
          </FormRow>
          <FormRow label='Email' required>
            <Input type='email' value={newUser.email} onChange={e => setNewUser(f => ({ ...f, email: e.target.value }))} />
          </FormRow>
          <FormRow label='Role'>
            <Select value={newUser.role} onChange={e => setNewUser(f => ({ ...f, role: e.target.value }))}>
              {assignableRoles.map(r => <option key={r} value={r}>{r}</option>)}
            </Select>
          </FormRow>

          <FormRow label={newUser.role === 'master' ? 'Entity Access (master sees all)' : 'Entity Access'}>
            <div style={{
              display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto',
              border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 12px',
              opacity: newUser.role === 'master' ? 0.5 : 1, pointerEvents: newUser.role === 'master' ? 'none' : 'auto',
            }}>
              {grantableEntities.map(ent => {
                const checked = newUser.entityIds.includes(ent.id)
                return (
                  <div key={ent.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer', flex: 1 }}>
                      <input type='checkbox' checked={checked} onChange={() => toggleNewUserEntity(ent.id)} style={{ width: '14px', height: '14px' }} />
                      {ent.short_name || ent.name}
                    </label>
                    {checked && (
                      <input type='date' value={newUser.expiryByEntity[ent.id] || ''} onChange={e => setNewUserExpiry(ent.id, e.target.value)}
                        title='Access expires end of this day (blank = permanent)'
                        style={{ fontSize: '11px', padding: '3px 6px', border: `1px solid ${C.border}`, borderRadius: '4px', fontFamily: 'inherit', color: C.textSoft }} />
                    )}
                  </div>
                )
              })}
              {grantableEntities.length === 0 && (
                <span style={{ fontSize: '12px', color: C.textMuted }}>
                  {iAmAdmin ? 'You have no entity access yourself to grant from.' : 'No active entities found.'}
                </span>
              )}
            </div>
          </FormRow>

          <FormRow label='Password' hint='Leave blank to auto-generate a temporary password'>
            <Input type='text' value={newUser.password} onChange={e => setNewUser(f => ({ ...f, password: e.target.value }))} placeholder='Auto-generated if blank' />
          </FormRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setAddModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleAddUser} disabled={adding}>{adding ? 'Creating…' : 'Create User'}</Btn>
          </div>
        </div>
      </Modal>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={`Edit User — ${editing?.full_name || ''}`} width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Role'>
            <Select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </Select>
          </FormRow>

          {/* CHANGED: entity access — multi-select checkboxes. Disabled for
              master since master sees everything regardless of grants. */}
          <FormRow label={form.role === 'master' ? 'Entity Access (master sees all)' : 'Entity Access'}>
            <div style={{
              display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto',
              border: `1px solid ${C.border}`, borderRadius: '6px', padding: '10px 12px',
              opacity: form.role === 'master' ? 0.5 : 1, pointerEvents: form.role === 'master' ? 'none' : 'auto',
            }}>
              {entities.map(ent => {
                const checked = form.entityIds.includes(ent.id)
                return (
                  <div key={ent.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer', flex: 1 }}>
                      <input type='checkbox' checked={checked} onChange={() => toggleEntity(ent.id)} style={{ width: '14px', height: '14px' }} />
                      {ent.short_name || ent.name}
                    </label>
                    {/* CHANGED: optional per-entity expiry — blank = permanent access, unchanged from today's behavior */}
                    {checked && (
                      <input type='date' value={form.expiryByEntity[ent.id] || ''} onChange={e => setExpiry(ent.id, e.target.value)}
                        title='Access expires end of this day (blank = permanent)'
                        style={{ fontSize: '11px', padding: '3px 6px', border: `1px solid ${C.border}`, borderRadius: '4px', fontFamily: 'inherit', color: C.textSoft }} />
                    )}
                  </div>
                )
              })}
              {entities.length === 0 && <span style={{ fontSize: '12px', color: C.textMuted }}>No active entities found.</span>}
            </div>
          </FormRow>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='user_active' checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} style={{ width: '14px', height: '14px' }} />
            <label htmlFor='user_active' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>Active (unchecking revokes sign-in access)</label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            {canResetPassword
              ? <Btn variant='ghost' onClick={handleResetPassword} disabled={resettingPw} style={{ color: C.danger }}>{resettingPw ? 'Resetting…' : 'Reset Password'}</Btn>
              : <span />}
            <div style={{ display: 'flex', gap: '10px' }}>
              <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
              <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
            </div>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Parties Tab ────────────────────────────────────────────────────────────────
// Global vendor/supplier master, shared across all entities. Master/admin only
// (RLS parties_write gates on role IN ('master','admin')).
const EMPTY_PARTY = {
  name: '', gstin: '', pan: '', contact_person: '', phone: '', email: '',
  address: '', payment_terms: '', payment_days: '', notes: '', is_active: true,
}

function Parties() {
  const { profile } = useAuth()
  const canManage = hasFullAccess(profile)
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(EMPTY_PARTY)
  const [saving, setSaving]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('parties').select('*').eq('is_deleted', false).order('name')
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function openNew()  { setEditing(null); setForm(EMPTY_PARTY); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({
      name: r.name || '', gstin: r.gstin || '', pan: r.pan || '',
      contact_person: r.contact_person || '', phone: r.phone || '', email: r.email || '',
      address: r.address || '', payment_terms: r.payment_terms || '',
      payment_days: r.payment_days ?? '', notes: r.notes || '', is_active: r.is_active,
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) return setToast({ message: 'Name is required', type: 'error' })
    const days = form.payment_days === '' ? null : parseInt(form.payment_days, 10)
    if (days !== null && (isNaN(days) || days < 0)) return setToast({ message: 'Payment days must be a positive number', type: 'error' })
    if (!isValidGSTIN(form.gstin)) return setToast({ message: GSTIN_ERROR, type: 'error' })
    if (!isValidPAN(form.pan)) return setToast({ message: PAN_ERROR, type: 'error' })
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      gstin: form.gstin.trim().toUpperCase() || null,
      pan: form.pan.trim().toUpperCase() || null,
      contact_person: form.contact_person.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      payment_terms: form.payment_terms.trim() || null,
      payment_days: days,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
    }
    const res = editing
      ? await supabase.from('parties').update(payload).eq('id', editing.id)
      : await supabase.from('parties').insert(payload)
    setSaving(false)
    if (res.error) {
      const msg = res.error.code === '23505' ? 'A party with this GSTIN already exists' : res.error.message
      return setToast({ message: msg, type: 'error' })
    }
    setModalOpen(false)
    setToast({ message: editing ? 'Party updated' : 'Party added', type: 'success' })
    load()
  }

  async function handleDelete() {
    if (!confirmDelete) return
    const { error } = await supabase.from('parties').update({ is_deleted: true }).eq('id', confirmDelete.id)
    if (error) setToast({ message: `Could not delete — ${error.message}`, type: 'error' })
    else setToast({ message: 'Party removed', type: 'success' })
    setConfirmDelete(null)
    load()
  }

  const filtered = rows.filter(r => {
    if (!search) return true
    const q = search.toLowerCase()
    return r.name?.toLowerCase().includes(q) || r.gstin?.toLowerCase().includes(q) || r.contact_person?.toLowerCase().includes(q)
  })

  const columns = [
    { label: 'S.No.', render: (r, i) => <span style={{ color: C.textMuted }}>{i + 1}</span> },
    { label: 'Name',  render: r => <span style={{ fontWeight: 600 }}>{r.name}{!r.is_active && <span style={{ color: C.textMuted, fontWeight: 400 }}> (inactive)</span>}</span> },
    { label: 'GSTIN', render: r => <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{r.gstin || '—'}</span> },
    { label: 'Contact', render: r => <span style={{ fontSize: '12px', color: C.textMid }}>{r.contact_person || r.phone || '—'}</span> },
    { label: 'Payment', render: r => <span style={{ fontSize: '12px' }}>{r.payment_days != null ? `${r.payment_days} days` : (r.payment_terms || '—')}</span> },
    ...(canManage ? [{ label: 'Actions', render: r => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Delete</Btn>
      </div>
    )}] : []),
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search name, GSTIN, contact…'
          style={{ padding: '8px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', flex: 1, fontFamily: 'inherit' }} />
        {canManage && <Btn onClick={openNew}>+ New Party</Btn>}
      </div>
      {!canManage && (
        <div style={{ fontSize: '12px', color: C.textMuted, marginBottom: '12px' }}>Only master/admin can add or edit parties.</div>
      )}
      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered}
              emptyState={<EmptyState icon='🤝' title='No parties yet' action={canManage ? <Btn onClick={openNew}>+ New Party</Btn> : undefined} />}
            />
        }
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Party' : 'New Party'} width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FormRow label='Name' required><Input value={form.name} onChange={e => setF('name', e.target.value)} placeholder='Full legal / trade name' /></FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='GSTIN' error={!isValidGSTIN(form.gstin) ? GSTIN_ERROR : undefined}><Input value={form.gstin} onChange={e => setF('gstin', e.target.value.toUpperCase())} placeholder='22AAAAA0000A1Z5' style={{ fontFamily: 'monospace' }} /></FormRow>
            <FormRow label='PAN' error={!isValidPAN(form.pan) ? PAN_ERROR : undefined}><Input value={form.pan} onChange={e => setF('pan', e.target.value.toUpperCase())} placeholder='AAAAA0000A' style={{ fontFamily: 'monospace' }} /></FormRow>
            <FormRow label='Contact Person'><Input value={form.contact_person} onChange={e => setF('contact_person', e.target.value)} /></FormRow>
            <FormRow label='Phone'><Input value={form.phone} onChange={e => setF('phone', e.target.value)} /></FormRow>
            <FormRow label='Email'><Input type='email' value={form.email} onChange={e => setF('email', e.target.value)} /></FormRow>
            <FormRow label='Status'>
              <Select value={form.is_active ? 'active' : 'inactive'} onChange={e => setF('is_active', e.target.value === 'active')}>
                <option value='active'>Active</option>
                <option value='inactive'>Inactive</option>
              </Select>
            </FormRow>
          </div>
          <FormRow label='Address'><Textarea value={form.address} onChange={e => setF('address', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='Payment Terms' hint='Optional label, e.g. "Net 30", "Advance"'><Input value={form.payment_terms} onChange={e => setF('payment_terms', e.target.value)} /></FormRow>
            <FormRow label='Payment Days' hint='Days to due date — auto-fills an expense’s due date'><Input type='number' value={form.payment_days} onChange={e => setF('payment_days', e.target.value)} placeholder='e.g. 30' /></FormRow>
          </div>
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>

      <ConfirmModal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} onConfirm={handleDelete}
        title='Delete Party' message={`Delete "${confirmDelete?.name}"? Expenses already tagged to it keep their vendor details.`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Settings Shell ─────────────────────────────────────────────────────────────
export default function Settings() {
  const [tab, setTab] = useState('Financial Years')
  return (
    <div>
      <PageHeader title='Settings' subtitle='Financial years, entity groups, HSN master and users' />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `2px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            fontWeight: tab === t ? 700 : 500, fontSize: '13px',
            color: tab === t ? C.text : C.textSoft, background: 'transparent',
            borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: '-2px', transition: 'all 0.15s',
          }}>{t}</button>
        ))}
      </div>
      {tab === 'My Profile'      && <MyProfile />}
      {tab === 'Financial Years' && <FinancialYears />}
      {tab === 'Entity Groups'   && <EntityGroups />}
      {tab === 'HSN Master'      && <HsnMaster />}
      {tab === 'Parties'         && <Parties />}
      {tab === 'Users'           && <Users />}
    </div>
  )
}
