-- ============================================================================
-- 062_external_challans.sql
--
-- "External" challans: transport that someone else paid for (the supplier or
-- another party), so no freight expense will ever be booked for it in this
-- ERP. Until now these were typed in as challan "Others".
--
-- A vehicle row on an invoice can be marked External, with an optional note
-- and a record of who marked it and when. External challans drop out of the
-- pending (uninvoiced) list and out of the challan list on a freight expense,
-- but stay visible under the External filter and can be changed back.
--
--   * Adds columns only. Existing rows default to "not external", so every
--     challan-to-invoice link and every existing "Others" entry is untouched.
--   * Idempotent — safe to run again.
-- ============================================================================

ALTER TABLE invoice_vehicles
  ADD COLUMN IF NOT EXISTS is_external        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_note      text,
  ADD COLUMN IF NOT EXISTS external_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_marked_by uuid REFERENCES profiles(id);

NOTIFY pgrst, 'reload schema';
