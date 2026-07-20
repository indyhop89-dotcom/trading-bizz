-- ============================================================================
-- 035_group_access.sql
--
-- Adds group-wise user access grants, alongside the existing entity-wise
-- grants (user_entity_access). A master/admin can now grant a user access
-- to an entire entity_group at once instead of picking every entity in it
-- individually — and, unlike a one-time bulk-select, it's a live grant: if
-- an entity is added to (or moved into) that group later, everyone with a
-- grant on the group gains access to it automatically, no need to revisit
-- and re-save existing users' access.
--
-- This is a single choke-point change: every RLS policy in the app already
-- gates on has_entity_grant(entity_id) (see 012_enable_access_control_rls.sql)
-- rather than querying user_entity_access directly, so extending that one
-- function to also check group membership automatically covers PI, PO,
-- Invoices, CDN, Orders, Payments, Expenses, Bill Discounting, and Stock —
-- no other RLS policy needs to change.
--
-- Idempotent so a re-run (or partial earlier apply) is a safe no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_group_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES entity_groups ON DELETE CASCADE,
  granted_by  uuid REFERENCES profiles,
  expires_at  timestamptz, -- NULL = permanent, same convention as user_entity_access
  created_at  timestamptz DEFAULT now(),
  UNIQUE(user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_user_group_access_user  ON user_group_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_group_access_group ON user_group_access(group_id);

-- Same RLS shape as user_entity_access: only super admins manage grants,
-- users can read their own.
ALTER TABLE user_group_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS uga_select ON user_group_access;
CREATE POLICY uga_select ON user_group_access FOR SELECT USING (
  is_super_admin() OR user_id = auth.uid()
);
DROP POLICY IF EXISTS uga_write ON user_group_access;
CREATE POLICY uga_write ON user_group_access FOR ALL USING (
  is_super_admin()
) WITH CHECK (
  is_super_admin()
);

-- has_entity_grant now returns true if the caller has EITHER a direct grant
-- on the entity OR a group grant on the group that entity currently belongs
-- to (entities.group_id) — an entity with no group_id simply can't be
-- reached via a group grant, same as today.
CREATE OR REPLACE FUNCTION has_entity_grant(target_entity_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT target_entity_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM user_entity_access
      WHERE user_id = auth.uid() AND entity_id = target_entity_id
        AND (expires_at IS NULL OR expires_at > now())
    )
    OR EXISTS (
      SELECT 1 FROM user_group_access uga
      JOIN entities e ON e.group_id = uga.group_id
      WHERE uga.user_id = auth.uid() AND e.id = target_entity_id
        AND (uga.expires_at IS NULL OR uga.expires_at > now())
    )
  );
$$;

COMMENT ON FUNCTION has_entity_grant IS 'True if the calling user has been explicitly granted access to target_entity_id, either directly (user_entity_access) or via a group grant (user_group_access) on the group that entity belongs to.';
