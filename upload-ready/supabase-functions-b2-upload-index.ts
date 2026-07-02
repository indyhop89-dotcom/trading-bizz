const B2_KEY_ID      = Deno.env.get('B2_APPLICATION_KEY_ID')!
const B2_APP_KEY     = Deno.env.get('B2_APPLICATION_KEY')!
const B2_BUCKET_ID   = Deno.env.get('B2_BUCKET_ID')!
const B2_BUCKET_NAME = Deno.env.get('B2_BUCKET_NAME')!
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

async function b2Authorize() {
  const credentials = btoa(`${B2_KEY_ID}:${B2_APP_KEY}`)
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${credentials}` },
  })
  const data = await res.json()
  if (!res.ok) throw new Error('B2 authorize failed: ' + JSON.stringify(data))
  return data
}

async function b2GetUploadUrl(apiUrl: string, authToken: string) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: B2_BUCKET_ID }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error('B2 get upload url failed: ' + JSON.stringify(data))
  return data
}

async function sha1Hex(buffer: ArrayBuffer) {
  const hash = await crypto.subtle.digest('SHA-1', buffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function b2FindFileId(apiUrl: string, authToken: string, key: string) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_list_file_names`, {
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: B2_BUCKET_ID, startFileName: key, maxFileCount: 1 }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error('B2 list file names failed: ' + JSON.stringify(data))
  const match = (data.files || []).find((f: { fileName: string }) => f.fileName === key)
  return match ? (match.fileId as string) : null
}

async function b2DeleteFile(apiUrl: string, authToken: string, key: string, fileId: string) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: key, fileId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error('B2 delete failed: ' + JSON.stringify(data))
  return data
}

function json(obj: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = new URL(req.url)

  try {
    if (req.method === 'POST' && url.pathname.endsWith('/upload')) {
      const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
      if (!token) return json({ error: 'Missing auth token' }, 401, corsHeaders)

      const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      })
      if (!verifyRes.ok) return json({ error: 'Invalid session' }, 401, corsHeaders)

      const formData   = await req.formData()
      const file       = formData.get('file')
      const folderName = formData.get('folderName')?.toString() || 'General'
      const docFolder  = formData.get('docFolder')?.toString() || '' // CHANGED: optional document-type subfolder
      if (!file || !(file instanceof File)) {
        return json({ error: 'No file provided' }, 400, corsHeaders)
      }

      // CHANGED: sanitize each path segment independently so '/' between
      // entity and doc-type folders survives instead of being stripped out
      const sanitizeSegment = (s: string) => s.replace(/[^a-zA-Z0-9-_]/g, '_')
      const safeFolder    = sanitizeSegment(folderName)
      const safeDocFolder = docFolder ? sanitizeSegment(docFolder) : ''
      const safeName      = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')
      const key = safeDocFolder
        ? `${safeFolder}/${safeDocFolder}/${Date.now()}_${safeName}`
        : `${safeFolder}/${Date.now()}_${safeName}`

      const auth      = await b2Authorize()
      const apiUrl     = auth.apiInfo.storageApi.apiUrl
      const uploadInfo = await b2GetUploadUrl(apiUrl, auth.authorizationToken)

      const fileBuffer = await file.arrayBuffer()
      const sha1 = await sha1Hex(fileBuffer)

      const uploadRes = await fetch(uploadInfo.uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: uploadInfo.authorizationToken,
          'X-Bz-File-Name': encodeURIComponent(key),
          'Content-Type': file.type || 'b2/x-auto',
          'X-Bz-Content-Sha1': sha1,
          'Content-Length': String(fileBuffer.byteLength),
        },
        body: fileBuffer,
      })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok) throw new Error('B2 upload failed: ' + JSON.stringify(uploadData))

      const fileUrl = `${SUPABASE_URL}/functions/v1/b2-upload/file/${encodeURIComponent(key)}`

      return json({
        drive_file_id: key,
        drive_url: fileUrl,
        file_name: file.name,
      }, 200, corsHeaders)
    }

    if (req.method === 'GET' && url.pathname.includes('/file/')) {
      const key = decodeURIComponent(url.pathname.split('/file/')[1])

      const auth       = await b2Authorize()
      const downloadUrl = auth.apiInfo.storageApi.downloadUrl

      const fileRes = await fetch(
        `${downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(key)}`,
        { headers: { Authorization: auth.authorizationToken } }
      )
      if (!fileRes.ok) return new Response('Not found', { status: 404, headers: corsHeaders })

      const headers = new Headers(corsHeaders)
      const contentType = fileRes.headers.get('Content-Type')
      if (contentType) headers.set('Content-Type', contentType)

      return new Response(fileRes.body, { headers })
    }

    if (req.method === 'DELETE' && url.pathname.includes('/file/')) {
      const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
      if (!token) return json({ error: 'Missing auth token' }, 401, corsHeaders)

      const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      })
      if (!verifyRes.ok) return json({ error: 'Invalid session' }, 401, corsHeaders)

      const key = decodeURIComponent(url.pathname.split('/file/')[1])

      const auth   = await b2Authorize()
      const apiUrl = auth.apiInfo.storageApi.apiUrl

      const fileId = await b2FindFileId(apiUrl, auth.authorizationToken, key)
      if (!fileId) {
        // Already gone (or never existed) — treat as success so the DB row can still be cleaned up.
        return json({ deleted: false, reason: 'not_found' }, 200, corsHeaders)
      }

      await b2DeleteFile(apiUrl, auth.authorizationToken, key, fileId)
      return json({ deleted: true }, 200, corsHeaders)
    }

    return new Response('Not found', { status: 404, headers: corsHeaders })

  } catch (err) {
    return json({ error: (err as Error).message }, 500, corsHeaders)
  }
})
