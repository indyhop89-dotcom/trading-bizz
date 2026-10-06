-- ============================================================================
-- 056_order_description_and_pi_po_link.sql
--
-- Two additive columns. Nothing is dropped, renamed or made NOT NULL, and no
-- RLS policy changes — existing rows and existing code keep working.
--
-- 1. orders.description
--    Short free-text label for what the order is ("Monofilaments",
--    "Garments"), shown next to the order name in the Orders list, the order
--    header and the Order dropdowns on PI / PO / Invoice. Separate from
--    `notes`, which stays a longer internal remark.
--
-- 2. proforma_invoices.po_id
--    Lets SEVERAL PIs point at ONE purchase order (a buyer raises one PO and
--    the seller raises a PI per tranche against it). Until now the only link
--    was purchase_orders.pi_id — one PO could reference exactly one PI.
--    That old column is kept as-is for existing records; the backfill below
--    copies each existing PO→PI link onto the PI side so every already-linked
--    pair shows up under the new column too.
--
--    ON DELETE SET NULL: POs are soft-deleted in the app (is_deleted), but if
--    one is ever hard-deleted its PIs should simply become unlinked, not be
--    deleted with it.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ── 1. Order description ────────────────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN orders.description IS 'Short label for what the order is (e.g. "Monofilaments", "Garments"). Shown beside the order name in lists and dropdowns.';

-- ── 2. PI → PO link (many PIs to one PO) ────────────────────────────────────
ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_proforma_invoices_po_id ON proforma_invoices(po_id) WHERE po_id IS NOT NULL;

COMMENT ON COLUMN proforma_invoices.po_id IS 'Purchase order this PI was raised against, if any. Many PIs may share one PO. Supersedes purchase_orders.pi_id (one PI per PO), which is kept for older records.';

-- Backfill: every existing PO that already references a PI gets that link
-- mirrored onto the PI. Only fills PIs that have no po_id yet, and skips
-- soft-deleted POs, so re-running never overwrites a link set in the app.
UPDATE proforma_invoices pi
SET    po_id = po.id
FROM   purchase_orders po
WHERE  po.pi_id = pi.id
  AND  po.is_deleted = false
  AND  pi.po_id IS NULL;
