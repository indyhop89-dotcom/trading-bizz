-- ============================================================================
-- 061_document_format_names.sql
--
-- Display names for the invoice formats, so they can be renamed from
-- Settings → Invoice Formats. The formats themselves live in the app code
-- (tally / vananam / srpl / kamakhya); this table only stores a custom name
-- for each. A format with no row here shows its built-in name.
--
--   * New table only — nothing existing is touched.
--   * Everyone signed in can read the names; only master / admin can rename.
--   * Idempotent — safe to run again.
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_format_names (
  format_key    text PRIMARY KEY,
  display_name  text NOT NULL,
  updated_at    timestamptz DEFAULT now(),
  updated_by    uuid REFERENCES profiles(id)
);

ALTER TABLE document_format_names ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_format_names_select ON document_format_names;
CREATE POLICY document_format_names_select ON document_format_names
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS document_format_names_write ON document_format_names;
CREATE POLICY document_format_names_write ON document_format_names FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('master', 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('master', 'admin'))
);

NOTIFY pgrst, 'reload schema';
