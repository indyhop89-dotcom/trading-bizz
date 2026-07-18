-- ============================================================================
-- 013_missing_payment_bank_tables.sql
--
-- SAFE TO RUN IMMEDIATELY — additive only (CREATE TABLE IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION, DROP NOT NULL guarded by information_schema
-- checks). Nothing here deletes a column, drops a table, or changes what any
-- existing user can currently see. RLS lockdown for these tables lives in
-- 014_child_and_missing_table_rls.sql, same split as 011/012.
--
-- WHY THIS MIGRATION EXISTS
-- The app's code queries `banks`, `invoice_payments`, `expense_payments`,
-- `bill_discounting_events`, `bill_discounting_invoices` (with an event_id
-- FK) and `bill_discounting_repayments` (with an event_id FK) — none of
-- which match anything in 001/002. Migration 002 created a `bill_discounting`
-- table (bank_name as free text, discount_id FK on its children) that the
-- app has never queried by that name. Given the app works in production,
-- the working tables were almost certainly created directly against the
-- live database out-of-band at some point and never captured in a migration
-- file — the same kind of drift already found and fixed for
-- financial_year_id on proforma_invoices/purchase_orders/invoices (see
-- commits f86b828 / b8c64e2). This migration writes migrations that match
-- what the code actually reads/writes today, so a *fresh* database (or a
-- read replica / staging clone) ends up matching production instead of
-- matching a schema nothing has used in months.
--
-- The old, unused `bill_discounting` / `bill_discounting_invoices` (discount_id)
-- / `bill_discounting_repayments` (discount_id) tables from 002 are left
-- alone — dropping tables is destructive and out of scope here. If you
-- confirm (SELECT count(*) FROM bill_discounting) they're empty, you can
-- drop them later as manual cleanup.
-- ============================================================================

-- ── banks — master data for bill-discounting financiers ────────────────────
CREATE TABLE IF NOT EXISTS banks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  short_name            text,
  bank_branch           text,
  account_no            text,
  ifsc_code             text,
  contact_name          text,
  contact_email         text,
  contact_phone         text,
  sanctioned_limit      numeric(15,2) DEFAULT 0,
  base_rate             numeric(5,2),
  spread                numeric(5,2),
  processing_fee_pct    numeric(5,2),
  processing_fee_flat   numeric(15,2),
  recourse_type         text DEFAULT 'with_recourse'
                        CHECK (recourse_type IN ('with_recourse','without_recourse')),
  grace_period_days     integer DEFAULT 0,
  is_active             boolean DEFAULT true,
  notes                 text,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ── bill_discounting_events — replaces the never-queried `bill_discounting` ─
CREATE TABLE IF NOT EXISTS bill_discounting_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid REFERENCES entities NOT NULL,
  bank_id             uuid REFERENCES banks,
  bank_name           text,
  invoice_id          uuid REFERENCES invoices,
  discount_no         text,
  financial_year_id   uuid REFERENCES financial_years,
  invoice_amount      numeric(15,2) NOT NULL DEFAULT 0,
  discount_amount     numeric(15,2) DEFAULT 0,
  discount_rate       numeric(5,2),
  applied_rate        numeric(5,2),
  net_proceeds        numeric(15,2) NOT NULL DEFAULT 0,
  outstanding_amount  numeric(15,2) DEFAULT 0,
  processing_fee      numeric(15,2) DEFAULT 0,
  reserve_amount      numeric(15,2) DEFAULT 0,
  discounting_date    date NOT NULL,
  maturity_date       date NOT NULL,
  tenure_days         integer,
  financier_ref_no    text,
  repaid_amount       numeric(15,2) DEFAULT 0,
  status              text DEFAULT 'active'
                      CHECK (status IN ('active','partially_repaid','repaid','overdue','recourse')),
  notes               text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles,
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bill_discounting_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid REFERENCES bill_discounting_events ON DELETE CASCADE NOT NULL,
  invoice_id      uuid REFERENCES invoices NOT NULL,
  invoice_amount  numeric(15,2) NOT NULL DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bill_discounting_repayments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid REFERENCES bill_discounting_events ON DELETE CASCADE NOT NULL,
  repayment_date  date NOT NULL,
  amount          numeric(15,2) NOT NULL DEFAULT 0,
  interest_amount numeric(15,2) DEFAULT 0,
  total_payment   numeric(15,2) DEFAULT 0,
  payment_mode    text DEFAULT 'bank_transfer',
  reference_no    text,
  notes           text,
  is_deleted      boolean DEFAULT false,
  created_at      timestamptz DEFAULT now(),
  created_by      uuid REFERENCES profiles
);

-- bd_sequence / next_bd_no() were already defined in 002 against the old
-- `bill_discounting` table's naming scheme, but the function itself doesn't
-- reference the table — CREATE OR REPLACE here is a safe no-op if it already
-- works, and creates it if 002 was never actually run against this database.
CREATE TABLE IF NOT EXISTS bd_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  last_sequence     integer DEFAULT 0,
  UNIQUE(entity_id, financial_year_id)
);

