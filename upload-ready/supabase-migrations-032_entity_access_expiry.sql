-- ============================================================================
-- 032_entity_access_expiry.sql
--
-- Adds time-bound (auto-expiring) entity access grants. A master/admin can
-- now give a user temporary access to an entity — once expires_at passes,
-- access closes automatically everywhere has_entity_grant() is checked (i.e.
-- every RLS policy that gates on entity access), no cron job needed. NULL
-- expires_at means permanent, exactly matching today's behavior.
--
-- Idempotent so a re-run (or partial earlier apply) is a safe no-op.
-- ============================================================================

ALTER TABLE user_entity_access ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE OR REPLACE FUNCTION has_entity_grant(target_entity_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT target_entity_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM user_entity_access
    WHERE user_id = auth.uid() AND entity_id = target_entity_id
      AND (expires_at IS NULL OR expires_at > now())
  );
$$;
