-- Add an 'admin' role between 'master' and 'entity_user'. Master can create
-- users for any entity; admin can create users too, but only for entities
-- the admin themselves already has a grant for (enforced in the create-user
-- Edge Function — see supabase/functions/create-user/index.ts).

-- Widen the role CHECK constraint. Confirmed against the live DB that
-- Postgres's default naming convention (table_column_check) applies here —
-- the constraint is named profiles_role_check (a LIKE-based lookup on
-- pg_get_constraintdef() failed to find it because Postgres normalizes
-- `IN (...)` into `= ANY (ARRAY[...])` internally, so it never contains the
-- literal substring "IN").
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('master', 'admin', 'entity_user', 'viewer'));

-- Some environments only ever ran the original 001_phase1.sql definition of
-- user_entity_access (without granted_by) if the later IF-NOT-EXISTS
-- re-declaration in 011 no-op'd — add it defensively so the create-user
-- Edge Function's granted_by insert never fails on a column that doesn't exist.
ALTER TABLE user_entity_access
  ADD COLUMN IF NOT EXISTS granted_by uuid REFERENCES profiles(id);
