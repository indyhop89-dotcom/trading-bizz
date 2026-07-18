-- ============================================================================
-- 030_invoice_tcs_and_cdn_tds.sql
--
-- Consolidates TDS/TCS recognition to payment time for invoices (replacing
-- the old invoice-creation-time manual entry into tds_tcs_entries, which is
-- now legacy/read-only), and extends it to credit/debit notes.
--
-- 1. invoice_payments already carries tds_section/tds_rate/tds_base_amount/
--    tds_amount (013_missing_payment_bank_tables.sql) but had no TCS
--    equivalent — §206C (TCS on sale of goods) was being miscategorised as a
--    "TDS section" in the app. This adds matching tcs_* columns so TCS can be
--    captured at the same point, the same way, without conflating the two.
--
-- 2. credit_debit_notes gets its own tds_amount/tcs_amount (+ the rate that
--    produced them) so a correction against an invoice that had TDS/TCS
--    applied on payment carries a proportional adjustment. These are always
--    app-computed (derived from the linked invoice's payment history), never
--    hand-entered — no separate manual-entry UI is added for them.
--
-- Idempotent so a re-run (or partial earlier apply) is a safe no-op.
-- ============================================================================

ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS tcs_section     text,
  ADD COLUMN IF NOT EXISTS tcs_rate        numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcs_base_amount numeric(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcs_amount      numeric(15,2) DEFAULT 0;

ALTER TABLE credit_debit_notes
  ADD COLUMN IF NOT EXISTS tds_rate   numeric(5,2),
  ADD COLUMN IF NOT EXISTS tds_amount bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcs_rate   numeric(5,2),
  ADD COLUMN IF NOT EXISTS tcs_amount bigint DEFAULT 0;
