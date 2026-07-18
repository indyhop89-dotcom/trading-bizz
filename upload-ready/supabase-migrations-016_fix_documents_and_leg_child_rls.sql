-- ============================================================================
-- 016_fix_documents_and_leg_child_rls.sql
--
-- THIS MIGRATION LOCKS DOWN DATA. Same pre-flight requirement as 012/014 —
-- every real user needs role='master' or a user_entity_access row before
-- running this, or they'll see zero rows in `documents` from here on.
--
-- THREE REAL GAPS FOUND ON FINAL AUDIT:
--
-- 1. `documents` — RLS was disabled by 010_documents_billfrom_eway.sql and
--    never turned back on. 014_child_and_missing_table_rls.sql replaced the
--    *policy* on this table but forgot the ALTER TABLE ... ENABLE ROW LEVEL
--    SECURITY statement, so the new policy has been sitting inert — every
--    authenticated user has been able to read/write every document
--    regardless of entity, the entire time 014 has been live.
--
-- 2. `leg_document_checklist` — also disabled by 010, and no migration
--    since (including 014) ever re-enabled it. Same exposure as above.
--
-- 3. `leg_stock_items` — RLS has been enabled since 001, but its policy
--    (`leg_stock_access`) only checks that the referenced leg *exists*, not
--    that the calling user has access to either entity on that leg. Same
--    for `leg_document_checklist`'s original policy. Both are fixed here to
--    actually check entity access through the parent leg.
--
-- Neither leg_stock_items nor leg_document_checklist is currently queried
-- directly by the frontend (order_legs/documents are queried instead), but
-- Supabase exposes a REST/RPC endpoint for every table regardless of
-- frontend usage — an unfiltered policy is a real hole via direct API call,
-- not just a theoretical one.
-- ============================================================================

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
-- (policy itself was already correct from 014 — re-asserted here defensively)
DROP POLICY IF EXISTS documents_access ON documents;
CREATE POLICY documents_access ON documents FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

ALTER TABLE leg_document_checklist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checklist_access ON leg_document_checklist;
CREATE POLICY checklist_access ON leg_document_checklist FOR ALL USING (
  EXISTS (
    SELECT 1 FROM order_legs l WHERE l.id = leg_id AND (
      is_super_admin() OR has_entity_grant(l.from_entity_id) OR has_entity_grant(l.to_entity_id)
    )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM order_legs l WHERE l.id = leg_id AND (
      is_super_admin() OR has_entity_grant(l.from_entity_id) OR has_entity_grant(l.to_entity_id)
    )
  )
);

DROP POLICY IF EXISTS leg_stock_access ON leg_stock_items;
CREATE POLICY leg_stock_access ON leg_stock_items FOR ALL USING (
  EXISTS (
    SELECT 1 FROM order_legs l WHERE l.id = leg_id AND (
      is_super_admin() OR has_entity_grant(l.from_entity_id) OR has_entity_grant(l.to_entity_id)
    )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM order_legs l WHERE l.id = leg_id AND (
      is_super_admin() OR has_entity_grant(l.from_entity_id) OR has_entity_grant(l.to_entity_id)
    )
  )
);

-- ============================================================================
-- Consistency cleanup — these two still ran on the original 001 policy,
-- which uses the legacy user_has_entity_access() helper. Same permission
-- either way (both ultimately check user_entity_access + master role) —
-- this just consolidates every policy onto the one helper set so there's a
-- single place to audit access logic going forward, not two.
-- entities_write is intentionally left alone: it currently lets any
-- 'entity_user' (not just master) create/edit any entity, which looks like
-- shared master-data maintenance rather than a bug — restricting it to
-- has_entity_grant(id) would also block creating brand-new entities (they
-- have no grant yet), so that's a product decision, not a fix, and is
-- called out separately rather than changed here.
-- ============================================================================
DROP POLICY IF EXISTS entities_select ON entities;
CREATE POLICY entities_select ON entities FOR SELECT USING (
  is_super_admin() OR has_entity_grant(id)
);

DROP POLICY IF EXISTS stock_mov_access ON stock_movements;
CREATE POLICY stock_mov_access ON stock_movements FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);
