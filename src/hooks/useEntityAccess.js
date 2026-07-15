import { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from './useAuth'
import { hasFullAccess } from '../utils/roles'

// Which entities can the current user act as (create/edit records for)?
// Master/admin users get every active entity. Everyone else gets only the
// entities they've been explicitly granted via user_entity_access — and if
// that's exactly one, `frozen` is true so the caller can auto-select it and
// lock the dropdown instead of showing a pointless list of one.
//
// This does not replace RLS — it only shapes which options a "from"/"seller"
// entity dropdown should offer client-side. The database policies are the
// real access boundary.
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
        const { data } = await supabase.from('user_entity_access')
          .select('entity:entity_id(id,name,short_name,gstin,state_code,type)')
          .eq('user_id', profile.id)
        const granted = (data || []).map(g => g.entity).filter(Boolean)
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
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
