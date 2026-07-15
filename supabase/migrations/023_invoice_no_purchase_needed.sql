-- ============================================================================
-- 023_invoice_no_purchase_needed.sql
--
-- Reconciliation (Intercompany tab) flags every internal sales invoice with
-- no matching purchase invoice as an error ("Purchase side missing"). That's
-- not always wrong: goods can legitimately go out against existing inventory
-- with no separate purchase entry. This flag lets a sales invoice be marked
-- as intentionally not needing a purchase-side match, so it stops showing as
-- an error in Reconciliation.
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN no_purchase_needed boolean NOT NULL DEFAULT false;
