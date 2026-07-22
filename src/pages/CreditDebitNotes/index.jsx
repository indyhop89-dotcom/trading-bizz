import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../supabaseClient'
import {
  C, Btn, Badge, Modal, ConfirmModal, Toast, EmptyState,
  PageHeader, Card, Table, FormRow, Input, Select, Textarea, SectionDivider,
} from '../../components/UI/index'
import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'
import DocumentAttachments from '../../components/DocumentAttachments'
import { formatINR, toNum } from '../../utils/money'
import { fmtDate, today, fyCodeForDate } from '../../utils/dates'
import { buildHSNMap } from '../../utils/hsn'
import { useAuth } from '../../hooks/useAuth' // CHANGED: master/admin-only delete, same convention as PI/PO/Invoices
import { hasFullAccess } from '../../utils/roles'
import { suggestNextNo } from '../../utils/numbering' // CHANGED: replaces broken next_note_no RPC / undefined resolveFY
import { excludeAutoPurchaseMirrors } from '../../utils/query'

const NOTE_TYPES = ['credit_note', 'debit_note']
const REASONS    = ['return', 'rate_correction', 'quantity_correction', 'other']
const STATUSES   = ['draft', 'submitted', 'cancelled']

// CHANGED: computeLine()'s return spreads calcLineTax()'s result (which
// includes cgst_rate/sgst_rate/igst_rate/total_tax — none of them real
// columns on credit_debit_note_lines) onto the line, plus UI-only fields
// like _id. Inserting that object as-is fails with "Could not find the
// 'cgst_rate' column ... in the schema cache" — silently, since the insert
// call's error was never checked, so notes always saved with zero lines.
// Allow-listing real DB columns (same pattern PI/PO/Invoices already use
// via PI_LINE_COLUMNS/toPILinePayload) can't miss a field this way.
const NOTE_LINE_COLUMNS = [
  'product_id', 'description', 'hsn_code', 'qty', 'unit', 'rate', 'gst_rate',
  'taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'total_amount',
]
function toNoteLinePayload(computedLine, noteId, lineNo) {
  const out = { note_id: noteId, line_no: lineNo }
  for (const col of NOTE_LINE_COLUMNS) if (computedLine[col] !== undefined) out[col] = computedLine[col]
  return out
}

