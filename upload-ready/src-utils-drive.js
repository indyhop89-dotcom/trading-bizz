import { supabase } from '../supabaseClient'

export async function uploadFileToDrive(file, entityName = 'General', docFolder = '') {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('folderName', entityName)
  if (docFolder) formData.append('docFolder', docFolder) // CHANGED: optional document-type subfolder

  const { data: { session } } = await supabase.auth.getSession()

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/b2-upload/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session?.access_token}` },
    body: formData,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Upload failed')

  return {
    drive_file_id:   data.drive_file_id,
    drive_url:       data.drive_url,
    file_name:       data.file_name,
    file_size_bytes: file.size,
    mime_type:       file.type || 'application/octet-stream',
  }
}

export async function deleteFileFromDrive(driveFileId) {
  if (!driveFileId) return { deleted: false, reason: 'no_id' }

  const { data: { session } } = await supabase.auth.getSession()

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/b2-upload/file/${encodeURIComponent(driveFileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session?.access_token}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Delete failed')
  return data
}

export function getDriveViewUrl(driveFileId, driveUrl) {
  return driveUrl
}

export function getDriveDownloadUrl(driveFileId, driveUrl) {
  return driveUrl
}

export function formatFileSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024)       return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function fileIcon(mimeType = '', fileName = '') {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (mimeType.includes('pdf') || ext === 'pdf')             return '📄'
  if (mimeType.includes('spreadsheet') || ['xlsx','xls','csv'].includes(ext)) return '📊'
  if (mimeType.includes('image') || ['jpg','jpeg','png','gif','webp'].includes(ext)) return '🖼️'
  if (mimeType.includes('word') || ['doc','docx'].includes(ext)) return '📝'
  if (['zip','rar','7z'].includes(ext))                      return '🗜️'
  return '📎'
}
