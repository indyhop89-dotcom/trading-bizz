-- ============================================================================
-- 055_entity_payments.sql
--
-- WHY: invoice_payments requires invoice_id (app-level check in
-- InvoicePaymentTracker.handleSave, Payments/index.jsx) and carries
-- invoice-only columns (invoice_no/invoice_date/due_date, TDS/TCS) that don't
-- apply to a standalone bank entry — an advance, a loan, a capital infusion,
-- or a plain transfer between related/associate entities with no invoice
-- behind it. This table is the non-invoice counterpart: same RLS shape as
-- invoice_payments (014_child_and_missing_table_rls.sql), minimal columns,
-- supports both cash directions via `direction`.
--
-- SAFE TO RUN IMMEDIATELY — additive only (new table, new indexes, new RLS
-- policies on a table nothing references yet).
-- ============================================================================

CREATE TABLE IF NOT EXISTS entity_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES entities,   -- acting/owned entity (access-gated side)
  party_entity_id       uuid REFERENCES entities,             -- counterparty, in-system (nullable)
  party_name            text,                                 -- counterparty free-text fallback
  direction             text NOT NULL DEFAULT 'paid'
                        CHECK (direction IN ('paid', 'received')),
  -- 'paid'     = entity_id sent cash out to the counterparty
  -- 'received' = entity_id received cash in from the counterparty
  category              text,                                 -- Advance / Loan / Capital Infusion / Refund / Bank Transfer / Other — UI list, not DB-enforced
  currency              text DEFAULT 'INR',
  exchange_rate         numeric(10,4) DEFAULT 1,
  amount                numeric(15,2) NOT NULL DEFAULT 0,      -- always positive; direction gives the sign
  reference_no          text,                                  -- UTR / cheque no / bank transaction ref
  actual_payment_date   date,
  notes                 text,
  is_deleted            boolean DEFAULT false,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entpay_entity ON entity_payments(entity_id, actual_payment_date) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_entpay_party  ON entity_payments(party_entity_id) WHERE is_deleted = false;

-- RLS — identical shape to invpay_select/invpay_write (014_child_and_missing_table_rls.sql).
-- has_entity_grant() / is_super_admin() are existing functions (035_group_access.sql) — not redefined here.
ALTER TABLE entity_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entpay_select ON entity_payments;
CREATE POLICY entpay_select ON entity_payments FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id) OR has_entity_grant(party_entity_id)
);
DROP POLICY IF EXISTS entpay_write ON entity_payments;
CREATE POLICY entpay_write ON entity_payments FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);
