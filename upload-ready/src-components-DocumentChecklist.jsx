import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import { C, Btn, ConfirmModal, Toast } from './UI/index'
import { uploadFileToDrive, deleteFileFromDrive, getDriveViewUrl, getDriveDownloadUrl, formatFileSize, fileIcon } from '../utils/drive'
import { fmtDate } from '../utils/dates'

// ── Document type definitions ─────────────────────────────────────────────────
// Must match constants/documents.js + leg_document_checklist.doc_slot values

const DOMESTIC_DOCS = [
  { slot: 'invoice',      label: 'Invoice' },
  { slot: 'packing_list', label: 'Packing List' },
  { slot: 'pi',           label: 'PI (Proforma Invoice)' },
  { slot: 'po',           label: 'PO (Purchase Order)' },
  { slot: 'eway_bill',    label: 'E-way Bill' },
  { slot: 'einvoice',     label: 'E-invoice' },
  { slot: 'lr',           label: 'LR (Lorry Receipt)' },
]

const EXPORT_DOCS = [
  { slot: 'pi',                    label: 'PI (Proforma Invoice)' },
  { slot: 'po',                    label: 'PO (Purchase Order)' },
  { slot: 'invoice',               label: 'Invoice' },
  { slot: 'packing_list',          label: 'Packing List' },
  { slot: 'airway_bill',           label: 'Airway Bill' },
  { slot: 'coo',                   label: 'COO (Country of Origin)' },
  { slot: 'boe',                   label: 'BOE (Bill of Entry)' },
  { slot: 'air_freight_clearance', label: 'Air Freight Clearance' },
]

const STATUS_OPTIONS = ['Uploaded', 'Pending', 'N/A']

// CHANGED: map checklist slot to a clean B2 subfolder label, e.g. Siddi/E-way Bill/file.pdf
const SLOT_FOLDER = {
  invoice:               'Invoice',
  packing_list:          'Packing List',
  pi:                    'PI',
  po:                    'PO',
  eway_bill:             'E-way Bill',
  einvoice:              'E-invoice',
  lr:                    'LR',
  airway_bill:           'Airway Bill',
  coo:                   'COO',
  boe:                   'BOE',
  air_freight_clearance: 'Air Freight Clearance',
}

const STATUS_STYLE = {
  Uploaded: { bg: '#e6f4ec', color: '#1a6b35', border: '#b3d9c0' },
  Pending:  { bg: '#fef6e4', color: '#7a4f00', border: '#f0d890' },
  'N/A':    { bg: '#f2f2f2', color: '#888',    border: '#ddd'    },
}

