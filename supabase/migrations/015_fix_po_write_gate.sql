-- ============================================================================
-- 015_fix_po_write_gate.sql
--
-- SAFE TO RUN IMMEDIATELY — replaces two existing policies, doesn't touch
-- any data.
--
-- BUG FIX: purchase_orders' write policy (from 012/014) gates on
-- has_entity_grant(seller_entity_id) — the seller. But the actual workflow
-- is: seller creates a PI, sends it, and the buyer converts it into their
-- own PO. The buyer is the creator/writer of a PO, not the seller. As
-- deployed, this bug means a buyer-side user (with a grant on their own
-- entity but not the seller's) cannot create or edit their own POs at all.
--
-- This flips both policies to match PI's own from_entity_id/to_entity_id
-- pattern: the creating side (buyer) has full read/write, the counterparty
-- (seller) only sees it once it's out of 'draft'.
-- ============================================================================

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS po_select ON purchase_orders;
CREATE POLICY po_select ON purchase_orders FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(buyer_entity_id)
  OR (has_entity_grant(seller_entity_id) AND status <> 'draft')
);

DROP POLICY IF EXISTS po_write ON purchase_orders;
CREATE POLICY po_write ON purchase_orders FOR ALL USING (
  is_super_admin() OR has_entity_grant(buyer_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(buyer_entity_id)
);

-- purchase_order_lines follows its parent's write side — was already
-- correctly written against seller_entity_id in 014 to match the (buggy)
-- po_write gate at the time; flip it here too so lines stay writable by
-- whoever can write the parent PO.
DROP POLICY IF EXISTS po_lines_select ON purchase_order_lines;
CREATE POLICY po_lines_select ON purchase_order_lines FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM purchase_orders p WHERE p.id = po_id AND (
      is_super_admin() OR has_entity_grant(p.buyer_entity_id) OR (has_entity_grant(p.seller_entity_id) AND p.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS po_lines_write ON purchase_order_lines;
CREATE POLICY po_lines_write ON purchase_order_lines FOR ALL USING (
  EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = po_id AND (is_super_admin() OR has_entity_grant(p.buyer_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = po_id AND (is_super_admin() OR has_entity_grant(p.buyer_entity_id)))
);
