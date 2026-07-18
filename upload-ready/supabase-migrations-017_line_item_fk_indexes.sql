-- ============================================================================
-- 017_line_item_fk_indexes.sql
--
-- Postgres does not auto-index foreign key columns (only primary keys).
-- proforma_invoice_lines.pi_id, purchase_order_lines.po_id, and
-- invoice_lines.invoice_id are filtered on every single read of a PI/PO/
-- invoice's lines (both directly in app queries and inside each table's RLS
-- policy, which re-checks the parent row via an EXISTS subquery keyed on
-- these same columns) — cheap and safe to add, no data changes.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_pi_lines_pi_id      ON proforma_invoice_lines(pi_id);
CREATE INDEX IF NOT EXISTS idx_po_lines_po_id       ON purchase_order_lines(po_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice_id ON invoice_lines(invoice_id);
