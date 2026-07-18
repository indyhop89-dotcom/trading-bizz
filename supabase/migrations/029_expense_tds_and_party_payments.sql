-- ============================================================================
-- 029_expense_tds_and_party_payments.sql
--
-- Two related additions for paying parties (transport/freight/brokerage etc.):
--
-- 1. Expense TDS/TCS. Payments to parties attract TDS (e.g. §194C on freight,
--    §194H on brokerage) which the payer must withhold — so the amount actually
--    payable to the party is total_amount − TDS (+ any TCS the vendor collects).
--    These columns store the withholding and the resulting net_payable so the
--    Expenses UI and the party ledger can show what is genuinely owed.
--
-- 2. party_payments — settlements actually paid to a party, entity-scoped, so a
--    per-party ledger (expenses = we owe, payments = we paid) has a real credit
--    side. Distinct from the legacy expense_payments tracker on the Payments
--    page; this one is tied to the global parties master (migration 028).
--
-- Idempotent so a re-run (or partial earlier apply) is a safe no-op.
-- ============================================================================

-- ── 1. Expense TDS/TCS + net payable ────────────────────────────────────────
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS tds_section  text,
  ADD COLUMN IF NOT EXISTS tds_rate     numeric(5,2),
  ADD COLUMN IF NOT EXISTS tds_amount   bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcs_section  text,
  ADD COLUMN IF NOT EXISTS tcs_rate     numeric(5,2),
  ADD COLUMN IF NOT EXISTS tcs_amount   bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_payable  bigint;   -- total_amount − tds_amount + tcs_amount

-- ── 2. party_payments — settlements paid to a party ─────────────────────────
CREATE TABLE IF NOT EXISTS party_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,          -- paying entity: drives RLS + ledger
  party_id          uuid REFERENCES parties  NOT NULL,
  expense_id        uuid REFERENCES expenses ON DELETE SET NULL, -- optional targeted settlement
  financial_year_id uuid REFERENCES financial_years,
  payment_date      date   NOT NULL,
  amount            bigint NOT NULL,
  mode              text,                                        -- bank / cash / upi / cheque
  reference         text,                                        -- UTR / cheque no
  notes             text,
  is_deleted        boolean NOT NULL DEFAULT false,
  created_at        timestamptz DEFAULT now(),
  created_by        uuid REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_party_payments_party  ON party_payments (party_id, entity_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_party_payments_entity ON party_payments (entity_id, payment_date) WHERE is_deleted = false;

-- Entity-scoped, mirroring expenses_select/expenses_write.
ALTER TABLE party_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS party_payments_select ON party_payments;
CREATE POLICY party_payments_select ON party_payments FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id)
);

DROP POLICY IF EXISTS party_payments_write ON party_payments;
CREATE POLICY party_payments_write ON party_payments FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);
