-- 052: 'offloaded' stock_adjustments no longer reduce actual_qty
--
-- Explicit product-owner decision: 'offloaded' (stock this tool is done
-- tracking — sold/disposed of outside it) was being folded into the same
-- adjustment_qty bucket as every other correction reason (shortfall/damage/
-- found/recount/other), which made it read as though it were confused with
-- real invoice-based "outgoing" movement. Going forward, 'offloaded' rows
-- are tracked (see 051's sibling Adjustments-tab StatCard split) but no
-- longer contribute to actual_qty at all — actual_qty now reflects only
-- opening balance, real invoiced movement, and non-offloaded corrections.
--
-- CREATE OR REPLACE is fine — only the `adj` CTE's filter changes, the
-- function's own signature is untouched.
CREATE OR REPLACE FUNCTION stock_actual_position(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  entity_id          uuid,
  product_name       text,
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
    SELECT DISTINCT ON (sob.entity_id, sob.product_name)
           sob.entity_id, sob.product_name, sob.qty
    FROM stock_opening_balance sob
    WHERE p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of
    ORDER BY sob.entity_id, sob.product_name, sob.as_of_date DESC NULLS LAST, sob.created_at DESC
  ),
  mov AS (
    SELECT il.product_name, i.seller_entity_id, i.buyer_entity_id, il.qty,
           il.rate, COALESCE(i.eway_bill_date, i.invoice_date) AS rate_date
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.is_deleted = false
      AND i.status <> 'cancelled'
      AND i.eway_bill_no IS NOT NULL AND i.eway_bill_no <> ''
      AND NOT (i.invoice_type = 'purchase' AND i.source_invoice_id IS NOT NULL)
      AND (p_as_of IS NULL OR COALESCE(i.eway_bill_date, i.invoice_date) IS NULL
           OR COALESCE(i.eway_bill_date, i.invoice_date) <= p_as_of)
  ),
  inflow AS (
    SELECT m.buyer_entity_id AS entity_id, m.product_name, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.buyer_entity_id, m.product_name
  ),
  outflow AS (
    SELECT m.seller_entity_id AS entity_id, m.product_name, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.seller_entity_id, m.product_name
  ),
  adj AS (
    -- CHANGED: 'offloaded' excluded — it marks stock as out of the system
    -- for reporting purposes, but must not move actual_qty (see header).
    SELECT sa.entity_id, sa.product_name, SUM(sa.qty_delta) AS qty
    FROM stock_adjustments sa
    WHERE sa.reason <> 'offloaded'
      AND (p_as_of IS NULL OR sa.adjustment_date IS NULL OR sa.adjustment_date <= p_as_of)
    GROUP BY sa.entity_id, sa.product_name
  ),
  rate_candidates AS (
    SELECT sob.entity_id, sob.product_name, sob.rate, sob.as_of_date AS rate_date, 0 AS src_priority
    FROM stock_opening_balance sob
    WHERE sob.rate IS NOT NULL AND sob.rate <> 0
      AND (p_as_of IS NULL OR sob.as_of_date IS NULL OR sob.as_of_date <= p_as_of)
    UNION ALL
    SELECT m.buyer_entity_id, m.product_name, m.rate, m.rate_date, 1 AS src_priority
    FROM mov m
    WHERE m.rate IS NOT NULL AND m.rate <> 0
  ),
  ranked_rates AS (
    SELECT entity_id, product_name, rate,
           ROW_NUMBER() OVER (
             PARTITION BY entity_id, product_name
             ORDER BY rate_date DESC NULLS LAST, src_priority DESC
           ) AS rn
    FROM rate_candidates
  ),
  keys AS (
    SELECT o.entity_id, o.product_name FROM opening o
    UNION SELECT i.entity_id, i.product_name FROM inflow i
    UNION SELECT ot.entity_id, ot.product_name FROM outflow ot
    UNION SELECT a.entity_id, a.product_name FROM adj a
  )
  SELECT
    k.entity_id,
    k.product_name,
    COALESCE(o.qty, 0)  AS opening_qty,
    COALESCE(i.qty, 0)  AS invoiced_in,
    COALESCE(ot.qty, 0) AS invoiced_out,
    COALESCE(a.qty, 0)  AS adjustment_qty,
    COALESCE(o.qty, 0) + COALESCE(i.qty, 0) - COALESCE(ot.qty, 0) + COALESCE(a.qty, 0) AS actual_qty,
    COALESCE(r.rate, 0) AS last_purchase_rate
  FROM keys k
  LEFT JOIN opening o      ON o.entity_id  = k.entity_id AND o.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN inflow i       ON i.entity_id  = k.entity_id AND i.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN outflow ot     ON ot.entity_id = k.entity_id AND ot.product_name IS NOT DISTINCT FROM k.product_name
  LEFT JOIN adj a          ON a.entity_id  = k.entity_id AND a.product_name  IS NOT DISTINCT FROM k.product_name
  LEFT JOIN ranked_rates r ON r.entity_id  = k.entity_id AND r.product_name  IS NOT DISTINCT FROM k.product_name AND r.rn = 1
$$;

GRANT EXECUTE ON FUNCTION stock_actual_position(date) TO authenticated;