// status stored in DB as lowercase: 'uploaded', 'pending', 'na'
// displayed as title-case: 'Uploaded', 'Pending', 'N/A'
function dbToDisplay(s) {
  if (!s || s === 'pending') return 'Pending'
  if (s === 'uploaded') return 'Uploaded'
  if (s === 'na') return 'N/A'
  return 'Pending'
}
function displayToDB(s) {
  if (s === 'Uploaded') return 'uploaded'
  if (s === 'N/A') return 'na'
  return 'pending'
}
function StatusDropdown({ status, onChange, readOnly }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE['Pending']
  if (readOnly) {
    return (
      <span style={{
        background: s.bg, color: s.color, border: `1px solid ${s.border}`,
        borderRadius: '5px', padding: '3px 10px',
        fontSize: '11px', fontWeight: 700,
        whiteSpace: 'nowrap', minWidth: '72px', display: 'inline-block', textAlign: 'center',
      }}>
        {status}
      </span>
    )
  }
  return (
    <select
      value={status}
      onChange={e => onChange(e.target.value)}
      style={{
        background: s.bg, color: s.color, border: `1px solid ${s.border}`,
        borderRadius: '5px', padding: '3px 8px',
        fontSize: '11px', fontWeight: 700,
        cursor: 'pointer', fontFamily: 'inherit',
        minWidth: '100px', appearance: 'auto',
      }}
    >
      {STATUS_OPTIONS.map(opt => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * DocumentChecklist — structured document tracker per order leg.
 *
 * Props:
 *   legId        - uuid of the order_leg record (required)
 *   entityName   - string — used for Drive folder routing
 *   movementType - 'domestic' | 'export'  (default: 'domestic')
 *   readOnly     - boolean
 */
export default function DocumentChecklist({
  legId,
  entityId,          // uuid — required for documents table insert
  entityName = 'General',
  movementType: movementTypeProp = 'domestic',
  readOnly = false,
}) {
  const [movementType, setMovementType] = useState(movementTypeProp)
  const [checklistRows, setChecklistRows] = useState([])   // from leg_document_checklist
  const [otherDocs, setOtherDocs]         = useState([])   // from documents where doc_category='other'
  const [loading, setLoading]             = useState(true)
  const [uploading, setUploading]         = useState(null) // slot being uploaded
  const [uploadingOther, setUploadingOther] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]                 = useState(null)
  const fileRefs = useRef({})
  const otherFileRef = useRef(null)

  // Sync movementType if prop changes
  useEffect(() => { setMovementType(movementTypeProp) }, [movementTypeProp])

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!legId) { setLoading(false); return }
    setLoading(true)

    const [{ data: clData }, { data: docData }] = await Promise.all([
      supabase
        .from('leg_document_checklist')
        .select('*, document:document_id(*)')
        .eq('leg_id', legId)
        .order('slot_order', { ascending: true }),
      supabase
        .from('documents')
        .select('*')
        .eq('leg_id', legId)
        .eq('doc_category', 'other')
        .order('uploaded_at', { ascending: false }),
    ])

    setChecklistRows(clData || [])
    setOtherDocs(docData || [])
    setLoading(false)
  }, [legId])

  useEffect(() => { load() }, [load])

  // ── Derive active doc list ────────────────────────────────────────────────

  const docList = movementType === 'export' ? EXPORT_DOCS : DOMESTIC_DOCS

  function rowFor(slot) {
    return checklistRows.find(r => r.doc_slot === slot) || null
  }

  // ── Status cycle ─────────────────────────────────────────────────────────

  async function handleStatusChange(slot, displayValue) {
    if (readOnly || !legId) return
    const existing = rowFor(slot)
    const nextDB = displayToDB(displayValue)

    if (existing) {
      await supabase
        .from('leg_document_checklist')
        .update({ status: nextDB, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      const doc = docList.find(d => d.slot === slot)
      const slotOrder = docList.findIndex(d => d.slot === slot) + 1
      await supabase.from('leg_document_checklist').insert({
        leg_id:     legId,
        doc_slot:   slot,
        doc_label:  doc?.label || slot,
        slot_order: slotOrder,
        status:     nextDB,
      })
    }
    load()
  }

  // ── File upload for a specific slot ──────────────────────────────────────

  async function handleFileUpload(slot, file) {
    if (!file || !legId) return
    setUploading(slot)
    try {
      // CHANGED: capture the file being replaced (if any) so we can clean it up after the new one lands
      const oldDoc = rowFor(slot)?.document || null

      const result = await uploadFileToDrive(file, entityName, SLOT_FOLDER[slot] || '') // CHANGED: nest by doc type

      // Insert document record
      const docPayload = {
        entity_id:       entityId || null,
        leg_id:          legId,
        doc_slot:        slot,
        doc_label:       docList.find(d => d.slot === slot)?.label || slot,
        doc_category:    'standard',
        drive_file_id:   result.drive_file_id || '',
        drive_url:       result.drive_url     || '',
        file_name:       result.file_name     || file.name,
        file_size_bytes: result.file_size_bytes || file.size,
        mime_type:       result.mime_type     || file.type || 'application/octet-stream',
        uploaded_at:     new Date().toISOString(),
      }
      const { data: newDoc, error: docErr } = await supabase
        .from('documents')
        .insert(docPayload)
        .select()
        .single()
      if (docErr) throw new Error(docErr.message)

      // Upsert checklist row
      const existing = rowFor(slot)
      const clPayload = {
        status:      'uploaded',
        document_id: newDoc.id,
        updated_at:  new Date().toISOString(),
      }
      if (existing) {
        await supabase.from('leg_document_checklist').update(clPayload).eq('id', existing.id)
      } else {
        const slotOrder = docList.findIndex(d => d.slot === slot) + 1
        await supabase.from('leg_document_checklist').insert({
          leg_id:    legId,
          doc_slot:  slot,
          doc_label: docList.find(d => d.slot === slot)?.label || slot,
          slot_order: slotOrder,
          ...clPayload,
        })
      }

      // CHANGED: clean up the replaced file now that the checklist points at the new one
      if (oldDoc?.id) {
        try {
          await deleteFileFromDrive(oldDoc.drive_file_id)
        } catch (err) {
          console.error('Storage delete error (replaced file):', err)
        }
        await supabase.from('documents').delete().eq('id', oldDoc.id)
      }

      setToast({ message: `${file.name} uploaded`, type: 'success' })
      load()
    } catch (err) {
      setToast({ message: `Upload failed: ${err.message}`, type: 'error' })
    } finally {
      setUploading(null)
    }
  }

  // ── Other docs upload ─────────────────────────────────────────────────────

  async function handleOtherUpload(file) {
    if (!file || !legId) return
    setUploadingOther(true)
    try {
      const result = await uploadFileToDrive(file, entityName, 'Other') // CHANGED: nest under Other subfolder
      await supabase.from('documents').insert({
        entity_id:       entityId || null,
        leg_id:          legId,
        doc_slot:        'other',
        doc_category:    'other',
        drive_file_id:   result.drive_file_id || '',
        drive_url:       result.drive_url     || '',
        file_name:       result.file_name     || file.name,
        file_size_bytes: result.file_size_bytes || file.size,
        mime_type:       result.mime_type     || file.type || 'application/octet-stream',
        uploaded_at:     new Date().toISOString(),
      })
      setToast({ message: `${file.name} uploaded`, type: 'success' })
      load()
    } catch (err) {
      setToast({ message: `Upload failed: ${err.message}`, type: 'error' })
    } finally {
      setUploadingOther(false)
    }
  }

  async function handleDeleteDoc() {
    try {
      await deleteFileFromDrive(confirmDelete.drive_file_id)
    } catch (err) {
      console.error('Storage delete error:', err)
    }
    await supabase.from('documents').delete().eq('id', confirmDelete.id)
    // Checklist-slot documents keep their slot row — clear it back to
    // Pending instead of deleting the row, since the slot itself still applies.
    if (confirmDelete.checklistRowId) {
      await supabase.from('leg_document_checklist')
        .update({ document_id: null, status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', confirmDelete.checklistRowId)
    }
    setConfirmDelete(null)
    setToast({ message: 'Document removed', type: 'success' })
    load()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const uploadedCount = docList.filter(d => {
    const r = rowFor(d.slot)
    return r?.status === 'uploaded'
  }).length

  return (
    <div style={{
      border: `1px solid ${C.border}`,
      borderRadius: '8px',
      background: C.surface,
      overflow: 'hidden',
    }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '8px',
        padding: '10px 14px',
        borderBottom: `1px solid ${C.border}`,
        background: C.bg,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: C.textMid }}>
            📋 Documents
          </span>
          <span style={{
            fontSize: '11px',
            background: uploadedCount === docList.length ? '#e6f4ec' : '#e8f0f3',
            color: uploadedCount === docList.length ? '#1a6b35' : '#1a4a6a',
            padding: '2px 8px', borderRadius: '4px', fontWeight: 600,
          }}>
            {uploadedCount}/{docList.length} uploaded
          </span>
        </div>

        {/* Movement type toggle */}
        {!readOnly && (
          <div style={{
            display: 'flex', borderRadius: '6px',
            border: `1px solid ${C.border}`, overflow: 'hidden',
          }}>
            {['domestic', 'export'].map(t => (
              <button
                key={t}
                onClick={() => setMovementType(t)}
                style={{
                  padding: '4px 14px',
                  fontSize: '11px', fontWeight: 700,
                  background: movementType === t ? C.accent : 'transparent',
                  color: movementType === t ? '#f5f0e8' : C.textMuted,
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'inherit',
                  textTransform: 'capitalize',
                }}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Loading / no record ── */}
      {loading ? (
        <div style={{ padding: '20px', textAlign: 'center', fontSize: '12px', color: C.textMuted }}>
          Loading…
        </div>
      ) : !legId ? (
        <div style={{ padding: '20px', textAlign: 'center', fontSize: '12px', color: C.textMuted }}>
          Save the leg first to track documents.
        </div>
      ) : (
        <>
          {/* ── Checklist rows ── */}
          {/* CHANGED: N/A docs sink to the bottom of the list, keeping the
              still-actionable (Pending/Uploaded) rows together at the top. */}
          <div>
            {[...docList]
              .sort((a, b) => (dbToDisplay(rowFor(a.slot)?.status) === 'N/A') - (dbToDisplay(rowFor(b.slot)?.status) === 'N/A'))
              .map((doc, i, sorted) => {
              const row = rowFor(doc.slot)
              const status = dbToDisplay(row?.status)
              const isUploading = uploading === doc.slot
              const linkedDoc = row?.document   // joined document record
              const isNA = status === 'N/A'

              return (
                <div
                  key={doc.slot}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '9px 14px',
                    borderBottom: i < sorted.length - 1 ? `1px solid #f0e8d8` : 'none',
                    background: i % 2 === 0 ? C.surface : '#faf6ed',
                    opacity: isNA ? 0.6 : 1,
                  }}
                >
                  {/* Doc label */}
                  <div style={{ flex: 1, fontSize: '13px', color: C.text, fontWeight: 500 }}>
                    {doc.label}
                    {linkedDoc?.file_name && (
                      <span style={{ fontSize: '11px', color: C.textMuted, marginLeft: '6px', fontWeight: 400 }}>
                        · {linkedDoc.file_name}
                      </span>
                    )}
                  </div>

                  {/* Status dropdown */}
                  <StatusDropdown
                    status={status}
                    onChange={val => handleStatusChange(doc.slot, val)}
                    readOnly={readOnly}
                  />

                  {/* File actions */}
                  <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                    {linkedDoc?.drive_url && (
                      <>
                        <button
                          onClick={async () => {
                            // CHANGED: getDriveViewUrl is now async (fetches
                            // with the session token, returns a blob URL) —
                            // the GET endpoint requires auth now.
                            try {
                              const url = await getDriveViewUrl(linkedDoc.drive_file_id, linkedDoc.drive_url)
                              window.open(url, '_blank', 'noopener,noreferrer')
                              setTimeout(() => URL.revokeObjectURL(url), 60000)
                            } catch (err) {
                              setToast({ message: err.message || 'Could not open file', type: 'error' })
                            }
                          }}
                          style={{
                            padding: '4px 10px', borderRadius: '4px',
                            fontSize: '11px', fontWeight: 600,
                            background: '#e8f0f3', color: '#1a4a6a',
                            border: '1px solid #c0d8e8', whiteSpace: 'nowrap',
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          View ↗
                        </button>
                        <button
                          onClick={async () => {
                            // CHANGED: getDriveDownloadUrl already returns an
                            // authenticated blob URL now — no need for a
                            // second raw fetch on top of it.
                            try {
                              const url = await getDriveDownloadUrl(linkedDoc.drive_file_id, linkedDoc.drive_url)
                              const a = document.createElement('a')
                              a.href = url
                              a.download = linkedDoc.file_name || 'download'
                              document.body.appendChild(a)
                              a.click()
                              a.remove()
                              setTimeout(() => URL.revokeObjectURL(url), 60000)
                            } catch (err) {
                              setToast({ message: err.message || 'Could not download file', type: 'error' })
                            }
                          }}
                          style={{
                            padding: '4px 10px', borderRadius: '4px',
                            fontSize: '11px', fontWeight: 600,
                            background: '#e8f3ec', color: '#1a5c30',
                            border: '1px solid #b8dfc8',
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          ↓ Save
                        </button>
                        {!readOnly && (
                          <button
                            onClick={() => setConfirmDelete({ ...linkedDoc, checklistRowId: row.id })}
                            title='Delete file'
                            style={{
                              padding: '4px 8px', borderRadius: '4px',
                              fontSize: '12px', fontWeight: 600,
                              background: 'none', color: C.danger,
                              border: `1px solid ${C.border}`,
                              cursor: 'pointer', fontFamily: 'inherit',
                            }}
                          >
                            ×
                          </button>
                        )}
                      </>
                    )}

                    {!readOnly && !isNA && (
                      <>
                        <button
                          onClick={() => fileRefs.current[doc.slot]?.click()}
                          disabled={isUploading}
                          title={linkedDoc ? 'Replace file' : 'Upload file'}
                          style={{
                            padding: '4px 10px', borderRadius: '4px',
                            fontSize: '11px', fontWeight: 600,
                            background: isUploading ? C.bg : '#f5f0e8',
                            color: isUploading ? C.textMuted : C.textMid,
                            border: `1px solid ${C.border}`,
                            cursor: isUploading ? 'not-allowed' : 'pointer',
                            fontFamily: 'inherit', whiteSpace: 'nowrap',
                          }}
                        >
                          {isUploading ? '⏳' : linkedDoc ? '↑ Replace' : '↑ Upload'}
                        </button>
                        <input
                          type='file'
                          style={{ display: 'none' }}
                          ref={el => fileRefs.current[doc.slot] = el}
                          onChange={e => {
                            const f = e.target.files?.[0]
                            e.target.value = ''
                            if (f) handleFileUpload(doc.slot, f)
                          }}
                        />
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Others section ── */}
          <div style={{ borderTop: `1px solid ${C.border}`, background: '#faf6ed' }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 14px',
              borderBottom: otherDocs.length > 0 ? `1px solid #f0e8d8` : 'none',
            }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: C.textMid }}>
                Others
                {otherDocs.length > 0 && (
                  <span style={{ fontWeight: 400, color: C.textMuted, marginLeft: '4px' }}>
                    ({otherDocs.length})
                  </span>
                )}
              </span>
              {!readOnly && (
                <>
                  <button
                    onClick={() => otherFileRef.current?.click()}
                    disabled={uploadingOther || !legId}
                    style={{
                      background: uploadingOther ? C.bg : C.accent,
                      color: uploadingOther ? C.textMuted : '#f5f0e8',
                      border: 'none', borderRadius: '5px',
                      padding: '4px 13px',
                      fontSize: '11px', fontWeight: 600,
                      cursor: uploadingOther || !legId ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {uploadingOther ? '⏳' : '↑ Add'}
                  </button>
                  <input
                    ref={otherFileRef}
                    type='file'
                    style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) handleOtherUpload(f)
                    }}
                  />
                </>
              )}
            </div>

            {otherDocs.length === 0 ? (
              <div style={{ padding: '12px 14px', fontSize: '12px', color: C.textMuted }}>
                No additional documents. Click <strong>↑ Add</strong> to attach any other file.
              </div>
            ) : (
              otherDocs.map((doc, i) => (
                <div
                  key={doc.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '9px 14px',
                    borderBottom: i < otherDocs.length - 1 ? `1px solid #f0e8d8` : 'none',
                    background: i % 2 === 0 ? '#faf6ed' : C.surface,
                  }}
                >
                  <span style={{ fontSize: '18px', flexShrink: 0 }}>
                    {fileIcon(doc.mime_type, doc.file_name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '13px', fontWeight: 600, color: C.text,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {doc.file_name || 'Unnamed file'}
                    </div>
                    <div style={{ fontSize: '11px', color: C.textMuted, marginTop: '1px' }}>
                      {doc.file_size_bytes ? formatFileSize(doc.file_size_bytes) : ''}
                      {doc.uploaded_at ? ` · ${fmtDate(doc.uploaded_at)}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                    <button
                      onClick={async () => {
                        // CHANGED: getDriveViewUrl is now async (fetches with
                        // the session token, returns a blob URL).
                        try {
                          const url = await getDriveViewUrl(doc.drive_file_id, doc.drive_url)
                          window.open(url, '_blank', 'noopener,noreferrer')
                          setTimeout(() => URL.revokeObjectURL(url), 60000)
                        } catch (err) {
                          setToast({ message: err.message || 'Could not open file', type: 'error' })
                        }
                      }}
                      style={{
                        padding: '4px 10px', borderRadius: '4px',
                        fontSize: '11px', fontWeight: 600,
                        background: '#e8f0f3', color: '#1a4a6a',
                        border: '1px solid #c0d8e8',
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      View ↗
                    </button>
                    <button
                      onClick={async () => {
                        // CHANGED: getDriveDownloadUrl already returns an
                        // authenticated blob URL — no extra fetch needed.
                        try {
                          const url = await getDriveDownloadUrl(doc.drive_file_id, doc.drive_url)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = doc.file_name || 'download'
                          document.body.appendChild(a)
                          a.click()
                          a.remove()
                          setTimeout(() => URL.revokeObjectURL(url), 60000)
                        } catch (err) {
                          setToast({ message: err.message || 'Could not download file', type: 'error' })
                        }
                      }}
                      style={{
                        padding: '4px 10px', borderRadius: '4px',
                        fontSize: '11px', fontWeight: 600,
                        background: '#e8f3ec', color: '#1a5c30',
                        border: '1px solid #b8dfc8',
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      ↓ Save
                    </button>
                    {!readOnly && (
                      <button
                        onClick={() => setConfirmDelete(doc)}
                        style={{
                          padding: '4px 8px', borderRadius: '4px',
                          fontSize: '12px', fontWeight: 600,
                          background: 'none', color: C.danger,
                          border: `1px solid ${C.border}`,
                          cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDeleteDoc}
        title='Remove Document'
        message={`Remove "${confirmDelete?.file_name}"? This deletes the file permanently.`}
        danger
      />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
