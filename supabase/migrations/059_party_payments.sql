-- ============================================================================
-- 059_party_payments.sql
--
-- The `party_payments` table (payments made to a party from the parties
-- master) was defined in migrations 029 + 031 but was never created on the
-- live database. The Party Payments tab in Expenses, the expense Summary, the
-- Party Ledger report and the TDS/TCS report all read or write it.
--
-- This creates it in one go, with the TDS/TCS columns from 031 included.
-- Amounts are plain rupees numeric(15,2), same as every other money column on
-- the live database (029/031 had them as bigint, from the old paise design).
--
--   * Nothing existing is dropped, renamed or altered.
--   * Idempotent — safe to run again.
-- ============================================================================

CREATE TABLE IF NOT EXISTS party_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid NOT NULL REFERENCES entities,            -- paying entity: drives access + ledger
  party_id          uuid NOT NULL REFERENCES parties,
  expense_id        uuid REFERENCES expenses ON DELETE SET NULL,  -- optional: the expense this payment settles
  financial_year_id uuid REFERENCES financial_years,
  payment_date      date NOT NULL,
  amount            numeric(15,2) NOT NULL,                       -- cash actually paid
  mode              text,                                         -- bank / cash / upi / cheque
  reference         text,                                         -- UTR / cheque no
  notes             text,
  tds_section       text,
  tds_rate          numeric(5,2),
  tds_base_amount   numeric(15,2) DEFAULT 0,
  tds_amount        numeric(15,2) DEFAULT 0,
  tcs_section       text,
  tcs_rate          numeric(5,2),
  tcs_base_amount   numeric(15,2) DEFAULT 0,
  tcs_amount        numeric(15,2) DEFAULT 0,
  is_deleted        boolean NOT NULL DEFAULT false,
  created_at        timestamptz DEFAULT now(),
  created_by        uuid REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_party_payments_party  ON party_payments (party_id, entity_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_party_payments_entity ON party_payments (entity_id, payment_date) WHERE is_deleted = false;

-- Access follows the paying entity, same rule as expenses.
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

-- Make the API see the new table straight away.
NOTIFY pgrst, 'reload schema';
