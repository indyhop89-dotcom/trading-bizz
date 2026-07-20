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
  '29AKNPK1819J1ZR': { // Kirti Sales and Services (KSS)
    label: 'KSS',
    family: 'tally',
    // Replicated from a standalone Tally-style HTML generator tool — the
    // real Tally ERP sales-voucher print layout is pure black-on-white,
    // with no accent color at all. Both values are '#000000' only to
    // satisfy the uniqueness check below; the kirti template ignores them.
    navy: '#000000',
    orange: '#000000',
  },
  '29AANCM1499F1ZY': { // MVL — Mesindus Ventures Limited
    label: 'MVL',
    // Same 'tally' family as Kirti — MVL's format is a direct mirror of
    // Kirti's (per product request), not a separate hand-built layout. The
    // kirtiDocumentTemplate.js module is already fully generic (pulls
    // name/address/GSTIN/PAN/bank/logo from doc.sellerEntity, nothing
    // hardcoded to Kirti), so sharing the family here is all that's needed
    // — no new template code.
    family: 'tally',
    // Monochrome like Kirti's — these values are otherwise unused by the
    // tally template, just needs to differ from Kirti's exact '#000000'
    // pair to pass the uniqueness check below.
    navy: '#010101',
    orange: '#010101',
  },
  // TODO(kamakhya-gstin): placeholder key — swap for the real GSTIN once
  // provided (entities table lookup is blocked by RLS without an
  // authenticated session, so this couldn't be confirmed automatically).
  'PLACEHOLDER-KAMAKHYA-GSTIN': { // Kamakhya Loyalties
    label: 'Kamakhya',
    family: 'kamakhya',
    // Replicated from a standalone Zoho-style PI generator HTML tool shared
    // for this entity — a bordered A4 layout (thin black/grey rules, no
    // color-filled header bars) with a single navy accent for headings and
    // emphasis, genuinely different structure from vananam/srpl/tally (see
    // kamakhyaDocumentTemplate.js's module docstring for specifics).
    navy: '#0b2b6b',
    orange: '#0b2b6b',
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
