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

// REBUILT — this file was found to contain a copy of the Invoices module
// (src/pages/Invoices/index.jsx) instead of Settings, which is why /settings
// was rendering the invoice list. Rebuilt from scratch against the actual
// schema (financial_years, entity_groups, hsn_master, profiles) and the
// existing hsn_master CSV template format already defined in csvTemplate.js.
// If a better version turns up in git history, prefer that over this file.

const TABS = ['Financial Years', 'Entity Groups', 'HSN Master', 'Users']

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
const EMPTY_HSN = { hsn_code: '', description: '', rate_type: 'fixed', fixed_rate: '18', slabs: [{ max_rate: '', gst_rate: '' }], is_active: true }

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

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('hsn_master').select('*').order('hsn_code')
    setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function openNew()  { setEditing(null); setForm(EMPTY_HSN); setModalOpen(true) }
  function openEdit(r) {
    setEditing(r)
    setForm({
      hsn_code: r.hsn_code || '', description: r.description || '', rate_type: r.rate_type || 'fixed',
      fixed_rate: r.fixed_rate != null ? String(r.fixed_rate) : '18',
      slabs: Array.isArray(r.slabs) && r.slabs.length ? r.slabs.map(s => ({ max_rate: s.max_rate ?? '', gst_rate: s.gst_rate ?? '' })) : [{ max_rate: '', gst_rate: '' }],
      is_active: r.is_active !== false,
    })
    setModalOpen(true)
  }

  function setSlab(i, k, v) { setForm(f => ({ ...f, slabs: f.slabs.map((s, si) => si === i ? { ...s, [k]: v } : s) })) }
  function addSlab()        { setForm(f => ({ ...f, slabs: [...f.slabs, { max_rate: '', gst_rate: '' }] })) }
  function removeSlab(i)    { setForm(f => ({ ...f, slabs: f.slabs.filter((_, si) => si !== i) })) }

  async function handleSave() {
    if (!form.hsn_code.trim()) return setToast({ message: 'HSN code is required', type: 'error' })
    if (form.rate_type === 'fixed' && !form.fixed_rate) return setToast({ message: 'Fixed rate is required', type: 'error' })
    setSaving(true)
    const payload = {
      hsn_code: form.hsn_code.trim(), description: form.description || null, rate_type: form.rate_type,
      fixed_rate: form.rate_type === 'fixed' ? toNum(form.fixed_rate) : null,
      slabs: form.rate_type === 'slab'
        ? form.slabs.filter(s => s.gst_rate !== '').map(s => ({ max_rate: s.max_rate === '' ? null : toNum(s.max_rate), gst_rate: toNum(s.gst_rate) }))
        : null,
      is_active: form.is_active, updated_at: new Date(),
    }
    const res = editing
      ? await supabase.from('hsn_master').update(payload).eq('id', editing.id)
      : await supabase.from('hsn_master').insert(payload)
    setSaving(false)
    if (res.error) return setToast({ message: res.error.message, type: 'error' })
    setModalOpen(false)
    setToast({ message: editing ? 'HSN entry updated' : 'HSN entry added', type: 'success' })
    load()
  }

  async function handleDelete() {
    if (!confirmDelete) return
    const { error } = await supabase.from('hsn_master').update({ is_active: false }).eq('id', confirmDelete.id)
    if (error) setToast({ message: error.message, type: 'error' })
    setConfirmDelete(null)
    load()
  }

  // CSV: hsn_code,description,rate_type,fixed_rate,slabs — matches the
  // downloadable template in csvTemplate.js exactly (slabs as
  // "threshold:gst_rate|threshold:gst_rate|null:gst_rate").
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
      const { error } = await supabase.from('hsn_master').upsert({
        hsn_code: row.hsn_code, description: row.description || null, rate_type: rateType,
        fixed_rate: rateType === 'fixed' ? (toNum(row.fixed_rate) || null) : null,
        slabs: rateType === 'slab' ? parseSlabsString(row.slabs) : null,
        is_active: true, updated_at: new Date(),
      }, { onConflict: 'hsn_code' })
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
    { label: 'Actions', render: r => (
      <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
        <Btn size='sm' variant='ghost' onClick={() => openEdit(r)}>Edit</Btn>
        <Btn size='sm' variant='ghost' onClick={() => setConfirmDelete(r)} style={{ color: C.danger }}>Deactivate</Btn>
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

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit HSN Entry' : 'New HSN Entry'} width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormRow label='HSN Code' required><Input value={form.hsn_code} onChange={e => setF('hsn_code', e.target.value)} style={{ fontFamily: 'monospace' }} /></FormRow>
            <FormRow label='Rate Type'>
              <Select value={form.rate_type} onChange={e => setF('rate_type', e.target.value)}>
                <option value='fixed'>Fixed</option>
                <option value='slab'>Slab (by rate/unit)</option>
              </Select>
            </FormRow>
          </div>
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

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='hsn_active' checked={form.is_active} onChange={e => setF('is_active', e.target.checked)} style={{ width: '14px', height: '14px' }} />
            <label htmlFor='hsn_active' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>Active</label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create'}</Btn>
          </div>
        </div>
      </Modal>

      <Modal open={csvModal} onClose={() => setCsvModal(false)} title='CSV Upload — HSN Master' width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: C.textMid }}>
            Columns: <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>hsn_code,description,rate_type,fixed_rate,slabs</code><br />
            slabs format for rate_type=slab: <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>1000:5|null:12</code> (threshold:gst_rate pairs separated by |, null = open-ended).
            Re-uploading updates an existing HSN code rather than duplicating it.
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
        title='Deactivate HSN Entry' message={`Deactivate "${confirmDelete?.hsn_code}"?`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Users Tab ──────────────────────────────────────────────────────────────────
// No create/delete here — profiles are created automatically on sign-in
// (see handle_new_user() trigger in 001_phase1.sql). This tab manages role,
// active/revoked status, and which entities each user can access.
// CHANGED: entity access — backed by user_entity_access (present since
// 001_phase1.sql: user_id, entity_id, access_level). A 'master' role user
// implicitly sees everything (per user_has_entity_access() in the same
// migration), so the entity picker is only meaningful for non-master roles
// — shown but not required for master.
const ROLES = ['master', 'entity_user', 'viewer']

function Users() {
  const [rows, setRows]         = useState([])
  const [entities, setEntities] = useState([])
  const [accessMap, setAccessMap] = useState({}) // user_id -> [entity_id, ...]
  const [loading, setLoading]   = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState({ role: 'entity_user', is_active: true, entityIds: [] })
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: profiles }, { data: es }, { data: access }] = await Promise.all([
      supabase.from('profiles').select('*').order('full_name'),
      supabase.from('entities').select('id,name,short_name').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('user_entity_access').select('user_id, entity_id'),
    ])
    setRows(profiles || [])
    setEntities(es || [])
    const map = {}
    for (const a of (access || [])) {
      if (!map[a.user_id]) map[a.user_id] = []
      map[a.user_id].push(a.entity_id)
    }
    setAccessMap(map)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openEdit(r) {
    setEditing(r)
    setForm({ role: r.role || 'entity_user', is_active: r.is_active !== false, entityIds: accessMap[r.id] || [] })
    setModalOpen(true)
  }

  function toggleEntity(id) {
    setForm(f => ({ ...f, entityIds: f.entityIds.includes(id) ? f.entityIds.filter(x => x !== id) : [...f.entityIds, id] }))
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
        form.entityIds.map(entity_id => ({ user_id: editing.id, entity_id, access_level: 'full' }))
      )
      if (insErr) { setSaving(false); return setToast({ message: `Role saved, but entity access failed: ${insErr.message}`, type: 'error' }) }
    }

    setSaving(false)
    setModalOpen(false)
    setToast({ message: 'User updated', type: 'success' })
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
      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={rows}
              emptyState={<EmptyState icon='👤' title='No users yet' message='Users appear here once they sign in for the first time.' />}
            />
        }
      </Card>

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
              {entities.map(ent => (
                <label key={ent.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                  <input type='checkbox' checked={form.entityIds.includes(ent.id)} onChange={() => toggleEntity(ent.id)} style={{ width: '14px', height: '14px' }} />
                  {ent.short_name || ent.name}
                </label>
              ))}
              {entities.length === 0 && <span style={{ fontSize: '12px', color: C.textMuted }}>No active entities found.</span>}
            </div>
          </FormRow>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type='checkbox' id='user_active' checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} style={{ width: '14px', height: '14px' }} />
            <label htmlFor='user_active' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>Active (unchecking revokes sign-in access)</label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Btn>
          </div>
        </div>
      </Modal>

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
      {tab === 'Financial Years' && <FinancialYears />}
      {tab === 'Entity Groups'   && <EntityGroups />}
      {tab === 'HSN Master'      && <HsnMaster />}
      {tab === 'Users'           && <Users />}
    </div>
  )
}