// ─── List ──────────────────────────────────────────────────────────────────────
function NoteList() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: bulk + single delete, master-only, same convention as PI/PO/Invoices
  const canDelete = hasFullAccess(profile)
  const [selected, setSelected] = useState(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
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
    note_no: '', // CHANGED: optional manual note number — blank suggests one via suggestNextNo()
  })
  const [noteLines, setNoteLines] = useState([])
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  // CHANGED: "Simple / Numbers only" mode — issue a note as a small set of
  // net adjustment amounts, one per GST rate, instead of full product
  // line-item entry — for corrections that don't warrant re-keying
  // products/qty/rate but still need to split across multiple GST rates
  // (e.g. an invoice with both 12% and 18% items).
  const [simpleMode, setSimpleMode] = useState(false)
  const [simpleRows, setSimpleRows] = useState([{ amount: '', gst_rate: '18' }])
  // CHANGED: TDS/TCS on this note is auto-derived from the linked invoice's
  // payment history (see handleSave) — this just previews that rate to the
  // user before they save, read-only, no manual entry.
  const [linkedRates, setLinkedRates] = useState({ tds: 0, tcs: 0 })

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ns }, { data: es }, { data: invs }, { data: hsnRows }] = await Promise.all([
      supabase.from('credit_debit_notes')
        .select('*, issuer:issuer_entity_id(name,short_name), receiver:receiver_entity_id(name,short_name), invoice:against_invoice_id(invoice_no)')
        .eq('is_deleted', false).order('note_date', { ascending: false }),
      supabase.from('entities').select('id,name,short_name,gstin,state_code').eq('is_active', true).eq('is_deleted', false).order('name'),
      // CHANGED: excludeAutoPurchaseMirrors — a credit/debit note must
      // reference the real invoice, never its auto-generated bookkeeping
      // mirror (see utils/query.js).
      excludeAutoPurchaseMirrors(supabase.from('invoices').select('id,invoice_no,seller_entity_id,buyer_entity_id,is_interstate').eq('is_deleted', false).neq('status','cancelled').order('invoice_date', { ascending: false })),
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

  // Prefill Simple-mode rows from the selected invoice's own lines — one row
  // per DISTINCT GST rate actually on that invoice (amount left blank for
  // the user to fill in), so an invoice mixing e.g. 12% and 18% items
  // starts with both rows ready instead of one blended line. Falls back to
  // a single '18' row if the invoice has no lines to read rates from.
  useEffect(() => {
    if (!simpleMode) return
    // Reset before (re-)fetching so a previously-selected invoice's rows
    // never linger when the new selection has different (or no) rates.
    if (!form.against_invoice_id) { setSimpleRows([{ amount: '', gst_rate: '18' }]); return }
    let cancelled = false
    supabase.from('invoice_lines').select('gst_rate').eq('invoice_id', form.against_invoice_id)
      .then(({ data }) => {
        if (cancelled) return
        const rates = [...new Set((data || []).map(l => l.gst_rate).filter(r => r != null))].sort((a, b) => a - b)
        setSimpleRows(rates.length ? rates.map(r => ({ amount: '', gst_rate: String(r) })) : [{ amount: '', gst_rate: '18' }])
      })
    return () => { cancelled = true }
  }, [simpleMode, form.against_invoice_id])

  // CHANGED: preview the TDS/TCS rate that will be auto-applied (see handleSave).
  useEffect(() => {
    if (!form.against_invoice_id) { setLinkedRates({ tds: 0, tcs: 0 }); return }
    let cancelled = false
    supabase.from('invoice_payments')
      .select('tds_rate,tcs_rate').eq('invoice_id', form.against_invoice_id).eq('is_deleted', false)
      .order('actual_payment_date', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => { if (!cancelled) setLinkedRates({ tds: toNum(data?.tds_rate) || 0, tcs: toNum(data?.tcs_rate) || 0 }) })
    return () => { cancelled = true }
  }, [form.against_invoice_id])

  function addSimpleRow()            { setSimpleRows(rows => [...rows, { amount: '', gst_rate: '18' }]) }
  function removeSimpleRow(idx)      { setSimpleRows(rows => rows.filter((_, i) => i !== idx)) }
  function updateSimpleRow(idx, k, v) { setSimpleRows(rows => rows.map((r, i) => i === idx ? { ...r, [k]: v } : r)) }

  async function handleSave() {
    if (!form.against_invoice_id || !form.issuer_entity_id || !form.receiver_entity_id)
      return setToast({ message: 'Invoice, Issuer and Receiver are required', type: 'error' })
    const simpleLines = simpleRows.filter(r => toNum(r.amount) > 0)
    if (simpleMode && simpleLines.length === 0)
      return setToast({ message: 'Enter at least one non-zero adjustment amount', type: 'error' })
    // Simple mode: one synthetic line per GST-rate row, run through the
    // exact same computeLine/computeTotals math every full-line-item note
    // already uses — no separate tax-math path needed.
    const sourceLines = simpleMode
      ? simpleLines.map(r => ({ description: 'Rate/amount adjustment', hsn_code: '-', product_id: null, qty: 1, unit: 'Nos', rate: toNum(r.amount), gst_rate: toNum(r.gst_rate) }))
      : noteLines
    const computed = sourceLines.map(l => computeLine(l, form.is_interstate))
    const totals   = computeTotals(computed)
    setSaving(true)
    // CHANGED: resolveFY() was called here but never defined anywhere in this
    // file — every note creation threw "resolveFY is not defined" before
    // even reaching the (also broken — next_note_no was never created on the
    // live DB, no note_sequence table either) RPC call. Replaced with the
    // same suggestNextNo() pattern already proven for PI/PO/Invoices: an
    // optional manual note number (checked for duplicates), or an
    // auto-suggested one if left blank. FY code computed directly from the
    // note's own date, same as the other modules — no DB round-trip needed.
    const fyCode = fyCodeForDate(form.note_date)
    let noteNo = (form.note_no || '').trim()
    if (noteNo) {
      const dup = notes.find(n => n.note_no?.toLowerCase() === noteNo.toLowerCase())
      if (dup) { setSaving(false); return setToast({ message: `Note number "${noteNo}" is already in use`, type: 'error' }) }
    } else {
      const issuerEntity = entities.find(e => e.id === form.issuer_entity_id)
      const typePrefix = form.note_type === 'credit_note' ? 'CN' : 'DN'
      noteNo = await suggestNextNo({ table: 'credit_debit_notes', noCol: 'note_no', entityShort: `${issuerEntity?.short_name || issuerEntity?.name || 'X'}-${typePrefix}`, fyCode })
    }
    // CHANGED: the live credit_debit_notes table has no `notes`, `total_qty`,
    // or `round_off_amount` column (confirmed directly against the live
    // schema — PostgREST rejected inserts with "Could not find the 'notes'
    // column ... in the schema cache"), despite the migration file/UI
    // implying otherwise. Spreading ...totals used to silently try to write
    // total_qty/round_off_amount too. Fixed by listing only the totals
    // columns that actually exist, and folding the "Notes" field (which had
    // nowhere to be saved, and NoteDetail never rendered it anyway) into
    // reason_notes — the one free-text column this table actually has.
    const combinedNotes = [form.reason_notes, form.notes].filter(Boolean).join('\n\n') || null
    // CHANGED: TDS/TCS on a credit/debit note is never hand-entered — it's
    // auto-derived from the linked invoice's own payment history (the same
    // rate the buyer/seller already applied when settling that invoice), so a
    // correction against a TDS/TCS-bearing invoice stays proportionally
    // consistent with it rather than needing a second manual entry surface.
    const { data: lastTranche } = await supabase.from('invoice_payments')
      .select('tds_rate,tcs_rate').eq('invoice_id', form.against_invoice_id).eq('is_deleted', false)
      .order('actual_payment_date', { ascending: false }).limit(1).maybeSingle()
    const tdsRate = toNum(lastTranche?.tds_rate) || 0
    const tcsRate = toNum(lastTranche?.tcs_rate) || 0
    const payload = {
      note_type: form.note_type, against_invoice_id: form.against_invoice_id,
      issuer_entity_id: form.issuer_entity_id, receiver_entity_id: form.receiver_entity_id,
      note_date: form.note_date, reason: form.reason, reason_notes: combinedNotes,
      is_interstate: form.is_interstate,
      taxable_amount: totals.taxable_amount, cgst_amount: totals.cgst_amount,
      sgst_amount: totals.sgst_amount, igst_amount: totals.igst_amount, total_amount: totals.total_amount,
      tds_rate: tdsRate || null, tds_amount: tdsRate ? Math.round(totals.taxable_amount * tdsRate / 100) : 0,
      tcs_rate: tcsRate || null, tcs_amount: tcsRate ? Math.round(totals.taxable_amount * tcsRate / 100) : 0,
      status: 'draft', note_no: noteNo,
    }
    // NOTE: the migration doc for credit_debit_notes marks financial_year_id
    // NOT NULL, but the same doc-vs-live mismatch was confirmed for
    // proforma_invoices/purchase_orders/invoices (column simply doesn't
    // exist on the live tables despite the migration file). Not setting it
    // here to match that precedent — if it turns out this table's live
    // schema DOES have and require the column, this insert will fail with a
    // clear "null value in column financial_year_id" error rather than
    // silently succeeding wrong, and it's a one-line fix to add it back.
    const { data: note, error } = await supabase.from('credit_debit_notes').insert(payload).select().single()
    if (error) { setSaving(false); return setToast({ message: error.message, type: 'error' }) }
    if (sourceLines.length > 0) {
      const linesPayload = computed.map((l, i) => toNoteLinePayload(l, note.id, i + 1))
      const { error: linesError } = await supabase.from('credit_debit_note_lines').insert(linesPayload)
      if (linesError) { setSaving(false); return setToast({ message: `Note saved, but line items failed: ${linesError.message}`, type: 'error' }) }
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

  // CHANGED: multi-select + bulk soft-delete, same shape as PI/PO/Invoices
  function toggleSelect(id) {
    setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function toggleSelectAll() {
    setSelected(s => s.size === filtered.length ? new Set() : new Set(filtered.map(n => n.id)))
  }
  async function handleBulkDelete() {
    setBulkDeleting(true)
    const { error } = await supabase.from('credit_debit_notes').update({ is_deleted: true }).in('id', [...selected])
    setBulkDeleting(false)
    setConfirmBulkDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: `${selected.size} note(s) deleted`, type: 'success' })
    setSelected(new Set())
    load()
  }

  const columns = [
    ...(canDelete ? [{
      label: <input type='checkbox' checked={filtered.length > 0 && selected.size === filtered.length}
        onChange={toggleSelectAll} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
      render: n => <input type='checkbox' checked={selected.has(n.id)}
        onChange={() => toggleSelect(n.id)} onClick={e => e.stopPropagation()} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />,
    }] : []),
    { label: 'S.No.',    render: (row, idx) => <span style={{ color: C.textMuted }}>{idx + 1}</span> },
    { label: 'Note No',  render: n => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{n.note_no || '—'}</span> },
    { label: 'Type',     render: n => <Badge status={n.note_type === 'credit_note' ? 'receipt' : 'payment'} label={n.note_type === 'credit_note' ? 'Credit Note' : 'Debit Note'} /> },
    { label: 'Issuer',   render: n => <span style={{ fontSize: '12px' }}>{n.issuer?.short_name || n.issuer?.name}</span> },
    { label: 'Receiver', render: n => <span style={{ fontSize: '12px' }}>{n.receiver?.short_name || n.receiver?.name}</span> },
    { label: 'Against',  render: n => <span style={{ fontSize: '11px', fontFamily: 'monospace', color: C.textSoft }}>{n.invoice?.invoice_no || '—'}</span> },
    { label: 'Date',     render: n => <span style={{ fontSize: '12px' }}>{fmtDate(n.note_date)}</span> },
    { label: 'Reason',   render: n => <span style={{ fontSize: '11px', textTransform: 'capitalize' }}>{n.reason?.replace('_', ' ')}</span> },
    { label: 'Amount',   right: true, render: n => <span style={{ fontWeight: 600 }}>{formatINR(n.total_amount)}</span> },
    { label: 'TDS/TCS',  right: true, render: n => (n.tds_amount || n.tcs_amount)
        ? <span style={{ fontSize: '12px', color: C.textSoft }}>{n.tds_amount ? `TDS ${formatINR(n.tds_amount)}` : ''}{n.tds_amount && n.tcs_amount ? ' / ' : ''}{n.tcs_amount ? `TCS ${formatINR(n.tcs_amount)}` : ''}</span>
        : <span style={{ color: C.textMuted }}>—</span> },
    { label: 'Status',   render: n => <Badge status={n.status} /> },
  ]

  return (
    <div>
      <PageHeader
        title='Credit & Debit Notes'
        subtitle='Adjustments against issued invoices'
        action={<Btn onClick={() => { setForm({ note_type: 'credit_note', against_invoice_id: '', issuer_entity_id: '', receiver_entity_id: '', note_date: today(), reason: 'return', reason_notes: '', is_interstate: false, notes: '', note_no: '' }); setNoteLines([]); setSimpleMode(false); setSimpleRows([{ amount: '', gst_rate: '18' }]); setModalOpen(true) }}>+ New Note</Btn>}
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

      {/* CHANGED: bulk-selection action bar, same pattern as PI/PO/Invoices */}
      {canDelete && selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff3cc', border: '1px solid #e8d89a', borderRadius: '6px', padding: '8px 14px', marginBottom: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{selected.size} note{selected.size > 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn size='sm' variant='ghost' onClick={() => setSelected(new Set())}>Clear</Btn>
            <Btn size='sm' variant='danger' onClick={() => setConfirmBulkDelete(true)} disabled={bulkDeleting}>{bulkDeleting ? 'Deleting…' : 'Delete Selected'}</Btn>
          </div>
        </div>
      )}

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
                {NOTE_TYPES.map(t => <option key={t} value={t}>{t === 'credit_note' ? 'Credit Note' : 'Debit Note'}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Note Date' required>
              <Input type='date' value={form.note_date} onChange={e => setF('note_date', e.target.value)} />
            </FormRow>
            <FormRow label='Note Number' hint='Leave blank to auto-generate'>
              <Input value={form.note_no} onChange={e => setF('note_no', e.target.value)} placeholder='Auto-generated if blank' />
            </FormRow>
            <FormRow label='Reason' required>
              <Select value={form.reason} onChange={e => setF('reason', e.target.value)}>
                {REASONS.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
              </Select>
            </FormRow>
            <FormRow label='Against Invoice' required
              hint={(linkedRates.tds > 0 || linkedRates.tcs > 0)
                ? `Will auto-apply from this invoice's payment: ${linkedRates.tds > 0 ? `TDS ${linkedRates.tds}%` : ''}${linkedRates.tds > 0 && linkedRates.tcs > 0 ? ', ' : ''}${linkedRates.tcs > 0 ? `TCS ${linkedRates.tcs}%` : ''}`
                : undefined}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <input type='checkbox' id='cdn_simple_mode' checked={simpleMode} onChange={e => setSimpleMode(e.target.checked)} style={{ width: '14px', height: '14px' }} />
            <label htmlFor='cdn_simple_mode' style={{ fontSize: '13px', color: C.textMid, cursor: 'pointer' }}>
              Simple / Numbers only — just adjust an amount, no product line items
            </label>
          </div>
          {simpleMode ? (
            <div>
              <div style={{ fontSize: '11px', color: C.textMuted, marginBottom: '6px' }}>
                One row per GST rate — taxable amount per row, GST is computed on top of each.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {simpleRows.map((row, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '10px', alignItems: 'center' }}>
                    <Input type='number' value={row.amount} onChange={e => updateSimpleRow(i, 'amount', e.target.value)} placeholder='Adjustment amount (₹)' />
                    <Select value={row.gst_rate} onChange={e => updateSimpleRow(i, 'gst_rate', e.target.value)}>
                      {[0, 3, 5, 12, 18, 28].map(r => <option key={r} value={r}>{r}%</option>)}
                    </Select>
                    <Btn size='sm' variant='ghost' onClick={() => removeSimpleRow(i)} style={{ color: C.danger }}>✕</Btn>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '8px' }}>
                <Btn size='sm' variant='ghost' onClick={addSimpleRow}>+ Add Row</Btn>
              </div>
            </div>
          ) : (
            <LineItemsEditor lines={noteLines} setLines={setNoteLines} interstate={form.is_interstate} hsnMap={hsnMap} asOfDate={form.note_date} />
          )}
          <FormRow label='Notes'><Textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} /></FormRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <Btn variant='ghost' onClick={() => setModalOpen(false)}>Cancel</Btn>
            <Btn onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create Note'}</Btn>
          </div>
        </div>
      </Modal>
      {/* CHANGED: bulk delete confirmation */}
      <ConfirmModal open={confirmBulkDelete} onClose={() => setConfirmBulkDelete(false)} onConfirm={handleBulkDelete}
        title='Delete Notes' message={`Delete ${selected.size} selected note(s)? This cannot be undone.`} danger />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

// ─── Detail ────────────────────────────────────────────────────────────────────
function NoteDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  // CHANGED: master-only delete, same convention as PI/PO/Invoices detail pages
  const canDelete = hasFullAccess(profile)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
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
  // CHANGED: single-note soft delete
  async function handleDelete() {
    setDeleting(true)
    const { error } = await supabase.from('credit_debit_notes').update({ is_deleted: true }).eq('id', id)
    setDeleting(false); setConfirmDelete(false)
    if (error) return setToast({ message: error.message, type: 'error' })
    navigate('/credit-debit-notes')
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
            {/* CHANGED: master-only note delete */}
            {canDelete && <Btn size='sm' variant='danger' onClick={() => setConfirmDelete(true)} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete'}</Btn>}
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
      {/* CHANGED: delete confirmation */}
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={handleDelete}
        title='Delete Note' message={`Delete ${note.note_no || 'this note'}? This cannot be undone.`} danger />
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
