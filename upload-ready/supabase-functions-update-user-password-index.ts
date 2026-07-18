// supabase/functions/update-user-password/index.ts
//
// Deploy with:  supabase functions deploy update-user-password
//
// Lets a master or admin reset ANOTHER user's password. A user changing
// their OWN password does not need this — that's a plain
// supabase.auth.updateUser({ password }) call from the client, since it only
// needs the caller's own session (see src/components/Layout/Sidebar.jsx).
// This function exists because GoTrue only allows service_role to set a
// password on someone else's account.

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
      return json({ error: 'Only master or admin users can reset another user\'s password' }, 403)
    }

    const body = await req.json()
    const { user_id, password } = body
    if (!user_id) {
      return json({ error: 'user_id is required' }, 400)
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: targetProfile, error: targetErr } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', user_id)
      .single()
    if (targetErr || !targetProfile) {
      return json({ error: 'User not found' }, 404)
    }

    if (callerIsAdmin) {
      // Admin may only reset entity_user/viewer passwords — never a peer
      // admin's or a master's — and only for a target whose entity access is
      // entirely inside the admin's own scope (same rule as user creation).
      if (['master', 'admin'].includes(targetProfile.role)) {
        return json({ error: 'Admins cannot reset a master or admin password' }, 403)
      }
      const [{ data: callerGrants }, { data: targetGrants }] = await Promise.all([
        adminClient.from('user_entity_access').select('entity_id').eq('user_id', caller.id),
        adminClient.from('user_entity_access').select('entity_id').eq('user_id', user_id),
      ])
      const callerEntityIds = new Set((callerGrants || []).map((g) => g.entity_id))
      const outOfScope = (targetGrants || []).filter((g) => !callerEntityIds.has(g.entity_id))
      if (outOfScope.length > 0) {
        return json({ error: 'You can only reset passwords for users scoped to your own entities' }, 403)
      }
    }

    const tempPassword = password || crypto.randomUUID()
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(user_id, { password: tempPassword })
    if (updateErr) {
      return json({ error: updateErr.message }, 400)
    }

    return json({ temp_password: password ? undefined : tempPassword }, 200)
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
