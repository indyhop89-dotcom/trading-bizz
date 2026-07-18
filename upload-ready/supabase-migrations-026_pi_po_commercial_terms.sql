-- ============================================================================
-- 026_pi_po_commercial_terms.sql
--
-- The PI/PO PDF/Excel template (documentTemplate.js) has always had a
-- "Payment Terms" / "Delivery Timeline" / "Mode of Transport" row in its
-- accent bar — ported straight from the reference Vananam generator tools,
-- which had real input fields for these. But proforma_invoices and
-- purchase_orders never had matching columns, and neither form ever asked
-- for them, so those cells have always rendered blank ("—") on every
-- generated document. This adds the columns; the PI/PO forms (create, and
-- PI's edit mode) now collect them, and buildPIDoc/buildPODoc pass them
-- through to the template.
-- ============================================================================

-- Idempotent guards so a re-run (or partial earlier apply) is a safe no-op.
ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS payment_terms     text,
  ADD COLUMN IF NOT EXISTS delivery_timeline text,
  ADD COLUMN IF NOT EXISTS mode_of_transport text;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS payment_terms     text,
  ADD COLUMN IF NOT EXISTS delivery_timeline text,
  ADD COLUMN IF NOT EXISTS mode_of_transport text;
