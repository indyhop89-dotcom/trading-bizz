-- 048: server-side aggregation for "Planned" (PI-based) stock position —
-- same fix migration 041 already applied to Actual Stock, now applied to
-- the other half of the Stock Position page.
--
-- Root cause: Stock Position's loadPosition() (src/pages/Stock/index.jsx)
-- pages through the ENTIRE proforma_invoice_lines table on every single
-- load, with no entity filter and no server-side aggregation, just to sum
-- incoming/outgoing PI quantities per entity+product in the browser — same
-- expensive pattern Actual Stock used to use before migration 041, except
-- nothing ever added the equivalent fix for Planned. On a real dataset
-- (13,000+ proforma_invoice_lines rows here) that's 13-14 sequential
-- paginated requests, several seconds each, on every page open — the
-- dominant cause of "Stock page takes forever".
--
-- Fix: aggregate incoming/outgoing PI quantities per entity+product in
-- Postgres, one round trip, mirroring stock_actual_position exactly.
CREATE FUNCTION stock_planned_position(p_as_of date DEFAULT NULL)
RETURNS TABLE (
  entity_id    uuid,
  product_name text,
  incoming     numeric,
  outgoing     numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH mov AS (
    SELECT pil.product_name, pi.from_entity_id, pi.to_entity_id, pil.qty
    FROM proforma_invoice_lines pil
    JOIN proforma_invoices pi ON pi.id = pil.pi_id
    WHERE pi.is_deleted = false
      AND pi.status <> 'cancelled'
      AND (p_as_of IS NULL OR pi.pi_date IS NULL OR pi.pi_date <= p_as_of)
  ),
  inflow AS (
    SELECT m.to_entity_id AS entity_id, m.product_name, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.to_entity_id, m.product_name
  ),
  outflow AS (
    SELECT m.from_entity_id AS entity_id, m.product_name, SUM(m.qty) AS qty
    FROM mov m GROUP BY m.from_entity_id, m.product_name
  ),
  keys AS (
    SELECT i.entity_id, i.product_name FROM inflow i
    UNION SELECT o.entity_id, o.product_name FROM outflow o
  )
  SELECT
    k.entity_id,
    k.product_name,
    COALESCE(i.qty, 0) AS incoming,
    COALESCE(o.qty, 0) AS outgoing
  FROM keys k
  LEFT JOIN inflow i  ON i.entity_id = k.entity_id AND i.product_name IS NOT DISTINCT FROM k.product_name
  LEFT JOIN outflow o ON o.entity_id = k.entity_id AND o.product_name IS NOT DISTINCT FROM k.product_name
$$;

GRANT EXECUTE ON FUNCTION stock_planned_position(date) TO authenticated;
