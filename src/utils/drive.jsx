// Google Drive upload utility
// LOCAL MODE: stores file as object URL + fake drive metadata
// PRODUCTION: swap VITE_GOOGLE_DRIVE_API_KEY + folder ID, uncomment real upload

const IS_LOCAL = !import.meta.env.VITE_GOOGLE_DRIVE_API_KEY

export async function uploadToDrive(file, folderName = 'General') {
  if (IS_LOCAL) {
    // Local dry-run: return fake drive metadata immediately
    await new Promise(r => setTimeout(r, 400)) // simulate upload delay
    return {
      drive_file_id: 'LOCAL-' + Date.now(),
      drive_url:     URL.createObjectURL(file),  // viewable locally
      file_name:     file.name,
    }
  }

  // ── PRODUCTION (uncomment when going live) ──────────────────────────────
  // const folderId = await getOrCreateFolder(folderName)
  // const metadata = { name: file.name, parents: [folderId] }
  // const form = new FormData()
  // form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  // form.append('file', file)
  // const res = await fetch(
  //   'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name',
  //   { method: 'POST', headers: { Authorization: `Bearer ${import.meta.env.VITE_GOOGLE_DRIVE_API_KEY}` }, body: form }
  // )
  // const data = await res.json()
  // return { drive_file_id: data.id, drive_url: data.webViewLink, file_name: data.name }
}

// File upload button component — reusable across all modules
import { useState, useRef } from 'react'
import { Paperclip, X, ExternalLink, Upload } from 'lucide-react'

export function FileUploadField({ value, fileName, onUploaded, onClear, folderName }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef()

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
      setError('Only PDF or image files allowed.')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('File too large. Max 20MB.')
      return
    }
    setUploading(true)
    setError('')
    try {
      const result = await uploadToDrive(file, folderName || 'General')
      onUploaded(result)
    } catch (err) {
      setError('Upload failed: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  return (
    <div>
      {value ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 12px', background: 'var(--green-bg)',
          border: '1px solid var(--green-border)', borderRadius: 10,
        }}>
          <Paperclip size={13} style={{ color: 'var(--green)', flexShrink: 0 }} />
          <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--green)' }}>
            {fileName || 'Document attached'}
          </span>
          <a href={value} target="_blank" rel="noreferrer" style={{ color: 'var(--green)' }} title="View">
            <ExternalLink size={12} />
          </a>
          <button onClick={onClear} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink3)', padding: 0 }} title="Remove">
            <X size={13} />
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {uploading ? <><span className="spinner spinner-sm" /> Uploading…</> : <><Upload size={13} /> Attach PDF / Image</>}
          </button>
          <input ref={inputRef} type="file" accept=".pdf,image/*" onChange={handleFile} style={{ display: 'none' }} />
          {IS_LOCAL && <div style={{ fontSize: 11, color: 'var(--ink3)', marginTop: 4 }}>Local mode — file stored in browser only</div>}
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{error}</div>}
    </div>
  )
}
