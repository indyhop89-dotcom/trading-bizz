/**
 * Per-entity document theme registry — every entity's Proforma Invoice /
 * Purchase Order / Tax Invoice must look visually distinct from every other
 * entity's (product decision: no shared "generic" look, no two entities on
 * the same colors). Keyed by GSTIN — the stable, unique legal identifier —
 * rather than name/short_name, which can be renamed or aren't guaranteed
 * unique in the entities table.
 *
 * Only entities with a hand-built format go here. An entity NOT listed has
 * no format yet: resolveEntityTheme() returns null for it, and
 * documentTemplate.js/documentExcel.js refuse to generate anything for that
 * entity rather than silently falling back to someone else's colors. Add a
 * new entry here once its actual format has been shared and replicated —
 * do not invent placeholder formats ahead of that.
 *
 * `family` names which structural template renders this entity's documents
 * (documentTemplate.js dispatches on it) — different companies' real-world
 * formats aren't just different colors on one layout; SRPL's format (a
 * bordered, blue+black corporate-software export) has a genuinely different
 * structure from VRVPL's (custom-built, navy+orange, color-block headers).
 */
const ENTITY_THEMES = {
  '29AAJCV0573F1Z4': { // VRVPL — Vananam Retail Ventures Private Limited
    label: 'VRVPL',
    family: 'vananam',
    navy: '#2D3272',
    orange: '#E8843A',
  },
  '29ABLCS7994J1Z7': { // SRPL — Siddhidhatri Retail Private Limited (Siddhi)
    label: 'SRPL',
    family: 'srpl',
    // Estimated from the reference PO/PI/Tax Invoice PDFs (text-only
    // extraction, no exact pixel color available) — confirm against the
    // real documents and correct if this doesn't match. SRPL's own format
    // has no second accent color (it uses black for the total/footer bars
    // instead, which the srpl template hardcodes as neutral rather than
    // per-entity themed) — `orange` here is unused by the srpl template and
    // only kept equal to `navy` to satisfy the uniqueness check below.
    navy: '#1B4F91',
    orange: '#1B4F91',
  },
}

// Guards against ever configuring two entities with the same color pair —
// runs once at module load so a copy-paste mistake when adding a new entity
// is caught immediately, not discovered later by someone noticing two
// invoices look alike.
;(function assertThemesAreUnique() {
  const seen = new Map()
  for (const [gstin, theme] of Object.entries(ENTITY_THEMES)) {
    const key = `${theme.navy.toLowerCase()}|${theme.orange.toLowerCase()}`
    const clash = seen.get(key)
    if (clash) {
      throw new Error(`Document theme collision: "${theme.label}" (${gstin}) uses the same colors as "${clash}" — every entity's format must be visually unique.`)
    }
    seen.set(key, `${theme.label} (${gstin})`)
  }
})()

/** Returns the configured theme for a GSTIN, or null if none is set up yet. */
export function resolveEntityTheme(gstin) {
  if (!gstin) return null
  return ENTITY_THEMES[gstin.trim().toUpperCase()] || null
}
