-- ============================================================================
-- 050_expense_rcm.sql
--
-- Reverse Charge Mechanism (RCM) GST — for vendors (e.g. GTAs/transporters
-- like Saket Roadways) who invoice with NO GST because the recipient must
-- self-assess it instead. Under RCM the vendor is paid amount only (no GST
-- ever reaches them); the recipient separately owes that GST to the
-- government as an output-tax liability, pays it in cash (RCM liability
-- cannot be offset against available ITC), and only afterwards claims it
-- back as ITC in a later return.
--
-- 1. parties.rcm_applicable — marks a vendor as RCM by default, so picking
--    them on an expense auto-suggests RCM the same way party_id already
--    auto-fills vendor_gstin/due_date (migration 028/029).
--
-- 2. expenses gets the RCM register fields: whether this expense is RCM, the
--    self-assessed rate/amount (kept separate from gst_rate/gst_amount,
--    which stay 0 for an RCM expense since the vendor charges nothing), and
--    two lifecycle events — paid to govt (via GSTR-3B cash ledger, a manual
--    real-world action the app just records) and ITC claimed back. No
--    CGST/SGST/IGST split: expense GST has never split for regular vendor
--    GST either, and RCM vendors are frequently unregistered, so there's no
--    reliable GSTIN pair to derive interstate from — a flat amount is kept.
--
-- Idempotent so a re-run (or partial earlier apply) is a safe no-op.
-- ============================================================================

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS rcm_applicable boolean NOT NULL DEFAULT false;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS is_rcm               boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rcm_gst_rate         numeric(5,2),
  ADD COLUMN IF NOT EXISTS rcm_gst_amount       numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rcm_paid_date        date,     -- paid to govt via GSTR-3B cash ledger
  ADD COLUMN IF NOT EXISTS rcm_paid_ref         text,     -- challan / GSTR-3B ARN, optional
  ADD COLUMN IF NOT EXISTS rcm_itc_claimed_date date,     -- ITC claimed back
  ADD COLUMN IF NOT EXISTS rcm_itc_claim_ref    text;     -- GSTR-3B period claimed in, optional

CREATE INDEX IF NOT EXISTS idx_expenses_rcm ON expenses (entity_id, expense_date)
  WHERE is_rcm = true AND is_deleted = false;
