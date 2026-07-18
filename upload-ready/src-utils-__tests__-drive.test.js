import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// CHANGED: mock the Supabase client (external service) — only supabase.auth
// is used by drive.js, so that's all that's stubbed here.
vi.mock('../../supabaseClient', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}))

import { supabase } from '../../supabaseClient'
import {
  uploadFileToDrive, deleteFileFromDrive,
  getDriveViewUrl, getDriveDownloadUrl,
  formatFileSize, fileIcon,
} from '../drive.js'

function mockSession(token = 'test-token') {
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: token } } })
}

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── formatFileSize ──────────────────────────────────────────────────────────

describe('formatFileSize', () => {
  // Happy path
  it('formats bytes under 1024 as B', () => {
    expect(formatFileSize(500)).toBe('500 B')
  })

  it('formats a value in the KB range', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB')
  })

  it('formats a value in the MB range', () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('rounds KB to one decimal place', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB')
  })

  // Edge cases
  it('returns empty string for 0 bytes', () => {
    expect(formatFileSize(0)).toBe('')
  })

  it('returns empty string for null', () => {
    expect(formatFileSize(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(formatFileSize(undefined)).toBe('')
  })

  it('handles a value exactly at the 1024-byte boundary as KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
  })

  it('handles a value exactly at the 1MB boundary as MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
  })
})

// ─── fileIcon ────────────────────────────────────────────────────────────────

describe('fileIcon', () => {
  // Happy path — by mime type
  it('returns 📄 for a pdf mime type', () => {
    expect(fileIcon('application/pdf', 'doc.pdf')).toBe('📄')
  })

  it('returns 🖼️ for an image mime type', () => {
    expect(fileIcon('image/png', 'photo.png')).toBe('🖼️')
  })

  it('returns 📊 for a spreadsheet mime type', () => {
    expect(fileIcon('application/vnd.ms-excel', 'sheet.xls')).toBe('📊')
  })

  it('returns 📝 for a word mime type', () => {
    expect(fileIcon('application/msword', 'letter.doc')).toBe('📝')
  })

  // Happy path — by extension when mime type is unhelpful
  it('falls back to file extension for csv when mime type is generic', () => {
    expect(fileIcon('application/octet-stream', 'data.csv')).toBe('📊')
  })

  it('falls back to file extension for zip archives', () => {
    expect(fileIcon('application/octet-stream', 'backup.zip')).toBe('🗜️')
  })

  it('is case-insensitive on file extension', () => {
    expect(fileIcon('', 'PHOTO.JPG')).toBe('🖼️')
  })

  // Edge / default cases
  it('returns the default 📎 for an unrecognized type/extension', () => {
    expect(fileIcon('application/octet-stream', 'notes.txt')).toBe('📎')
  })

  it('returns the default 📎 when mimeType and fileName are both omitted', () => {
    expect(fileIcon()).toBe('📎')
  })

  it('does not throw for a filename with no extension', () => {
    expect(fileIcon('', 'README')).toBe('📎')
  })
})

// ─── getDriveViewUrl / getDriveDownloadUrl ──────────────────────────────────

describe('getDriveViewUrl / getDriveDownloadUrl', () => {
  beforeEach(() => {
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  })

  it('getDriveViewUrl fetches the file with an auth header and returns a blob URL', async () => {
    mockSession('tok-1')
    global.fetch.mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['x'])) })

    const url = await getDriveViewUrl('file-1', 'https://example.com/f1')

    expect(url).toBe('blob:mock-url')
    const [fetchUrl, opts] = global.fetch.mock.calls[0]
    expect(fetchUrl).toContain('file-1')
    expect(opts.headers.Authorization).toBe('Bearer tok-1')
  })

  it('getDriveDownloadUrl fetches the file with an auth header and returns a blob URL', async () => {
    mockSession('tok-2')
    global.fetch.mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['x'])) })

    const url = await getDriveDownloadUrl('file-1', 'https://example.com/f1')

    expect(url).toBe('blob:mock-url')
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-2')
  })

  it('getDriveViewUrl rejects when driveFileId is not provided', async () => {
    await expect(getDriveViewUrl(undefined, 'https://example.com/f1')).rejects.toThrow('No file to open')
  })

  it('getDriveViewUrl rejects when the fetch fails', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: false })
    await expect(getDriveViewUrl('file-1')).rejects.toThrow('Could not load file')
  })
})

