-- ============================================================================
-- 018_total_qty_columns.sql
--
-- Adds total_qty (sum of line item qty) to proforma_invoices, purchase_orders,
-- and invoices — mirrors the existing total_amount column, which is computed
-- client-side from line items and stored on the parent row at save time.
-- Backfilled from each table's line items so existing records aren't blank.
-- ============================================================================

ALTER TABLE proforma_invoices ADD COLUMN IF NOT EXISTS total_qty numeric(15,3) DEFAULT 0;
ALTER TABLE purchase_orders   ADD COLUMN IF NOT EXISTS total_qty numeric(15,3) DEFAULT 0;
ALTER TABLE invoices          ADD COLUMN IF NOT EXISTS total_qty numeric(15,3) DEFAULT 0;

UPDATE proforma_invoices pi SET total_qty = COALESCE((
  SELECT SUM(l.qty) FROM proforma_invoice_lines l WHERE l.pi_id = pi.id
), 0);

UPDATE purchase_orders po SET total_qty = COALESCE((
  SELECT SUM(l.qty) FROM purchase_order_lines l WHERE l.po_id = po.id
), 0);

UPDATE invoices inv SET total_qty = COALESCE((
  SELECT SUM(l.qty) FROM invoice_lines l WHERE l.invoice_id = inv.id
), 0);
