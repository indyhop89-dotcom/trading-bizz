-- ============================================================================
-- 064_tds_register_journal_multi_payments.sql
--
-- 1. tds_tcs_entries becomes the per-invoice TDS/TCS register
--    - money columns paise bigint -> rupees numeric(15,2) (table is empty)
--    - adds entry_date, notes, soft delete, audit, source_payment_id
--    - write access widened to buyer OR seller (purchase-side TDS)
--    - one live TDS and one live TCS entry per invoice
-- 2. Backfill: the 20 invoice_payments rows carrying TDS are copied into the
--    register, one entry per invoice. invoice_payments rows are NOT changed.
-- 3. invoice_payments gets payment_group_id + payment_ref so one payment can
--    cover several invoices.
-- 4. New table invoice_setoffs: journal knock-off of a sales invoice against a
--    purchase invoice with the same counterparty (standalone, or made inside a
--    payment via payment_group_id).
--
--   * Nothing existing is dropped or deleted. Idempotent: safe to run again.
-- ============================================================================

-- ── 1. TDS/TCS register ─────────────────────────────────────────────────────
ALTER TABLE tds_tcs_entries
  ALTER COLUMN base_amount TYPE numeric(15,2) USING base_amount::numeric,
  ALTER COLUMN amount      TYPE numeric(15,2) USING amount::numeric,
  ALTER COLUMN rate        TYPE numeric(6,3);   -- 194Q is 0.1%; keeps 3 decimals

ALTER TABLE tds_tcs_entries
  ADD COLUMN IF NOT EXISTS entry_date        date,
  ADD COLUMN IF NOT EXISTS notes             text,
  ADD COLUMN IF NOT EXISTS source_payment_id uuid REFERENCES invoice_payments ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_deleted        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by        uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz DEFAULT now();

