import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import { C, Btn, ConfirmModal, Toast } from './UI/index'
import { uploadFileToDrive, getDriveViewUrl, getDriveDownloadUrl, formatFileSize, fileIcon } from '../utils/drive'
import { fmtDate } from '../utils/dates'

/**
 * DocumentAttachments — reusable document upload / view / download component.
 *
 * Props:
 *   sourceType   - string — table name e.g. 'invoices', 'proforma_invoices', 'order_legs'
 *   sourceId     - uuid of the record to attach docs to
 *   entityName   - string — used for Drive folder routing e.g. 'Siddi'
 *   compact      - boolean — shows just a count badge + upload button inline in tables
 */
export default function DocumentAttachments({
  sourceType,
  sourceId,
  entityName = 'General',
  compact = false,
}) {
  const [docs, setDocs]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [uploading, setUploading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [toast, setToast]         = useState(null)
  const fileInputRef              = useRef(null)

  const load = useCallback(async () => {
    if (!sourceId) { setDocs([]); setLoading(false); return }
    setLoading(true)
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .order('uploaded_at', { ascending: false })
    if (error) console.error('DocumentAttachments load error:', error.message)
    setDocs(data || [])
    setLoading(false)
  }, [sourceType, sourceId])

  useEffect(() => { load() }, [load])

  async function handleFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset so same file can re-trigger

    if (!sourceId) {
      setToast({ message: 'Save the record first before uploading documents', type: 'error' })
      return
    }

    setUploading(true)
    try {
      const result = await uploadFileToDrive(file, entityName)

      const payload = {
        source_type:     sourceType,
        source_id:       sourceId,
        drive_file_id:   result.drive_file_id || '',
        drive_url:       result.drive_url     || '',
        file_name:       result.file_name     || file.name,
        file_size_bytes: result.file_size_bytes || file.size,
        mime_type:       result.mime_type     || file.type || 'application/octet-stream',
        uploaded_at:     new Date().toISOString(),
      }

      const { error } = await supabase.from('documents').insert(payload)
      if (error) throw new Error(error.message)

      setToast({ message: `${file.name} uploaded`, type: 'success' })
      load()
    } catch (err) {
      console.error('Upload error:', err)
      setToast({ message: `Upload failed: ${err.message}`, type: 'error' })
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete() {
    const { error } = await supabase
      .from('documents')
      .delete()
      .eq('id', confirmDelete.id)
    setConfirmDelete(null)
    if (error) return setToast({ message: error.message, type: 'error' })
    setToast({ message: 'Document removed', type: 'success' })
    load()
  }

  // ── Compact mode ─────────────────────────────────────────────────────────────
  if (compact) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          {docs.length > 0 && (
            <span
              style={{
                fontSize: '11px', fontWeight: 700,
                background: '#e8f0f3', color: '#1a4a6a',
                padding: '2px 7px', borderRadius: '4px',
                cursor: 'default', whiteSpace: 'nowrap',
              }}
              title={docs.map(d => d.file_name).join('\n')}
            >
              📎 {docs.length}
            </span>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !sourceId}
            style={{
              background: 'none',
              border: `1px solid ${C.border}`,
              borderRadius: '4px',
              padding: '2px 8px',
              fontSize: '11px',
              color: C.textSoft,
              cursor: uploading || !sourceId ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: !sourceId ? 0.4 : 1,
            }}
          >
            {uploading ? '⏳' : '+ Doc'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type='file'
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </>
    )
  }

  // ── Full mode ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      border: `1px solid ${C.border}`,
      borderRadius: '8px',
      background: C.surface,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: docs.length > 0 ? `1px solid ${C.border}` : 'none',
        background: C.bg,
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: C.textMid }}>
          📎 Documents
          {docs.length > 0 && (
            <span style={{ color: C.textMuted, fontWeight: 400, marginLeft: '4px' }}>
              ({docs.length})
            </span>
          )}
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || !sourceId}
          style={{
            background: uploading ? C.bg : C.accent,
            color: uploading ? C.textMuted : '#f5f0e8',
            border: 'none', borderRadius: '5px',
            padding: '5px 14px',
            fontSize: '12px', fontWeight: 600,
            cursor: uploading || !sourceId ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: !sourceId ? 0.4 : 1,
          }}
        >
          {uploading ? 'Uploading…' : '↑ Upload'}
        </button>
        <input
          ref={fileInputRef}
          type='file'
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
      </div>

      {/* Document list */}
      {loading ? (
        <div style={{ padding: '16px', textAlign: 'center', fontSize: '12px', color: C.textMuted }}>
          Loading…
        </div>
      ) : !sourceId ? (
        <div style={{ padding: '16px', textAlign: 'center', fontSize: '12px', color: C.textMuted }}>
          Save the record first to attach documents.
        </div>
      ) : docs.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', fontSize: '12px', color: C.textMuted }}>
          No documents attached. Click <strong>↑ Upload</strong> to add files.
        </div>
      ) : (
        docs.map((doc, i) => (
          <div
            key={doc.id}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 14px',
              borderBottom: i < docs.length - 1 ? `1px solid #f0e8d8` : 'none',
              background: i % 2 === 0 ? C.surface : '#faf6ed',
            }}
          >
            {/* Icon */}
            <span style={{ fontSize: '20px', flexShrink: 0 }}>
              {fileIcon(doc.mime_type, doc.file_name)}
            </span>

            {/* Name + meta */}
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

            {/* Actions */}
            <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
              <a
                href={getDriveViewUrl(doc.drive_file_id, doc.drive_url)}
                target='_blank'
                rel='noopener noreferrer'
                style={{
                  padding: '4px 11px', borderRadius: '4px',
                  fontSize: '12px', fontWeight: 600, textDecoration: 'none',
                  background: '#e8f0f3', color: '#1a4a6a',
                  border: '1px solid #c0d8e8', whiteSpace: 'nowrap',
                }}
              >
                View
              </a>
              <a
                href={getDriveDownloadUrl(doc.drive_file_id, doc.drive_url)}
                download={doc.file_name}
                style={{
                  padding: '4px 10px', borderRadius: '4px',
                  fontSize: '12px', fontWeight: 600, textDecoration: 'none',
                  background: '#e8f3ec', color: '#1a5c30',
                  border: '1px solid #b8dfc8', whiteSpace: 'nowrap',
                }}
              >
                ↓
              </a>
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
            </div>
          </div>
        ))
      )}

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title='Remove Document'
        message={`Remove "${confirmDelete?.file_name}"? The file will stay in Google Drive.`}
        danger
      />
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
