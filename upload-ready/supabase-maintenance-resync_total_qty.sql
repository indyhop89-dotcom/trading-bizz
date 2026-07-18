-- ============================================================================
-- resync_total_qty.sql
--
-- total_qty (added in migration 018) can go stale on any PI/PO/Invoice whose
-- lines were changed by something other than the normal save flow — e.g. the
-- dedupe_line_items.sql maintenance script, run before it learned about this
-- column. Safe to re-run anytime; recomputes total_qty from current lines.
-- ============================================================================

UPDATE proforma_invoices pi SET total_qty = COALESCE((
  SELECT SUM(l.qty) FROM proforma_invoice_lines l WHERE l.pi_id = pi.id
), 0);

UPDATE purchase_orders po SET total_qty = COALESCE((
  SELECT SUM(l.qty) FROM purchase_order_lines l WHERE l.po_id = po.id
), 0);

UPDATE invoices inv SET total_qty = COALESCE((
  SELECT SUM(l.qty) FROM invoice_lines l WHERE l.invoice_id = inv.id
), 0);
