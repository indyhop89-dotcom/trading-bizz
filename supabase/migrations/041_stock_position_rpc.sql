-- 041: server-side stock aggregation
--
-- The app used to compute Actual Stock by downloading EVERY invoice line
-- (30k+ rows, paged 1000 at a time), every opening-balance row and every
-- adjustment to the browser and summing them in JS — ~60s per load on a slow
-- link. This function does the identical aggregation in Postgres and returns
-- one row per entity+product (~thousands of rows instead of tens of
-- thousands, and one round trip instead of ~35).
--
-- The rules MUST stay in lockstep with src/utils/stock.js
-- (fetchStockMovementData / buildActualStockMap / buildStockValuationMap /
-- filterStockDataAsOf), which remains as the client-side fallback until this
-- migration is applied:
--   * invoice lines count only when the invoice is not deleted, not
--     draft/cancelled, and has an E-way Bill number (dispatch = movement);
--   * auto-created purchase mirrors (invoice_type='purchase' with
--     source_invoice_id) are the same physical movement as their source
--     sales invoice — excluded to avoid double-counting;
--   * p_as_of (NULL = live) keeps only movements dated on or before that
--     day: opening by as_of_date, invoices by E-way Bill date falling back
--     to invoice_date, adjustments by adjustment_date; undated rows are
--     kept (they cannot be placed in time — dropping them would understate);
--   * avg_in_rate = (opening value + purchased-in value) / (opening qty +
--     purchased-in qty) — the average carrying cost basis used for the
--     stock margin view.
--
-- SECURITY INVOKER (the default) so RLS on the underlying tables applies to
-- the calling user exactly as it does for the direct queries it replaces.

CREATE OR REPLACE FUNCTION stock_actual_position(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  entity_id      uuid,
  product_id     uuid,
  opening_qty    numeric,
  invoiced_in    numeric,
  invoiced_out   numeric,
  adjustment_qty numeric,
  actual_qty     numeric,
  avg_in_rate    numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH opening AS (
    SELECT sob.entity_id, sob.product_id,
           SUM(sob.qty)                        AS qty,
           SUM(sob.qty * COALESCE(sob.rate, 0)) AS val
    FROM stock_opening_balance sob
    WHERE p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of
    GROUP BY sob.entity_id, sob.product_id
  ),
  mov AS (
    SELECT il.product_id, i.seller_entity_id, i.buyer_entity_id,
           il.qty, COALESCE(il.rate, 0) AS rate
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.is_deleted = false
      AND i.status NOT IN ('draft', 'cancelled')
      AND i.eway_bill_no IS NOT NULL AND i.eway_bill_no <> ''
      AND NOT (i.invoice_type = 'purchase' AND i.source_invoice_id IS NOT NULL)
      AND (p_as_of IS NULL OR COALESCE(i.eway_bill_date, i.invoice_date) IS NULL
           OR COALESCE(i.eway_bill_date, i.invoice_date) <= p_as_of)
  ),
  inflow AS (
    SELECT m.buyer_entity_id AS entity_id, m.product_id,
           SUM(m.qty) AS qty, SUM(m.qty * m.rate) AS val
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
    CASE WHEN COALESCE(o.qty, 0) + COALESCE(i.qty, 0) > 0
         THEN (COALESCE(o.val, 0) + COALESCE(i.val, 0)) / (COALESCE(o.qty, 0) + COALESCE(i.qty, 0))
         ELSE 0 END AS avg_in_rate
  FROM keys k
  LEFT JOIN opening o  ON o.entity_id  = k.entity_id AND o.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN inflow i   ON i.entity_id  = k.entity_id AND i.product_id  IS NOT DISTINCT FROM k.product_id
  LEFT JOIN outflow ot ON ot.entity_id = k.entity_id AND ot.product_id IS NOT DISTINCT FROM k.product_id
  LEFT JOIN adj a      ON a.entity_id  = k.entity_id AND a.product_id  IS NOT DISTINCT FROM k.product_id
$$;

GRANT EXECUTE ON FUNCTION stock_actual_position(date) TO authenticated;
