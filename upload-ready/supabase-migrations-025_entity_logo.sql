-- ============================================================================
-- 025_entity_logo.sql
--
-- Per-entity document generation (Proforma Invoice/Invoice/PO PDF & Excel)
-- needs each entity's own letterhead logo. Mirrors the existing
-- drive_file_id/drive_url pairing convention already used elsewhere in this
-- app (documents, credit_debit_notes) — logo_file_id is the B2 key needed to
-- re-fetch/replace/delete the logo via the same authenticated b2-upload
-- edge function every other file upload in this app already goes through;
-- logo_url is the (auth-gated) URL stored alongside it for reference.
--
-- Nullable: an entity with no logo uploaded yet still generates documents
-- fine — the document header just renders text-only (name/address/GSTIN).
-- ============================================================================

-- Idempotent guards so a re-run (or partial earlier apply) is a safe no-op.
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS logo_file_id text;
