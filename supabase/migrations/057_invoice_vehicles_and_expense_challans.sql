-- ============================================================================
-- 057_invoice_vehicles_and_expense_challans.sql
--
-- WHY
-- 1. An invoice could hold only ONE vehicle / challan / transporter (single
--    text columns on `invoices`). Goods for one invoice often go in several
--    vehicles, each with its own transporter challan, and one challan can
--    cover several invoices. `invoice_vehicles` holds one row per vehicle per
--    invoice.
-- 2. A freight expense needs to be tagged to the challan(s) it pays for, so
--    the invoices and orders behind it can be shown automatically.
--    `expense_challans` holds one row per challan per expense. It stores the
--    challan NUMBER + transporter (not a vehicle-row id) on purpose: when the
--    same challan is later entered on another invoice, the expense picks that
--    invoice up too without being edited.
--
-- SAFE TO RUN — additive only.
--   * Two new tables, their indexes and RLS policies.
--   * Nothing on `invoices` or `expenses` is dropped, renamed or altered.
--   * invoices.vehicle_no / challan_no / transporter_name are KEPT. The app
--     keeps writing a combined copy of the vehicle rows into them so printed
--     invoices and anything else reading those columns keeps working.
--   * E-way Bill columns are untouched, so stock movement is unaffected.
--   * The backfill only INSERTs into the new table; it never updates invoices.
-- Idempotent — safe to re-run.
-- ============================================================================

-- ── 1. Vehicles per invoice ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_vehicles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  vehicle_no        text,
  challan_no        text,
  transporter_name  text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_vehicles_invoice ON invoice_vehicles(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_vehicles_challan ON invoice_vehicles(lower(challan_no)) WHERE challan_no IS NOT NULL;

-- RLS — same shape as invoice_lines (014_child_and_missing_table_rls.sql):
-- visible to whoever can see the invoice, writable by the seller side.
ALTER TABLE invoice_vehicles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_vehicles_select ON invoice_vehicles;
CREATE POLICY invoice_vehicles_select ON invoice_vehicles FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (
      is_super_admin() OR has_entity_grant(i.seller_entity_id) OR (has_entity_grant(i.buyer_entity_id) AND i.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS invoice_vehicles_write ON invoice_vehicles;
CREATE POLICY invoice_vehicles_write ON invoice_vehicles FOR ALL USING (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (is_super_admin() OR has_entity_grant(i.seller_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (is_super_admin() OR has_entity_grant(i.seller_entity_id)))
);

-- Backfill: every invoice that already has a vehicle, challan or transporter
-- gets ONE row carrying those values. Skips invoices that already have a row,
-- so a re-run never duplicates.
INSERT INTO invoice_vehicles (invoice_id, vehicle_no, challan_no, transporter_name)
SELECT i.id,
       NULLIF(btrim(i.vehicle_no), ''),
       NULLIF(btrim(i.challan_no), ''),
       NULLIF(btrim(i.transporter_name), '')
FROM   invoices i
WHERE  (NULLIF(btrim(i.vehicle_no), '') IS NOT NULL
     OR NULLIF(btrim(i.challan_no), '') IS NOT NULL
     OR NULLIF(btrim(i.transporter_name), '') IS NOT NULL)
  AND  NOT EXISTS (SELECT 1 FROM invoice_vehicles v WHERE v.invoice_id = i.id);

-- ── 2. Challans tagged on an expense ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_challans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id        uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  challan_no        text NOT NULL,
  transporter_name  text,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_challans_expense ON expense_challans(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_challans_challan ON expense_challans(lower(challan_no));
-- The same challan cannot be tagged twice on ONE expense. It can still sit on
-- several different expenses (advance + balance, freight + detention).
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_challans_once
  ON expense_challans(expense_id, lower(challan_no), lower(coalesce(transporter_name, '')));

-- RLS — follows the parent expense (expenses_select / expenses_write).
ALTER TABLE expense_challans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_challans_select ON expense_challans;
CREATE POLICY expense_challans_select ON expense_challans FOR SELECT USING (
  EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
);
DROP POLICY IF EXISTS expense_challans_write ON expense_challans;
CREATE POLICY expense_challans_write ON expense_challans FOR ALL USING (
  EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
);

-- Make the API see the new tables and their links straight away.
NOTIFY pgrst, 'reload schema';
