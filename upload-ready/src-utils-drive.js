/**
 * Google Drive utility — MOCKED for local development.
 * 
 * When Drive API is ready at deployment:
 * 1. Set VITE_GOOGLE_CLIENT_ID in .env
 * 2. Replace uploadFileToDrive() with real Drive API call
 * 3. Everything else stays the same
 */

const MOCK_DRIVE = true // flip to false when connecting real Drive API

/**
 * Upload a file to Google Drive (mocked locally).
 * Returns { drive_file_id, drive_url, file_name, file_size_bytes, mime_type }
 */
export async function uploadFileToDrive(file, entityName = 'General') {
  if (MOCK_DRIVE) {
    // Simulate upload delay
    await new Promise(r => setTimeout(r, 800))
    const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`
    return {
      drive_file_id:   mockId,
      drive_url:       URL.createObjectURL(file), // local object URL for preview
      file_name:       file.name,
      file_size_bytes: file.size,
      mime_type:       file.type || 'application/octet-stream',
    }
  }

  // ── Real Drive API (activated at deployment) ───────────────────────────────
  // Step 1: get/create entity folder under "Trading Bizz" root
  // Step 2: upload file into that folder
  // Step 3: return file metadata
  //
  // const token = await getGoogleAccessToken()
  // const folderId = await getOrCreateFolder(token, entityName)
  // const metadata = await uploadToFolder(token, file, folderId)
  // return metadata
  throw new Error('Real Drive API not yet connected')
}

/**
 * Get a viewable URL for a Drive file.
 * Mock: returns the object URL as-is.
 * Real: returns https://drive.google.com/file/d/{id}/view
 */
export function getDriveViewUrl(driveFileId, driveUrl) {
  if (MOCK_DRIVE) return driveUrl
  return `https://drive.google.com/file/d/${driveFileId}/view`
}

/**
 * Get a download URL for a Drive file.
 * Mock: returns the object URL as-is.
 * Real: returns https://drive.google.com/uc?export=download&id={id}
 */
export function getDriveDownloadUrl(driveFileId, driveUrl) {
  if (MOCK_DRIVE) return driveUrl
  return `https://drive.google.com/uc?export=download&id=${driveFileId}`
}

/** Format bytes → human readable */
export function formatFileSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024)       return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** File type icon */
export function fileIcon(mimeType = '', fileName = '') {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (mimeType.includes('pdf') || ext === 'pdf')             return '📄'
  if (mimeType.includes('spreadsheet') || ['xlsx','xls','csv'].includes(ext)) return '📊'
  if (mimeType.includes('image') || ['jpg','jpeg','png','gif','webp'].includes(ext)) return '🖼️'
  if (mimeType.includes('word') || ['doc','docx'].includes(ext)) return '📝'
  if (['zip','rar','7z'].includes(ext))                      return '🗜️'
  return '📎'
}
