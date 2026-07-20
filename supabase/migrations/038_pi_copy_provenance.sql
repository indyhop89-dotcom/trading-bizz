-- ============================================================================
-- 038_pi_copy_provenance.sql
--
-- "Copy Lines from Another PI" (PI/index.jsx) lets a new PI's lines be
-- copied from any other PI, on any order — not just the previous leg of
-- the same order. Records which source PI a new PI was copied from, so
-- the Order Summary's margin calc (computeLegMargin, Orders/index.jsx) can
-- trace a leg's real cost back to wherever it actually came from, instead
-- of assuming "previous leg of this same order" (which breaks once a leg's
-- PI is built from an unrelated order's PI).
--
-- ON DELETE SET NULL: deleting the source PI shouldn't cascade-delete
-- everything copied from it — it just means the margin trace-back for
-- affected legs falls back to the same-order/opening-stock default.
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS copied_from_pi_id uuid REFERENCES proforma_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_proforma_invoices_copied_from ON proforma_invoices(copied_from_pi_id) WHERE copied_from_pi_id IS NOT NULL;

COMMENT ON COLUMN proforma_invoices.copied_from_pi_id IS 'Source PI this one''s lines were bulk-copied from via "Copy Lines from Another PI", if any. Used to trace real cost basis across orders in the Order Summary margin calc.';
