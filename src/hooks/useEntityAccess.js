import { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from './useAuth'
import { hasFullAccess } from '../utils/roles'

// Which entities can the current user act as (create/edit records for)?
// Master/admin users get every active entity. Everyone else gets the union
// of entities they've been explicitly granted via user_entity_access AND
// every entity in a group they've been granted via user_group_access — and
// if that union is exactly one, `frozen` is true so the caller can
// auto-select it and lock the dropdown instead of showing a pointless list
// of one.
//
// This does not replace RLS — it only shapes which options a "from"/"seller"
// entity dropdown should offer client-side. The database policies (see
// has_entity_grant() in 035_group_access.sql, which resolves the exact same
// two grant types) are the real access boundary.
export function useEntityAccess() {
  const { profile } = useAuth()
  const [entities, setEntities] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    async function load() {
      setLoading(true)
      if (hasFullAccess(profile)) {
        const { data } = await supabase.from('entities')
          .select('id,name,short_name,gstin,state_code,type')
          .eq('is_active', true).eq('is_deleted', false).order('name')
        if (!cancelled) setEntities(data || [])
      } else {
        const [{ data: entityGrants }, { data: groupGrants }] = await Promise.all([
          supabase.from('user_entity_access')
            .select('expires_at, entity:entity_id(id,name,short_name,gstin,state_code,type)')
            .eq('user_id', profile.id),
          supabase.from('user_group_access').select('expires_at, group_id').eq('user_id', profile.id),
        ])
        // CHANGED: an expired grant shouldn't show up as a pickable entity —
        // has_entity_grant() (the actual RLS enforcement) filters the same
        // way, this is just the matching client-side UX so an expired entity
        // doesn't linger in a "from"/"seller" dropdown after it's already
        // stopped working server-side.
        const now = Date.now()
        const notExpired = g => !g.expires_at || new Date(g.expires_at).getTime() > now
        const directEntities = (entityGrants || []).filter(notExpired).map(g => g.entity).filter(Boolean)

        const activeGroupIds = (groupGrants || []).filter(notExpired).map(g => g.group_id)
        let groupEntities = []
        if (activeGroupIds.length) {
          const { data } = await supabase.from('entities')
            .select('id,name,short_name,gstin,state_code,type')
            .in('group_id', activeGroupIds).eq('is_active', true).eq('is_deleted', false)
          groupEntities = data || []
        }

        // Union, deduped — a user can hold both a direct grant and a group
        // grant that both cover the same entity.
        const byId = new Map()
        for (const e of [...directEntities, ...groupEntities]) byId.set(e.id, e)
        const granted = [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        if (!cancelled) setEntities(granted)
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [profile])

  const isMaster = hasFullAccess(profile)
  const frozen = !isMaster && entities.length === 1

  return { entities, isMaster, frozen, loading, defaultEntityId: !isMaster ? (entities[0]?.id || '') : '' }
}
