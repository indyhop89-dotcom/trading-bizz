-- ============================================================================
-- 036_orders_visible_via_leg_entities.sql
--
-- Fixes a gap present since orders_select was first introduced (001_phase1.sql,
-- carried through 012 and 014): it only checks the order's overall
-- origin_entity_id/destination_entity_id, so an entity that's only an
-- intermediate party in a multi-leg order can never see that order at all —
-- e.g. leg 1 MVL -> Anugan, leg 2 Anugan -> KLB: the order's origin is MVL
-- and destination is KLB, so Anugan (neither) fails orders_select entirely.
--
-- order_legs_select is already correctly scoped by from_entity_id/
-- to_entity_id and would show Anugan both legs — but Order Detail loads the
-- parent `orders` row first, so that row being invisible blocks the legs
-- (and the PI/PO/Invoice data entry that happens against them) from ever
-- being reached. Practical workaround so far has been granting broader
-- (often master) access instead.
--
-- Now: an order is visible if you have a grant on its origin/destination OR
-- on either side of any of its legs. No change to order_legs_select or any
-- write policy — this only widens who can see the parent order row.
--
-- Idempotent (DROP POLICY IF EXISTS + CREATE) — safe to re-run.
-- ============================================================================

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(origin_entity_id)
  OR has_entity_grant(destination_entity_id)
  OR EXISTS (
    SELECT 1 FROM order_legs ol
    WHERE ol.order_id = orders.id
      AND (has_entity_grant(ol.from_entity_id) OR has_entity_grant(ol.to_entity_id))
  )
);
