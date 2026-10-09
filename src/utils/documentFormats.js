// Invoice format names — the formats are built into the app
// (entityDocumentThemes.js); their display names can be changed from
// Settings → Invoice Formats and are stored in document_format_names
// (061_document_format_names.sql).
import { supabase } from '../supabaseClient'
import { DOCUMENT_FORMATS, DEFAULT_DOCUMENT_FORMAT, resolveEntityTheme } from './entityDocumentThemes'

// { format_key: custom name }. Returns {} on any error (for example before the
// table exists), so every screen simply falls back to the built-in names.
export async function fetchFormatNames() {
  const { data, error } = await supabase.from('document_format_names').select('format_key,display_name')
  if (error) return {}
  return Object.fromEntries((data || []).map(r => [r.format_key, r.display_name]))
}

export function formatName(key, names) {
  return names?.[key] || DOCUMENT_FORMATS.find(f => f.value === key)?.label || key
}

// The format an entity gets while its setting is left on Automatic.
export function automaticFormatKey(gstin) {
  return resolveEntityTheme(gstin)?.family || DEFAULT_DOCUMENT_FORMAT
}

// The format an entity's documents actually print in right now.
export function effectiveFormatKey(entity) {
  const chosen = (entity?.document_format || '').trim().toLowerCase()
  return DOCUMENT_FORMATS.some(f => f.value === chosen) ? chosen : automaticFormatKey(entity?.gstin)
}

// Saves a custom name; a blank name removes it (back to the built-in name).
export async function saveFormatName(key, name, userId) {
  const clean = (name || '').trim()
  if (!clean) return supabase.from('document_format_names').delete().eq('format_key', key)
  return supabase.from('document_format_names')
    .upsert({ format_key: key, display_name: clean, updated_at: new Date(), updated_by: userId || null }, { onConflict: 'format_key' })
}
