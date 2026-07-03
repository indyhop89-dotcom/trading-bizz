import { supabase } from '../supabaseClient'

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Best-effort client-side document-number suggestion.
 *
 * CHANGED: the DB-side sequence functions (next_pi_no / next_po_no /
 * next_inv_no) and their backing sequence tables (pi_sequence / po_sequence /
 * inv_sequence) were never actually created on the live database — confirmed
 * via information_schema + pg_proc — despite being called from the app since
 * day one. Every "auto-generate" attempt was silently failing (or, before
 * that, failing loudly with a schema-cache error). This replaces that broken
 * RPC dependency with a working alternative: look at the highest existing
 * number matching `{entityShort}-{fyCode}-NNN` for this table+column, and
 * suggest the next one in sequence.
 *
 * NOT atomic — two people saving at the exact same instant could in theory
 * get the same suggestion. For a small internal team this risk is low, and
 * every save path already checks the final number against existing records
 * before writing, so a collision is caught (as a duplicate error) rather
 * than silently overwriting data. The number field also stays fully
 * editable — this is only ever a starting suggestion, not an enforced format.
 */
export async function suggestNextNo({ table, noCol, entityShort, fyCode, excludeSet }) {
  const safeEntity = (entityShort || 'X').toUpperCase().replace(/\s+/g, '')
  const prefix = `${safeEntity}-${fyCode}-`
  const { data } = await supabase.from(table).select(noCol).ilike(noCol, `${prefix}%`)
  const re = new RegExp(`^${escapeRegex(prefix)}(\\d+)$`, 'i')

  let maxSeq = 0
  for (const row of data || []) {
    const m = row[noCol]?.match(re)
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10))
  }

  let seq = maxSeq + 1
  let candidate = `${prefix}${String(seq).padStart(3, '0')}`
  while (excludeSet?.has(candidate.toLowerCase())) {
    seq++
    candidate = `${prefix}${String(seq).padStart(3, '0')}`
  }
  return candidate
}
