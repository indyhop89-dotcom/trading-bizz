import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import DocumentAttachments from '../../components/DocumentAttachments'
import { formatINR } from '../../utils/money'
import { fmtDate, today, currentFYLabel } from '../../utils/dates'
import { buildHSNMap } from '../../utils/hsn'

const NOTE_TYPES = ['credit_note', 'debit_note']
const REASONS    = ['return', 'rate_correction', 'quantity_correction', 'other']
const STATUSES   = ['draft', 'submitted', 'cancelled']

// ─── List ──────────────────────────────────────────────────────────────────────
function NoteList() {
  const navigate = useNavigate()
  const [notes, setNotes]       = useState([])
  const [entities, setEntities] = useState([])
  const [invoices, setInvoices] = useState([])
  const [hsnMap, setHsnMap]     = useState(new Map())
  const [loading, setLoading]   = useState(true)
  const [typeFilter, setType]   = useState('all')
  const [statusFilter, setStatus] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm]         = useState({
    note_type: 'credit_note', against_invoice_id: '',
    issuer_entity_id: '', receiver_entity_id: '',
    note_date: today(), reason: 'return', reason_notes: '',
    is_interstate: false, notes: '',
  })
  const [noteLines, setNoteLines] = useState([])
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ns }, { data: es }, { data: invs }, { data: hsnRows }] = await Promise.all([
      supabase.from('credit_debit_notes')
        .select('*, issuer:issuer_entity_id(name,short_name), receiver:receiver_entity_id(name,short_name), invoice:against_invoice_id(invoice_no)')
        .eq('is_deleted', false).order('note_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      supabase.from('invoices').select('id,invoice_no,seller_entity_id,buyer_entity_id,is_interstate').eq('is_deleted', false).neq('status','cancelled').order('invoice_date', { ascending: false }),
      supabase.from('hsn_master').select('*').eq('is_active', true),
    ])
    setNotes(ns || [])
    setEntities(es || [])
    setInvoices(invs || [])
    setHsnMap(buildHSNMap(hsnRows || []))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function setF(k, v) {
    setForm(f => {
      const u = { ...f, [k]: v }
      if (k === 'against_invoice_id' && v) {
        const inv = invoices.find(i => i.id === v)
        if (inv) {
          u.issuer_entity_id   = inv.seller_entity_id || ''
          u.receiver_entity_id = inv.buyer_entity_id  || ''
          u.is_interstate      = inv.is_interstate     || false
        }
      }
      return u
    })
  }

  async function handleSave() {
    if (!form.against_invoice_id || !form.issuer_entity_id || !form.receiver_entity_id)
      return setToast({ message: 'Invoice, Issuer and Receiver are required', type: 'error' })
    const computed = noteLines.map(l => computeLine(l, form.is_interstate))
    const totals   = computeTotals(computed)
    setSaving(true)
    const payload = {
      note_type: form.note_type, against_invoice_id: form.against_invoice_id,
      issuer_entity_id: form.issuer_entity_id, receiver_entity_id: form.receiver_entity_id,
      note_date: form.note_date, reason: form.reason, reason_notes: form.reason_notes||null,
      is_interstate: form.is_interstate, ...totals,
      status: 'draft', notes: form.notes||null,
    }
    const fy = await resolveFY()
    if (!fy) { setSaving(false); return setToast({ message: 'No financial year found', type: 'error' }) }
    const { data: noteNo, error: noErr } = await supabase.rpc('next_note_no', { ent_id: form.issuer_entity_id, fy_id: fy.id, note_type: form.note_type })
    if (noErr) { setSaving(false); return setToast({ message: 'Could not generate note number: '+noErr.message, type: 'error' }) }
    payload.note_no = noteNo
    payload.financial_year_id = fy.id
    const { data: note, error } = await supabase.from('credit_debit_notes').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    if (noteLines.length > 0) {
      const linesPayload = computed.map((l, i) => ({
        ...l, note_id: note.id, line_no: i + 1, _id: undefined,
      }))
      await supabase.from('credit_debit_note_lines').insert(linesPayload)
    }
    setSaving(false)
    setToast({ message: 'Note created', type: 'success' })
    setModalOpen(false)
    navigate(`/credit-debit-notes/${note.id}`)
  }

  const filtered = notes.filter(n => {
    const mt = typeFilter   === 'all' || n.note_type === typeFilter
    const ms = statusFilter === 'all' || n.status    === statusFilter
    return mt && ms
  })

  const columns = [
    { label: 'Note No',  render: n => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{n.note_no || '—'}</span> },
    { label: 'Type',     render: n => <Badge status={n.note_type === 'credit_note' ? 'receipt' : 'payment'} label={n.note_type === 'credit_note' ? 'Credit Note' : 'Debit Note'} /> },
    { label: 'Issuer',   render: n => <span style={{ fontSize: '12px' }}>{n.issuer?.short_name || n.issuer?.name}</span> },
    { label: 'Receiver', render: n => <span style={{ fontSize: '12px' }}>{n.receiver?.short_name || n.receiver?.name}</span> },
    { label: 'Against',  render: n => <span style={{ fontSize: '11px', fontFamily: 'monospace', color: C.textSoft }}>{n.invoice?.invoice_no || '—'}</span> },
    { label: 'Date',     render: n => <span style={{ fontSize: '12px' }}>{fmtDate(n.note_date)}</span> },
    { label: 'Reason',   render: n => <span style={{ fontSize: '11px', textTransform: 'capitalize' }}>{n.reason?.replace('_', ' ')}</span> },
    { label: 'Amount',   right: true, render: n => <span style={{ fontWeight: 600 }}>{formatINR(n.total_amount)}</span> },
    { label: 'Status',   render: n => <Badge status={n.status} /> },
  ]

  return (
    <div>
      <PageHeader
        title='Credit & Debit Notes'
        subtitle='Adjustments against issued invoices'
        action={<Btn onClick={() => { setForm({ note_type: 'credit_note', against_invoice_id: '', issuer_entity_id: '', receiver_entity_id: '', note_date: today(), reason: 'return', reason_notes: '', is_interstate: false, notes: '' }); setNoteLines([]); setModalOpen(true) }}>+ New Note</Btn>}
      />

      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <select value={typeFilter} onChange={e => setType(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All types</option>
          <option value='credit_note'>Credit Notes</option>
          <option value='debit_note'>Debit Notes</option>
        </select>
        <select value={statusFilter} onChange={e => setStatus(e.target.value)}
          style={{ padding: '7px 12px', border: `1.5px solid ${C.border}`, borderRadius: '6px', background: C.surface, fontSize: '13px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          <option value='all'>All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <Card>
        {loading
          ? <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
          : <Table columns={columns} rows={filtered} onRowClick={n => navigate(`/credit-debit-notes/${n.id}`)}
              emptyState={<EmptyState icon='📋' title='No credit/debit notes' action={<Btn onClick={() => setModalOpen(true)}>+ New Note</Btn>} />}
            />
        }
      </Card>

      {/* New Note Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title='New Credit / Debit Note' width={900}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SectionDivider label='Note Details' />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' }}>
            <FormRow label='Note Type' required>
              <Select value={form.note_type} onChange={e => setF('note_type', e.target.value)}>
                <option value='credit_note'>Credit Note</option>
                <option value='debit_note'>Debit Note</option>
              </Select>
            </FormRow>
            <FormRow label='Note Date' required>
              <Input type='date' value={form.note_date} onChange={e => setF('note_date', e.target.value)} />
            </FormRow>
            <FormRow label='Reason' required>
              <Select value={form.reason} onChange={e => setF('reason', e.target.value)}>
                {REASONS.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Against Invoice' required>
              <Select value={form.against_invoice_id} onChange={e => setF('against_invoice_id', e.target.value)}>
                <option value=''>Select invoice</option>
                {invoices.map(i => <option key={i.id} value={i.id}>{i.invoice_no || i.id.slice(0,8)}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Issuer Entity'>
              <Select value={form.issuer_entity_id} onChange={e => setF('issuer_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Receiver Entity'>
              <Select value={form.receiver_entity_id} onChange={e => setF('receiver_entity_id', e.target.value)}>
                <option value=''>Select</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.short_name || e.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Tax Type'>
              <Select value={form.is_interstate ? '1' : '0'} onChange={e => setF('is_interstate', e.target.value === '1')}>
                <option value='0'>Local — Same State (CGST + SGST)</option>
                <option value='1'>Interstate — Different State (IGST)</option>
              </Select>
            </FormRow>
          </div>
          <FormRow label='Reason Notes'><Textarea value={form.reason_notes} onChange={e => setF('reason_notes', e.target.value)} rows={2} /></FormRow>
          <SectionDivider label='Line Items' />
          <LineItemsEditor lines={noteLines} setLines={setNoteLines} interstate={form.is_interstate} hsnMap={hsnMap} />
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create Note'}</Btn>
          </div>
        </div>
      </Modal>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Detail ────────────────────────────────────────────────────────────────────
function NoteDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [note, setNote]   = useState(null)
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: n }, { data: ls }] = await Promise.all([
      supabase.from('credit_debit_notes')
        .select('*, issuer:issuer_entity_id(name,short_name,gstin,city), receiver:receiver_entity_id(name,short_name,gstin,city), invoice:against_invoice_id(invoice_no,total_amount)')
        .eq('id', id).single(),
      supabase.from('credit_debit_note_lines').select('*').eq('note_id', id).order('line_no'),
    ])
    setNote(n)
    setLines(ls || [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function updateStatus(status) {
    await supabase.from('credit_debit_notes').update({ status }).eq('id', id)
    setToast({ message: `Note ${status}`, type: 'success' })
    load()
  }

  if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.textMuted }}>Loading…</div>
  if (!note)   return <div style={{ padding: '48px', textAlign: 'center', color: C.danger }}>Note not found.</div>

  const isCredit = note.note_type === 'credit_note'

  return (
    <div>
      <button onClick={() => navigate('/credit-debit-notes')} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '13px', cursor: 'pointer', padding: 0, fontFamily: 'inherit', marginBottom: '4px' }}>
        ← Credit / Debit Notes
      </button>
      <PageHeader
        title={note.note_no || `${isCredit ? 'Credit' : 'Debit'} Note — ${fmtDate(note.note_date)}`}
        subtitle={`${note.issuer?.name} → ${note.receiver?.name} · Against ${note.invoice?.invoice_no || '—'}`}
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {note.status === 'draft' && <Btn size='sm' onClick={() => updateStatus('submitted')}>Submit</Btn>}
            {note.status !== 'cancelled' && <Btn size='sm' variant='ghost' onClick={() => setConfirmCancel(true)} style={{ color: C.danger }}>Cancel</Btn>}
            <Badge status={isCredit ? 'receipt' : 'payment'} label={isCredit ? 'Credit Note' : 'Debit Note'} />
            <Badge status={note.status} />
          </div>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Issuer</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{note.issuer?.name}</div>
          {note.issuer?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {note.issuer.gstin}</div>}
        </Card>
        <Card style={{ padding: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Receiver</div>
          <div style={{ fontWeight: 700, fontSize: '14px' }}>{note.receiver?.name}</div>
          {note.receiver?.gstin && <div style={{ fontSize: '12px', color: C.textSoft, fontFamily: 'monospace' }}>GSTIN: {note.receiver.gstin}</div>}
        </Card>
      </div>

      <div style={{ display: 'flex', gap: '20px', marginBottom: '20px', flexWrap: 'wrap', fontSize: '13px' }}>
        <div><span style={{ color: C.textMuted }}>Date:</span> <strong>{fmtDate(note.note_date)}</strong></div>
        <div><span style={{ color: C.textMuted }}>Reason:</span> <strong style={{ textTransform: 'capitalize' }}>{note.reason?.replace('_', ' ')}</strong></div>
        <div><span style={{ color: C.textMuted }}>Against:</span> <strong>{note.invoice?.invoice_no} ({formatINR(note.invoice?.total_amount)})</strong></div>
        <div><span style={{ color: C.textMuted }}>Tax:</span> <Badge status={note.is_interstate ? 'export' : 'domestic'} label={note.is_interstate ? 'Interstate (IGST)' : 'Local (CGST+SGST)'} /></div>
      </div>

      {note.reason_notes && <div style={{ marginBottom: '16px', fontSize: '13px', color: C.textSoft, background: C.bg, padding: '10px 14px', borderRadius: '6px', border: `1px solid ${C.border}` }}>{note.reason_notes}</div>}

      <Card style={{ marginBottom: '16px' }}>
        <LineItemsEditor lines={lines.map(l => ({ ...l, _id: l.id }))} setLines={() => {}} interstate={note.is_interstate} readOnly />
      </Card>

      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>Documents</div>
        <DocumentAttachments sourceType='credit_debit_notes' sourceId={note.id} entityId={note.issuer_entity_id} entityName={note.issuer?.name || 'General'} /> {/* CHANGED: entityId added */}
      </div>

      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} onConfirm={() => { updateStatus('cancelled'); setConfirmCancel(false) }}
        title='Cancel Note' message='Cancel this note? This cannot be undone.' danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export default function CreditDebitNotes() {
  return (
    <Routes>
      <Route index       element={<NoteList />} />
      <Route path=':id'  element={<NoteDetail />} />
    </Routes>
  )
}
