-- ============================================================================
-- 031_party_payment_tds_tcs.sql
--
-- TDS/TCS on expenses moves from booking-time (the New Expense form) to
-- payment-time (party_payments) — the same correction already made for
-- invoices in migration 030. Withholding happens when money actually changes
-- hands, not when a cost is first recorded. expenses.tds_*/tcs_*/net_payable
-- (029) are left in place but no longer written to by the UI going forward —
-- same legacy treatment given to tds_tcs_entries after invoices moved.
--
-- Mirrors invoice_payments' existing tds_section/tds_rate/tds_base_amount/
-- tds_amount (+ the tcs_* equivalents added in 030) so both settlement paths
-- carry withholding the same way.
--
-- Idempotent so a re-run (or partial earlier apply) is a safe no-op.
-- ============================================================================

ALTER TABLE party_payments
  ADD COLUMN IF NOT EXISTS tds_section     text,
  ADD COLUMN IF NOT EXISTS tds_rate        numeric(5,2),
  ADD COLUMN IF NOT EXISTS tds_base_amount bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tds_amount      bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcs_section     text,
  ADD COLUMN IF NOT EXISTS tcs_rate        numeric(5,2),
  ADD COLUMN IF NOT EXISTS tcs_base_amount bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tcs_amount      bigint DEFAULT 0;
