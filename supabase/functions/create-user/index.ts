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
    const callerIsMaster = callerProfile?.role === 'master'
    const callerIsAdmin = callerProfile?.role === 'admin'
    if (profileErr || !callerProfile || !callerProfile.is_active || !(callerIsMaster || callerIsAdmin)) {
      return json({ error: 'Only master or admin users can create users' }, 403)
    }

    const body = await req.json()
    const { email, full_name, role, entity_ids, entity_expiries, group_ids, group_expiries, password } = body

    if (!email || !full_name) {
      return json({ error: 'email and full_name are required' }, 400)
    }
    // Master may hand out any role, including more masters/admins. Admins can
    // only create entity_user/viewer — never another admin or a master, to
    // stop an admin from escalating their own or a peer's privileges.
    const assignableRoles = callerIsMaster
      ? ['master', 'admin', 'entity_user', 'viewer']
      : ['entity_user', 'viewer']
    if (!assignableRoles.includes(role)) {
      return json({ error: `role must be one of: ${assignableRoles.join(', ')}` }, 400)
    }
    // CHANGED: a non-master user's access can now come from entity grants,
    // group grants, or both — only reject if BOTH are empty, not just
    // entity_ids alone (a group-only grant is a valid way to give access).
    const hasEntityIds = Array.isArray(entity_ids) && entity_ids.length > 0
    const hasGroupIds = Array.isArray(group_ids) && group_ids.length > 0
    if (role !== 'master' && !hasEntityIds && !hasGroupIds) {
      return json({ error: 'Select at least one entity or group for this role' }, 400)
    }

    // Admin client — service_role key, server-side only, never sent to the browser.
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // Admins are scoped to their own entities/groups — they can only grant
    // access to entities/groups they themselves hold a grant for, never
    // anything outside that.
    if (callerIsAdmin && entity_ids?.length) {
      const { data: callerGrants } = await adminClient
        .from('user_entity_access')
        .select('entity_id')
        .eq('user_id', caller.id)
      const callerEntityIds = new Set((callerGrants || []).map((g) => g.entity_id))
      const outOfScope = entity_ids.filter((id) => !callerEntityIds.has(id))
      if (outOfScope.length > 0) {
        return json({ error: 'You can only grant access to entities you yourself have access to' }, 403)
      }
    }
    if (callerIsAdmin && group_ids?.length) {
      const { data: callerGroupGrants } = await adminClient
        .from('user_group_access')
        .select('group_id')
        .eq('user_id', caller.id)
      const callerGroupIds = new Set((callerGroupGrants || []).map((g) => g.group_id))
      const outOfScope = group_ids.filter((id) => !callerGroupIds.has(id))
      if (outOfScope.length > 0) {
        return json({ error: 'You can only grant access to groups you yourself have access to' }, 403)
      }
    }

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
      // entity_expiries is optional — an entity_id absent from it (or the
      // whole field omitted) gets permanent access, exactly as before.
      const grants = entity_ids.map((entity_id) => ({
        user_id: newUserId,
        entity_id,
        granted_by: caller.id,
        expires_at: entity_expiries?.[entity_id] || null,
      }))
      const { error: grantErr } = await adminClient.from('user_entity_access').insert(grants)
      if (grantErr) {
        return json({ error: `User created but entity grants failed: ${grantErr.message}` }, 500)
      }
    }

    if (role !== 'master' && group_ids?.length) {
      const groupGrants = group_ids.map((group_id) => ({
        user_id: newUserId,
        group_id,
        granted_by: caller.id,
        expires_at: group_expiries?.[group_id] || null,
      }))
      const { error: groupGrantErr } = await adminClient.from('user_group_access').insert(groupGrants)
      if (groupGrantErr) {
        return json({ error: `User created but group grants failed: ${groupGrantErr.message}` }, 500)
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