DO $$ BEGIN
  ALTER TABLE tds_tcs_entries
    ADD CONSTRAINT tds_tcs_entry_type_chk CHECK (entry_type IN ('tds','tcs'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tds_tcs_invoice_type
  ON tds_tcs_entries (invoice_id, entry_type) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_tds_tcs_deductor
  ON tds_tcs_entries (deducted_by_entity_id, entry_date) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_tds_tcs_deductee
  ON tds_tcs_entries (deductee_entity_id, entry_date) WHERE is_deleted = false;

-- Write: either side of the invoice (was seller only).
DROP POLICY IF EXISTS tds_tcs_write ON tds_tcs_entries;
CREATE POLICY tds_tcs_write ON tds_tcs_entries FOR ALL USING (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (
    is_super_admin() OR has_entity_grant(i.seller_entity_id) OR has_entity_grant(i.buyer_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (
    is_super_admin() OR has_entity_grant(i.seller_entity_id) OR has_entity_grant(i.buyer_entity_id)))
);

-- ── 2. Backfill TDS from payment rows (one entry per invoice) ───────────────
-- Payer (invoice buyer) deducts; seller is the deductee.
-- Section/rate taken from the latest payment row for that invoice.
INSERT INTO tds_tcs_entries
  (invoice_id, entry_type, section_code, deducted_by_entity_id, deductee_entity_id,
   base_amount, rate, amount, entry_date, source_payment_id, notes)
SELECT
  i.id, 'tds',
  COALESCE(last.tds_section, '194Q'),
  i.buyer_entity_id, i.seller_entity_id,
  agg.base, COALESCE(last.tds_rate, 0), agg.tds,
  last.actual_payment_date, last.id,
  'Copied from payment record(s) during migration 064'
FROM (
  SELECT invoice_id,
         SUM(COALESCE(tds_base_amount, 0)) AS base,
         SUM(tds_amount)                   AS tds
  FROM invoice_payments
  WHERE COALESCE(is_deleted, false) = false AND COALESCE(tds_amount, 0) <> 0
    AND invoice_id IS NOT NULL
  GROUP BY invoice_id
) agg
JOIN invoices i ON i.id = agg.invoice_id
JOIN LATERAL (
  SELECT id, tds_section, tds_rate, actual_payment_date
  FROM invoice_payments p
  WHERE p.invoice_id = agg.invoice_id AND COALESCE(p.is_deleted, false) = false
    AND COALESCE(p.tds_amount, 0) <> 0
  ORDER BY p.actual_payment_date DESC NULLS LAST, p.created_at DESC
  LIMIT 1
) last ON true
WHERE NOT EXISTS (
  SELECT 1 FROM tds_tcs_entries t
  WHERE t.invoice_id = agg.invoice_id AND t.entry_type = 'tds' AND t.is_deleted = false
);

-- ── 3. Multi-invoice payments ───────────────────────────────────────────────
ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS payment_group_id uuid,
  ADD COLUMN IF NOT EXISTS payment_ref      text;   -- UTR / cheque no, shared by the group

CREATE INDEX IF NOT EXISTS idx_invpay_group
  ON invoice_payments (payment_group_id) WHERE payment_group_id IS NOT NULL;

-- ── 4. Journal set-offs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_setoffs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_no          text NOT NULL,
  journal_date        date NOT NULL,
  entity_id           uuid NOT NULL REFERENCES entities,   -- our side
  party_entity_id     uuid NOT NULL REFERENCES entities,   -- counterparty
  sales_invoice_id    uuid NOT NULL REFERENCES invoices,   -- seller = entity, buyer = party
  purchase_invoice_id uuid NOT NULL REFERENCES invoices,   -- seller = party, buyer = entity
  amount              numeric(15,2) NOT NULL CHECK (amount > 0),
  payment_group_id    uuid,                                -- set when knocked off inside a payment
  notes               text,
  is_deleted          boolean NOT NULL DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles(id),
  updated_at          timestamptz DEFAULT now(),
  CHECK (entity_id <> party_entity_id),
  CHECK (sales_invoice_id <> purchase_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_setoff_sales    ON invoice_setoffs (sales_invoice_id)    WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_setoff_purchase ON invoice_setoffs (purchase_invoice_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_setoff_entity   ON invoice_setoffs (entity_id, party_entity_id, journal_date) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_setoff_group    ON invoice_setoffs (payment_group_id) WHERE payment_group_id IS NOT NULL;

-- Both invoices must belong to the entity/party pair, in the right direction.
CREATE OR REPLACE FUNCTION check_invoice_setoff() RETURNS trigger AS $$
DECLARE s invoices%ROWTYPE; p invoices%ROWTYPE;
BEGIN
  SELECT * INTO s FROM invoices WHERE id = NEW.sales_invoice_id;
  SELECT * INTO p FROM invoices WHERE id = NEW.purchase_invoice_id;
  IF s.seller_entity_id <> NEW.entity_id OR s.buyer_entity_id <> NEW.party_entity_id THEN
    RAISE EXCEPTION 'Sales invoice % is not from this entity to this party', s.invoice_no;
  END IF;
  IF p.seller_entity_id <> NEW.party_entity_id OR p.buyer_entity_id <> NEW.entity_id THEN
    RAISE EXCEPTION 'Purchase invoice % is not from this party to this entity', p.invoice_no;
  END IF;
  IF s.status IN ('draft','cancelled') OR p.status IN ('draft','cancelled') THEN
    RAISE EXCEPTION 'Draft or cancelled invoices cannot be set off';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_invoice_setoff ON invoice_setoffs;
CREATE TRIGGER trg_check_invoice_setoff
  BEFORE INSERT OR UPDATE ON invoice_setoffs
  FOR EACH ROW EXECUTE FUNCTION check_invoice_setoff();

ALTER TABLE invoice_setoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setoff_select ON invoice_setoffs;
CREATE POLICY setoff_select ON invoice_setoffs FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id) OR has_entity_grant(party_entity_id)
);
DROP POLICY IF EXISTS setoff_write ON invoice_setoffs;
CREATE POLICY setoff_write ON invoice_setoffs FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

NOTIFY pgrst, 'reload schema';
