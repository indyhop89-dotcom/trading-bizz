-- ============================================================================
-- 011_master_config_and_access_tables.sql
--
-- Part 1 of 2 for the access-control rollout.
-- This migration is SAFE TO RUN IMMEDIATELY — it only adds new tables,
-- functions, and one status value. It does NOT enable RLS and does NOT
-- change what any existing user can currently see.
--
-- RLS enforcement itself lives in 012_enable_access_control_rls.sql, which
-- you should only run after:
--   1. Promoting at least one profile to role = 'master' (super admin)
--   2. Granting entity access to your other users via the new Users tab
-- See the top of 012_enable_access_control_rls.sql for the pre-flight steps.
-- ============================================================================

-- ── 1. user_entity_access — many-to-many grant table ───────────────────────
CREATE TABLE IF NOT EXISTS user_entity_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
  entity_id   uuid NOT NULL REFERENCES entities ON DELETE CASCADE,
  granted_by  uuid REFERENCES profiles,
  created_at  timestamptz DEFAULT now(),
  UNIQUE(user_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_user_entity_access_user   ON user_entity_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_entity_access_entity ON user_entity_access(entity_id);

-- RLS disabled for now — enabled in 012, after data is backfilled.
ALTER TABLE user_entity_access DISABLE ROW LEVEL SECURITY;


-- ── 2. expense_categories — master config, replaces hardcoded EXPENSE_TYPES ─
CREATE TABLE IF NOT EXISTS expense_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  sort_order  int  NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE expense_categories DISABLE ROW LEVEL SECURITY;

-- Seed with the 15 categories currently hardcoded in src/pages/Expenses/index.jsx
-- (EXPENSE_TYPES array) so behaviour is unchanged after this ships.
INSERT INTO expense_categories (name, sort_order) VALUES
  ('Hangtags',           1),
  ('Freight',            2),
  ('Transport',          3),
  ('Labour',             4),
  ('Loading/Unloading',  5),
  ('Brokerage',          6),
  ('Bank Charges',       7),
  ('Duty/Tax',           8),
  ('Insurance',          9),
  ('Office',            10),
  ('Professional',      11),
  ('Repair',            12),
  ('Sampling',          13),
  ('Packaging',         14),
  ('Other',             15)
ON CONFLICT (name) DO NOTHING;

-- Drop the old CHECK constraint on expenses.category if it still exists in
-- your live DB (it enforced a different, older/lowercase list than what the
-- app has been inserting — see assessment notes). Safe no-op if already gone.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'expenses'::regclass AND contype = 'c' AND conname LIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE expenses DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;


-- ── 3. purchase_orders: add draft state so POs behave like PIs ─────────────
-- Existing POs are already sitting at 'open' or later — they were effectively
-- already "sent" under the old flow, so this does NOT hide any existing PO
-- from its counterparty. Only newly created POs will start at 'draft'.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'purchase_orders'::regclass AND contype = 'c' AND conname LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE purchase_orders DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft','open','partial','completed','cancelled'));


-- ── 4. Access-control helper functions ──────────────────────────────────────
-- SECURITY DEFINER so they can read `profiles`/`user_entity_access` even
-- when called from inside another table's RLS policy (which runs as the
-- calling user, who may not otherwise have SELECT on those tables).

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master' AND is_active
  );
$$;

CREATE OR REPLACE FUNCTION has_entity_grant(target_entity_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT target_entity_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM user_entity_access
    WHERE user_id = auth.uid() AND entity_id = target_entity_id
  );
$$;

COMMENT ON FUNCTION is_super_admin IS 'True if the calling user has role=master (super admin) and is active.';
COMMENT ON FUNCTION has_entity_grant IS 'True if the calling user has been explicitly granted access to target_entity_id.';
