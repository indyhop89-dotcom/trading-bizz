import { supabase } from '../supabaseClient'
import { fetchAllPages } from './query'

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

// ─── Entity-wise numbering formats ─────────────────────────────────────────
// CHANGED: each entity can configure its own number format per document type
// (entities.numbering — see 063_entity_document_numbering.sql). This sits on
// top of suggestNextNo() above rather than beside it: a document type with no
// format configured still gets exactly the number suggestNextNo() gives today.
//
//   number = [prefix, financial year, sequence] joined by the separator, + suffix
//   e.g. prefix "KV/PO", fy "YY-YY", separator "/", padding 4 → KV/PO/26-27/0001

export const NUMBERED_DOCS = [
  { key: 'sales_invoice',   label: 'Sales Invoice',    tail: '' },
  { key: 'po',              label: 'Purchase Order',   tail: 'PO' },
  { key: 'pi',              label: 'Proforma Invoice', tail: 'PI' },
  { key: 'service_invoice', label: 'Service Invoice',  tail: 'SRV' },
]
export const FY_FORMATS = [
  { value: 'YY-YY',   label: '26-27' },
  { value: 'YYYY',    label: '2627' },
  { value: 'YYYY-YY', label: '2026-27' },
  { value: 'none',    label: 'No year' },
]

export function defaultPrefix(docKey, shortName) {
  const base = (shortName || '').toUpperCase().replace(/\s+/g, '')
  const tail = NUMBERED_DOCS.find(d => d.key === docKey)?.tail
  return [base, tail].filter(Boolean).join('/')
}
export function defaultNumberFormat(docKey, shortName) {
  return { enabled: true, prefix: defaultPrefix(docKey, shortName), fy_format: 'YY-YY', separator: '/', start: 1, padding: 4, suffix: '', reset_each_fy: true }
}

// ── Entity form helpers (components/NumberingSettings.jsx) ──
// What a row shows: the saved format, with the prefix following the short
// name until it has been typed in by hand.
export function effectiveFormat(numbering, docKey, shortName) {
  const saved = numbering?.[docKey]
  const base = defaultNumberFormat(docKey, shortName)
  if (!saved) return { ...base, enabled: false }
  return { ...base, ...saved, prefix: saved.prefix ?? defaultPrefix(docKey, shortName) }
}

// Makes the value ready to save: fills in prefixes that were still following the short name.
export function finalizeNumbering(numbering, shortName) {
  if (!numbering) return null
  const out = {}
  for (const d of NUMBERED_DOCS) if (numbering[d.key]) out[d.key] = effectiveFormat(numbering, d.key, shortName)
  return Object.keys(out).length ? out : null
}

// Every document type switched on with its suggested format — the starting point for a new entity.
export function suggestedNumbering() {
  return Object.fromEntries(NUMBERED_DOCS.map(d => [d.key, { enabled: true }]))
}

// Financial-year text for a document date (Indian FY: Apr–Mar).
export function fyText(dateInput, fyFormat) {
  if (!fyFormat || fyFormat === 'none') return ''
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  const yy = n => String(n).slice(2)
  if (fyFormat === 'YYYY') return `${yy(start)}${yy(start + 1)}`
  if (fyFormat === 'YYYY-YY') return `${start}-${yy(start + 1)}`
  return `${yy(start)}-${yy(start + 1)}`
}

const cleanFormat = f => ({
  prefix: (f?.prefix || '').trim(),
  fy_format: f?.fy_format || 'YY-YY',
  separator: f?.separator ?? '/',
  start: Math.max(1, parseInt(f?.start, 10) || 1),
  padding: Math.min(10, Math.max(1, parseInt(f?.padding, 10) || 1)),
  suffix: (f?.suffix || '').trim(),
  reset_each_fy: f?.reset_each_fy !== false,
})

export function formatDocNo(format, dateInput, seq) {
  const f = cleanFormat(format)
  return [f.prefix, fyText(dateInput, f.fy_format), String(seq).padStart(f.padding, '0')].filter(Boolean).join(f.separator) + f.suffix
}

// Pure: the next number for a format, given the numbers already in use.
// When the sequence restarts each financial year only that year's numbers
// count; otherwise the sequence runs on across years.
export function nextFromExisting(format, dateInput, existingNos, excludeSet) {
  const f = cleanFormat(format)
  const fy = fyText(dateInput, f.fy_format)
  const head = f.prefix ? escapeRegex(f.prefix + f.separator) : ''
  const year = !fy ? '' : f.reset_each_fy ? escapeRegex(fy + f.separator) : `[^${escapeRegex(f.separator) || '/'}]+${escapeRegex(f.separator)}`
  const re = new RegExp(`^${head}${year}(\\d+)${escapeRegex(f.suffix)}$`, 'i')
  const used = new Set()
  let maxSeq = 0
  for (const no of existingNos || []) {
    if (!no) continue
    used.add(String(no).toLowerCase())
    const m = String(no).trim().match(re)
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10))
  }
  let seq = Math.max(maxSeq + 1, f.start)
  let candidate = formatDocNo(f, dateInput, seq)
  // Never hand out a number that already exists, whatever format it was made in.
  while (used.has(candidate.toLowerCase()) || excludeSet?.has(candidate.toLowerCase())) { seq++; candidate = formatDocNo(f, dateInput, seq) }
  return candidate
}

/**
 * The number for a new document. Uses the issuing entity's configured format
 * for `docType` when one is switched on; otherwise falls back to
 * suggestNextNo() with the arguments every page already passes — so nothing
 * changes for an entity that has not set a format (or before the numbering
 * column exists).
 *
 * nextDocNo({ docType: 'pi', entityId, date, table, noCol, entityShort, fyCode, excludeSet })
 */
export async function nextDocNo({ docType, entityId, date, table, noCol, entityShort, fyCode, excludeSet }) {
  let format = null
  if (entityId) {
    const { data, error } = await supabase.from('entities').select('numbering').eq('id', entityId).single()
    if (!error) format = data?.numbering?.[docType] || null
  }
  if (!format?.enabled) return suggestNextNo({ table, noCol, entityShort, fyCode, excludeSet })
  const f = cleanFormat(format)
  // Every existing number with this prefix (all pages, so a long history is never cut short).
  const like = `${f.prefix.replace(/[\\%_]/g, m => `\\${m}`)}%`
  const { data } = await fetchAllPages(() => {
    const q = supabase.from(table).select(noCol)
    return (f.prefix ? q.ilike(noCol, like) : q).order(noCol)
  })
  return nextFromExisting(f, date, (data || []).map(r => r[noCol]), excludeSet)
}