CREATE OR REPLACE FUNCTION next_bd_no(ent_id uuid, fy_id uuid)
RETURNS text AS $$
DECLARE
  fy_code text;
  seq     integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  INSERT INTO bd_sequence (entity_id, financial_year_id, last_sequence)
  VALUES (ent_id, fy_id, 1)
  ON CONFLICT (entity_id, financial_year_id)
  DO UPDATE SET last_sequence = bd_sequence.last_sequence + 1
  RETURNING last_sequence INTO seq;
  RETURN 'BD-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── invoice_payments — one row per payment tranche against an invoice ──────
CREATE TABLE IF NOT EXISTS invoice_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            uuid REFERENCES invoices,
  entity_id             uuid REFERENCES entities,
  party_entity_id       uuid REFERENCES entities,
  party_name            text,
  invoice_no            text,
  invoice_date          date,
  due_date              date,
  currency              text DEFAULT 'INR',
  exchange_rate         numeric(10,4) DEFAULT 1,
  amount                numeric(15,2) NOT NULL DEFAULT 0,
  tds_section           text,
  tds_rate              numeric(5,2) DEFAULT 0,
  tds_base_amount       numeric(15,2) DEFAULT 0,
  tds_amount            numeric(15,2) DEFAULT 0,
  adjustments           numeric(15,2) DEFAULT 0,
  adjustment_notes      text,
  actual_payment_date   date,
  notes                 text,
  is_deleted            boolean DEFAULT false,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ── expense_payments — payment tracker for expenses (distinct from `expenses`
--    itself, which is the accrual/expense-booking record) ──────────────────
CREATE TABLE IF NOT EXISTS expense_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_category      text,
  expense_type          text DEFAULT 'Direct',
  expense_tag           text,
  from_entity_id        uuid REFERENCES entities,
  from_name             text,
  to_entity_id          uuid REFERENCES entities,
  to_name               text,
  location              text,
  qty                   numeric(15,3),
  proforma_ref          text,
  linked_invoice_id     uuid REFERENCES invoices,
  linked_pi_id          uuid REFERENCES proforma_invoices,
  invoice_no            text,
  invoice_date          date,
  currency              text DEFAULT 'INR',
  amount                numeric(15,2) NOT NULL DEFAULT 0,
  advance_amount        numeric(15,2) DEFAULT 0,
  advance_date          date,
  adjustments           numeric(15,2) DEFAULT 0,
  adjustment_notes      text,
  due_date              date,
  actual_payment_date   date,
  manual_status         text,
  usd_rate              numeric(10,4),
  notes                 text,
  is_deleted            boolean DEFAULT false,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bde_entity      ON bill_discounting_events(entity_id, maturity_date) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_bde_bank        ON bill_discounting_events(bank_id);
CREATE INDEX IF NOT EXISTS idx_bdi_event       ON bill_discounting_invoices(event_id);
CREATE INDEX IF NOT EXISTS idx_bdr_event       ON bill_discounting_repayments(event_id);
CREATE INDEX IF NOT EXISTS idx_invpay_invoice  ON invoice_payments(invoice_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_invpay_entity   ON invoice_payments(entity_id, due_date) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_exppay_from     ON expense_payments(from_entity_id, due_date) WHERE is_deleted = false;

-- RLS disabled for now on the newly-created tables — enabled in
-- 014_child_and_missing_table_rls.sql once you've confirmed the app still
-- works against them (same two-step pattern as 011/012).
ALTER TABLE banks                       DISABLE ROW LEVEL SECURITY;
ALTER TABLE bill_discounting_events     DISABLE ROW LEVEL SECURITY;
ALTER TABLE bill_discounting_invoices   DISABLE ROW LEVEL SECURITY;
ALTER TABLE bill_discounting_repayments DISABLE ROW LEVEL SECURITY;
ALTER TABLE bd_sequence                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments            DISABLE ROW LEVEL SECURITY;
ALTER TABLE expense_payments            DISABLE ROW LEVEL SECURITY;

-- ============================================================================
-- financial_year_id drift — relax, don't drop.
--
-- proforma_invoices/purchase_orders/invoices were already confirmed missing
-- this column entirely on the live DB (commits f86b828, b8c64e2 — the app
-- stopped sending it because inserts were failing). payments and
-- credit_debit_notes show the identical symptom in the current code (the
-- column is never sent on insert) but that hasn't been independently
-- confirmed against the live schema the way the first three were.
--
-- Rather than guess and DROP COLUMN (irreversible, and wrong if the column
-- turns out to still be populated/used by a report), this only relaxes the
-- NOT NULL constraint — guarded so it's a no-op wherever the column has
-- already been removed, and harmless wherever it still exists. This alone
-- is enough to stop insert failures if any of these tables still have the
-- old NOT NULL constraint live.
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['proforma_invoices','purchase_orders','invoices','payments','credit_debit_notes']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'financial_year_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN financial_year_id DROP NOT NULL', t);
    END IF;
  END LOOP;
END $$;
