-- 040: 'planned' order status + invoices.payment_terms
--
-- 1) orders.status gains 'planned' — an order that's been sketched out but
--    has no document activity yet. The app auto-advances planned/open →
--    in_progress → completed from actual leg activity (see utils/orders.js).
-- 2) invoices.payment_terms — same free-text terms PI/PO already have
--    (026_pi_po_commercial_terms.sql); the app derives due_date from it.

DO $$
DECLARE con text;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'orders'::regclass AND contype = 'c' AND conname LIKE '%status%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', con);
  END IF;
END $$;

ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('planned','open','in_progress','completed','cancelled'));

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_terms text;
