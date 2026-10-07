// One-call CSV export for list pages: exportRows('orders', filtered).
//
// Exports whatever rows the page is currently showing (after its filters and
// search), with every plain column on them — so the file always matches the
// table and never depends on a hand-kept column list going stale.
//
// How a row is flattened:
//   • id columns (`id`, anything ending `_id`) and `is_deleted` are left out
//   • a joined record (seller, buyer, entity, orders, invoice…) becomes its
//     readable name / number
//   • values the page worked out itself (keys starting `_`, e.g. _status,
//     _pending) are included without the underscore — or as `computed_…`
//     when a real column already has that name
//   • jsonb-style values (arrays / objects with no name) are written as JSON
// Pass `extra(row)` to add or override columns for a page.
import { downloadCSV } from './csvTemplate'

const LABEL_KEYS = ['short_name', 'name', 'invoice_no', 'pi_no', 'po_no', 'expense_no', 'note_no', 'order_no']

function labelOf(obj) {
  for (const k of LABEL_KEYS) if (obj[k] != null && obj[k] !== '') return obj[k]
  return undefined
}

export function flattenRow(row) {
  const out = {}
  // Real columns first, then the page's worked-out values, so a clash is always resolved the same way.
  const entries = Object.entries(row || {})
  for (const [key, val] of [...entries.filter(([k]) => !k.startsWith('_')), ...entries.filter(([k]) => k.startsWith('_'))]) {
    if (key === 'id' || key.endsWith('_id') || key === 'is_deleted') continue
    const computed = key.startsWith('_')
    // A worked-out value that shares a name with a real column (an invoice's
    // own `status` vs the tracker's `_status`) is kept as `computed_status`.
    const col = computed ? (key.slice(1) in out ? `computed_${key.slice(1)}` : key.slice(1)) : key
    if (val === null || val === undefined) { if (!computed) out[col] = ''; continue }
    if (val instanceof Date) { out[col] = val.toISOString(); continue }
    if (typeof val === 'object') {
      if (computed) continue                       // page-internal working data
      const label = Array.isArray(val) ? undefined : labelOf(val)
      out[col] = label !== undefined ? label : JSON.stringify(val)
      continue
    }
    out[col] = val
  }
  return out
}

// Returns the number of rows written (0 = nothing to export, no file made).
export function exportRows(name, rows, extra) {
  const flat = (rows || []).map(r => ({ ...flattenRow(r), ...(extra ? extra(r) : {}) }))
  if (flat.length === 0) return 0
  const headers = []
  for (const r of flat) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k)
  downloadCSV(`${name}_${new Date().toISOString().slice(0, 10)}.csv`, headers, flat)
  return flat.length
}
