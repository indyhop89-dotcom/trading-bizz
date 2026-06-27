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
 * @param {Array} rows
 * @returns {Map<string, object>}
 */
export function buildHSNMap(rows) {
  const map = new Map()
  if (!rows) return map
  for (const row of rows) {
    if (row.is_active) map.set(row.hsn_code.trim(), row)
  }
  return map
}

/**
 * Resolve the correct GST rate for a line item.
 *
 * @param {string}  hsnCode         - HSN code on the line
 * @param {number}  ratePerUnit     - rate per unit in RUPEES
 * @param {Map}     hsnMap          - Map from buildHSNMap()
 * @returns {{ gst_rate: number|null, source: string, master: object|null }}
 */
export function resolveGSTRate(hsnCode, ratePerUnit, hsnMap) {
  if (!hsnCode || !hsnMap || hsnMap.size === 0) {
    return { gst_rate: null, source: 'default', master: null }
  }

  const master = hsnMap.get(hsnCode.trim())
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
