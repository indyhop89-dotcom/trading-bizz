// supabase/functions/create-user/index.ts
//
// Deploy with:  supabase functions deploy create-user
// Requires the service_role key to be available as an environment secret
// (SUPABASE_SERVICE_ROLE_KEY) — this is set automatically by Supabase for
// Edge Functions, you don't need to configure it manually.
//
// This function is the ONLY place service_role is used anywhere in this
// project. It must never be called with the anon key alone — it always
// re-checks the caller's own identity/role before doing anything.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    // Client scoped to the CALLER's own JWT — used only to verify who's asking.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser()
    if (callerErr || !caller) {
      return json({ error: 'Invalid session' }, 401)
    }

    const { data: callerProfile, error: profileErr } = await callerClient
      .from('profiles')
      .select('role, is_active')
      .eq('id', caller.id)
      .single()
    if (profileErr || !callerProfile || callerProfile.role !== 'master' || !callerProfile.is_active) {
      return json({ error: 'Only super admins can create users' }, 403)
    }

    const body = await req.json()
    const { email, full_name, role, entity_ids, password } = body

    if (!email || !full_name) {
      return json({ error: 'email and full_name are required' }, 400)
    }
    if (!['master', 'entity_user', 'viewer'].includes(role)) {
      return json({ error: 'role must be master, entity_user, or viewer' }, 400)
    }
    if (role !== 'master' && (!Array.isArray(entity_ids) || entity_ids.length === 0)) {
      return json({ error: 'entity_ids is required for non-master roles' }, 400)
    }

    // Admin client — service_role key, server-side only, never sent to the browser.
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const tempPassword = password || crypto.randomUUID()

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name },
    })
    if (createErr) {
      return json({ error: createErr.message }, 400)
    }

    const newUserId = created.user.id

    // handle_new_user trigger already inserted a profiles row with the
    // default role — update it if a non-default role was requested.
    if (role !== 'entity_user') {
      const { error: roleErr } = await adminClient
        .from('profiles')
        .update({ role })
        .eq('id', newUserId)
      if (roleErr) {
        return json({ error: `User created but role update failed: ${roleErr.message}` }, 500)
      }
    }

    if (role !== 'master' && entity_ids?.length) {
      const grants = entity_ids.map((entity_id) => ({
        user_id: newUserId,
        entity_id,
        granted_by: caller.id,
      }))
      const { error: grantErr } = await adminClient.from('user_entity_access').insert(grants)
      if (grantErr) {
        return json({ error: `User created but entity grants failed: ${grantErr.message}` }, 500)
      }
    }

    return json({
      user_id: newUserId,
      email,
      temp_password: password ? undefined : tempPassword,
    }, 200)
  } catch (e) {
    return json({ error: e.message || 'Unexpected error' }, 500)
  }
})

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