// ─── uploadFileToDrive ───────────────────────────────────────────────────────

describe('uploadFileToDrive', () => {
  const file = new File(['contents'], 'invoice.pdf', { type: 'application/pdf' })

  // Happy path
  it('uploads and returns normalized drive metadata on success', async () => {
    mockSession('abc123')
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ drive_file_id: 'f1', drive_url: 'https://b2.example.com/f1', file_name: 'invoice.pdf' }),
    })

    const result = await uploadFileToDrive(file, 'Siddi', 'PI')

    expect(result).toEqual({
      drive_file_id: 'f1',
      drive_url: 'https://b2.example.com/f1',
      file_name: 'invoice.pdf',
      file_size_bytes: file.size,
      mime_type: 'application/pdf',
    })
  })

  it('sends the Authorization header using the session access token', async () => {
    mockSession('secret-token')
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })

    await uploadFileToDrive(file)

    const [, options] = global.fetch.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer secret-token')
    expect(options.method).toBe('POST')
  })

  it('includes docFolder in the form data only when provided', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })

    await uploadFileToDrive(file, 'Siddi', 'PI')

    const [, options] = global.fetch.mock.calls[0]
    expect(options.body.get('docFolder')).toBe('PI')
  })

  it('omits docFolder from form data when not provided', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })

    await uploadFileToDrive(file, 'Siddi')

    const [, options] = global.fetch.mock.calls[0]
    expect(options.body.get('docFolder')).toBeNull()
  })

  it('defaults mime_type to application/octet-stream when file.type is empty', async () => {
    mockSession()
    const untypedFile = new File(['x'], 'blob', { type: '' })
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })

    const result = await uploadFileToDrive(untypedFile)
    expect(result.mime_type).toBe('application/octet-stream')
  })

  // Negative / error handling
  it('throws the server-provided error message when the response is not ok', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'File too large' }) })

    await expect(uploadFileToDrive(file)).rejects.toThrow('File too large')
  })

  it('throws a generic "Upload failed" message when the response has no error field', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: false, json: async () => ({}) })

    await expect(uploadFileToDrive(file)).rejects.toThrow('Upload failed')
  })

  it('sends "Bearer undefined" when there is no active session (no access_token)', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })

    await uploadFileToDrive(file)

    const [, options] = global.fetch.mock.calls[0]
    // NOTE: documents current behavior — session?.access_token is undefined,
    // so the header literally becomes "Bearer undefined" rather than being
    // omitted. This would be rejected server-side, not silently allowed.
    expect(options.headers.Authorization).toBe('Bearer undefined')
  })
})

// ─── deleteFileFromDrive ─────────────────────────────────────────────────────

describe('deleteFileFromDrive', () => {
  // Edge case — no id
  it('returns { deleted: false, reason: "no_id" } without calling fetch when driveFileId is falsy', async () => {
    const result = await deleteFileFromDrive(null)
    expect(result).toEqual({ deleted: false, reason: 'no_id' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns { deleted: false, reason: "no_id" } for an empty string id', async () => {
    const result = await deleteFileFromDrive('')
    expect(result).toEqual({ deleted: false, reason: 'no_id' })
  })

  // Happy path
  it('sends a DELETE request and returns the server response on success', async () => {
    mockSession('abc123')
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) })

    const result = await deleteFileFromDrive('file-42')

    expect(result).toEqual({ deleted: true })
    const [url, options] = global.fetch.mock.calls[0]
    expect(options.method).toBe('DELETE')
    expect(url).toContain('file-42')
  })

  it('URL-encodes the driveFileId in the request path', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })

    await deleteFileFromDrive('folder/file with space.pdf')

    const [url] = global.fetch.mock.calls[0]
    expect(url).toContain(encodeURIComponent('folder/file with space.pdf'))
  })

  // Negative / error handling
  it('throws the server-provided error message when the response is not ok', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Not found' }) })

    await expect(deleteFileFromDrive('file-1')).rejects.toThrow('Not found')
  })

  it('throws a generic "Delete failed" message when json parsing fails entirely', async () => {
    mockSession()
    global.fetch.mockResolvedValue({ ok: false, json: async () => { throw new Error('bad json') } })

    await expect(deleteFileFromDrive('file-1')).rejects.toThrow('Delete failed')
  })
})
