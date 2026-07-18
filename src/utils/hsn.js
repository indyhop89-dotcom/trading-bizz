/**
 * HSN Master utility — all rates in RUPEES (not paise).
 *
 * Slab format (jsonb, max_rate in RUPEES):
 *   [
 *     { "max_rate": 1000,  "gst_rate": 5  },   // rate/unit ≤ ₹1,000 → 5%
 *     { "max_rate": null,  "gst_rate": 12 }    // rate/unit > ₹1,000 → 12% (fallback)
 *   ]
 */

/**
 * Build a lookup map from hsn_master rows.
 * Multiple rows may share an hsn_code (one per effective-dated version), so
 * each map value is the array of all active versions for that code.
 * @param {Array} rows
 * @returns {Map<string, object[]>}
 */
export function buildHSNMap(rows) {
  const map = new Map()
  if (!rows) return map
  for (const row of rows) {
    if (!row.is_active) continue
    const key = row.hsn_code.trim()
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  return map
}

function toDateStr(d) {
  if (!d) return null
  if (typeof d === 'string') return d.slice(0, 10)
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}

// Pick the hsn_master version effective on asOfDate. Falls back to the
// earliest known version only when asOfDate predates every version (better
// than no rate at all for a code that does exist). If asOfDate falls
// *after* the earliest version but doesn't land inside any version's
// [effective_from, effective_to] range — e.g. the version that should cover
// it was deactivated — this returns null rather than resurrecting an
// earlier, no-longer-applicable rate.
function pickVersion(versions, asOfDate) {
  if (!versions || versions.length === 0) return null
  const asOf = toDateStr(asOfDate) || toDateStr(new Date())
  const sorted = [...versions].sort((a, b) =>
    (a.effective_from || '').localeCompare(b.effective_from || ''))
  if (asOf < (sorted[0].effective_from || '0000-01-01')) return sorted[0]
  let match = null
  for (const v of sorted) {
    const from = v.effective_from || '0000-01-01'
    const to = v.effective_to || null
    if (from <= asOf && (!to || to >= asOf)) match = v
  }
  return match
}

/**
 * Resolve the correct GST rate for a line item.
 *
 * @param {string}  hsnCode         - HSN code on the line
 * @param {number}  ratePerUnit     - rate per unit in RUPEES
 * @param {Map}     hsnMap          - Map from buildHSNMap()
 * @param {string|Date} [asOfDate]  - document date to resolve the rate as of (defaults to today)
 * @returns {{ gst_rate: number|null, source: string, master: object|null }}
 */
export function resolveGSTRate(hsnCode, ratePerUnit, hsnMap, asOfDate) {
  if (!hsnCode || !hsnMap || hsnMap.size === 0) {
    return { gst_rate: null, source: 'default', master: null }
  }

  const master = pickVersion(hsnMap.get(hsnCode.trim()), asOfDate)
  if (!master) return { gst_rate: null, source: 'default', master: null }

  if (master.rate_type === 'fixed') {
    return { gst_rate: Number(master.fixed_rate), source: 'hsn_fixed', master }
  }

  if (master.rate_type === 'slab') {
    const slabs = master.slabs
    if (!Array.isArray(slabs) || slabs.length === 0) {
      return { gst_rate: null, source: 'default', master }
    }

    const rate = Number(ratePerUnit) || 0

    for (const slab of slabs) {
      // null max_rate = open-ended fallback
      if (slab.max_rate === null || slab.max_rate === undefined) {
        return { gst_rate: Number(slab.gst_rate), source: 'hsn_slab', master }
      }
      if (rate <= Number(slab.max_rate)) {
        return { gst_rate: Number(slab.gst_rate), source: 'hsn_slab', master }
      }
    }

    return { gst_rate: null, source: 'default', master }
  }

  return { gst_rate: null, source: 'default', master: null }
}

/**
 * Human-readable slab summary for display.
 * e.g. "≤ ₹1,000 → 5%   |   > ₹1,000 → 12%"
 */
export function formatSlabSummary(slabs) {
  if (!Array.isArray(slabs) || slabs.length === 0) return '—'
  return slabs.map((slab, i) => {
    const prev  = slabs[i - 1]
    const lower = prev?.max_rate != null
      ? `> ₹${Number(prev.max_rate).toLocaleString('en-IN')}`
      : null
    const upper = slab.max_rate != null
      ? `≤ ₹${Number(slab.max_rate).toLocaleString('en-IN')}`
      : null
    const range = [lower, upper].filter(Boolean).join(' & ')
    return `${range || 'All'} → ${slab.gst_rate}%`
  }).join('   |   ')
}
