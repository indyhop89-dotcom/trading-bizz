-- 045: an E-way Bill moves stock even if the invoice is still 'draft'
--
-- Root cause of "I entered the E-way Bill but the stock still isn't
-- showing": Invoices/index.jsx's EWB section is only locked for
-- 'cancelled'/'paid' invoices (see isLocked) — NOT 'draft' — so a user can
-- genuinely save a real E-way Bill number on an invoice that's still sitting
-- in draft (never explicitly "Submitted"). But this function (041, rate
-- logic updated by 044) required BOTH eway_bill_no set AND status NOT IN
-- ('draft','cancelled') to count a line as a movement — so that exact,
-- legitimate case silently produced zero stock movement. The client-side
-- fallback (utils/stock.js's MOVEMENT_STATUSES_EXCLUDED, now just
-- ['cancelled']) and the display helpers that mirrored the same "draft
-- blocks it" logic (getInvoiceLifecycleStage, Orders' getLegStatus,
-- utils/orders.js's invoiceMoved) are fixed in the same commit as this
-- migration — this is the server-side half of that fix.
--
-- A real E-way Bill number is itself proof of physical dispatch (a
-- government-registered document, validated by isValidEwayBill before
-- save) — it is the authoritative movement signal in this app's own design
-- ("the E-way Bill is the actual physical-movement event", see
-- stock.js/Invoices/index.jsx's comments throughout), regardless of whether
-- this app's own internal draft/submitted label was separately updated to
-- match. 'cancelled' is the only status that must still always exclude —
-- that invoice never happened, full stop, even if it once had an EWB.
--
-- CREATE OR REPLACE (not DROP+CREATE) — only the WHERE clause changes here,
-- the function's output columns are identical to migration 044's, so this
-- isn't a signature change.

CREATE OR REPLACE FUNCTION stock_actual_position(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  entity_id          uuid,
  product_id         uuid,
  opening_qty        numeric,
  invoiced_in        numeric,
  invoiced_out       numeric,
  adjustment_qty     numeric,
  actual_qty         numeric,
  last_purchase_rate numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH opening AS (
    SELECT sob.entity_id, sob.product_id, SUM(sob.qty) AS qty
    FROM stock_opening_balance sob
    WHERE p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of
    GROUP BY sob.entity_id, sob.product_id
  ),
  mov AS (
    SELECT il.product_id, i.seller_entity_id, i.buyer_entity_id, il.qty,
           il.rate, COALESCE(i.eway_bill_date, i.invoice_date) AS rate_date
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.is_deleted = false
      -- CHANGED: was `i.status NOT IN ('draft', 'cancelled')` — 'draft' no
      -- longer excludes; eway_bill_no presence is the sole movement trigger.
      AND i.status <> 'cancelled'
      AND i.eway_bill_no IS NOT NULL AND i.eway_bill_no <> ''
      AND NOT (i.invoice_type = 'purchase' AND i.source_invoice_id IS NOT NULL)
      AND (p_as_of IS NULL OR COALESCE(i.eway_bill_date, i.invoice_date) IS NULL
           OR COALESCE(i.eway_bill_date, i.invoice_date) <= p_as_of)
  ),
  inflow AS (
    SELECT m.buyer_entity_id AS entity_id, m.product_id, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.buyer_entity_id, m.product_id
  ),
  outflow AS (
    SELECT m.seller_entity_id AS entity_id, m.product_id, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.seller_entity_id, m.product_id
  ),
  adj AS (
    SELECT sa.entity_id, sa.product_id, SUM(sa.qty_delta) AS qty
    FROM stock_adjustments sa
    WHERE p_as_of IS NULL OR sa.adjustment_date IS NULL OR sa.adjustment_date <= p_as_of
    GROUP BY sa.entity_id, sa.product_id
  ),
  rate_candidates AS (
    SELECT sob.entity_id, sob.product_id, sob.rate, sob.as_of_date AS rate_date, 0 AS src_priority
    FROM stock_opening_balance sob
    WHERE sob.rate IS NOT NULL AND sob.rate <> 0
      AND (p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of)
    UNION ALL
    SELECT m.buyer_entity_id, m.product_id, m.rate, m.rate_date, 1 AS src_priority
    FROM mov m
    WHERE m.rate IS NOT NULL AND m.rate <> 0
  ),
  ranked_rates AS (
    SELECT entity_id, product_id, rate,
           ROW_NUMBER() OVER (
             PARTITION BY entity_id, product_id
             ORDER BY rate_date DESC NULLS LAST, src_priority DESC
           ) AS rn
    FROM rate_candidates
  ),
  keys AS (
    SELECT o.entity_id, o.product_id FROM opening o
    UNION SELECT i.entity_id, i.product_id FROM inflow i
    UNION SELECT ot.entity_id, ot.product_id FROM outflow ot
    UNION SELECT a.entity_id, a.product_id FROM adj a
  )
  SELECT
    k.entity_id,
    k.product_id,
    COALESCE(o.qty, 0)  AS opening_qty,
    COALESCE(i.qty, 0)  AS invoiced_in,
    COALESCE(ot.qty, 0) AS invoiced_out,
    COALESCE(a.qty, 0)  AS adjustment_qty,
    COALESCE(o.qty, 0) + COALESCE(i.qty, 0) - COALESCE(ot.qty, 0) + COALESCE(a.qty, 0) AS actual_qty,
    COALESCE(r.rate, 0) AS last_purchase_rate
  FROM keys k
  LEFT JOIN opening o      ON o.entity_id  = k.entity_id AND o.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN inflow i       ON i.entity_id  = k.entity_id AND i.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN outflow ot     ON ot.entity_id = k.entity_id AND ot.product_id IS NOT DISTINCT FROM k.product_id
  LEFT JOIN adj a          ON a.entity_id  = k.entity_id AND a.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN ranked_rates r ON r.entity_id  = k.entity_id AND r.product_id  IS NOT DISTINCT FROM k.product_id AND r.rn = 1
$$;

GRANT EXECUTE ON FUNCTION stock_actual_position(date) TO authenticated;
