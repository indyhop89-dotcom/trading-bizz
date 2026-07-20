-- Adds a general-purpose Terms & Conditions free-text field to entities —
-- distinct from the existing Reliance-portal-specific `reliance_notes`
-- column. Set once per entity in Settings > Entities and printed on every
-- PI/PO/Tax Invoice that entity issues (all document template families:
-- vananam, srpl, and tally), so the same terms don't need retyping per
-- document. Optional — a blank value simply omits the block from the
-- printed document, same as every other conditionally-rendered section.
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS terms_and_conditions text;
