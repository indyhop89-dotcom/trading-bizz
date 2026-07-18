-- ============================================================================
-- 019_round_off_amount.sql
--
-- GST invoicing rounds off the FINAL invoice value to the nearest whole
-- rupee (CGST Rule 46) — never per line, only once at the header level.
-- taxable_amount/cgst/sgst/igst stay at full 2dp precision (see 018 and the
-- app-side rounding fix); total_amount now holds that final, rounded whole-
-- rupee value, and round_off_amount records the adjustment applied so the
-- precise subtotal (taxable+cgst+sgst+igst) can always be reconstructed as
-- total_amount - round_off_amount.
-- ============================================================================

ALTER TABLE proforma_invoices ADD COLUMN IF NOT EXISTS round_off_amount numeric(15,2) DEFAULT 0;
ALTER TABLE purchase_orders   ADD COLUMN IF NOT EXISTS round_off_amount numeric(15,2) DEFAULT 0;
ALTER TABLE invoices          ADD COLUMN IF NOT EXISTS round_off_amount numeric(15,2) DEFAULT 0;

-- Backfill: round total_amount to the nearest whole rupee and record the
-- adjustment. Run recompute_precise_totals.sql BEFORE this so total_amount
-- already reflects the true 2dp subtotal — otherwise this just rounds
-- whatever (possibly still-inflated) total_amount is currently stored.
UPDATE proforma_invoices SET
  round_off_amount = ROUND(total_amount) - total_amount,
  total_amount = ROUND(total_amount);

UPDATE purchase_orders SET
  round_off_amount = ROUND(total_amount) - total_amount,
  total_amount = ROUND(total_amount);

UPDATE invoices SET
  round_off_amount = ROUND(total_amount) - total_amount,
  total_amount = ROUND(total_amount),
  outstanding_amount = GREATEST(0, ROUND(total_amount) - COALESCE(paid_amount, 0));
