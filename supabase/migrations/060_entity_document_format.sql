-- ============================================================================
-- 060_entity_document_format.sql
--
-- Lets each entity choose which print format its Proforma Invoice / Purchase
-- Order / Tax Invoice uses, from Entity Settings.
--
--   NULL (default) = automatic: the entity's own format if one has been built
--                    for it, otherwise the Tally style (Kirti Sales format).
--   'tally' / 'vananam' / 'srpl' / 'kamakhya' = use that format.
--
--   * One optional column. Existing entities stay NULL, so every entity that
--     already has its own format keeps printing exactly as before.
--   * Idempotent — safe to run again.
-- ============================================================================

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS document_format text;

NOTIFY pgrst, 'reload schema';
