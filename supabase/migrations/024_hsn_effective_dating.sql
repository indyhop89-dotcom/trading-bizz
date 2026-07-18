-- ============================================================================
-- 024_hsn_effective_dating.sql
--
-- Editing an HSN rate in Settings used to UPDATE the single hsn_master row
-- for that code in place. Since gst_rate is frozen onto each *_lines row at
-- save time (never recomputed on view), already-saved documents were never
-- retroactively affected — but two real gaps existed: (1) reopening an old
-- document's line editor after a rate changed would silently pick up the
-- NEW rate on re-touch, and (2) creating a new document today for a
-- historically-dated transaction always got today's rate, not the rate that
-- was actually in force back then.
--
-- This adds effective-dating: hsn_master can now hold multiple rows per
-- hsn_code (one per version), each with an effective_from/effective_to
-- range. resolveGSTRate() (src/utils/hsn.js) picks the version effective on
-- the document's own date. Existing rows are backfilled as open-ended
-- ('2000-01-01' -> NULL), exactly reproducing today's behavior until
-- someone actually creates a new version.
-- ============================================================================

-- Idempotent: this migration may have partially applied on an earlier run
-- (e.g. the columns were added but a later step failed), so every statement
-- guards against already-existing objects and can be safely re-run.
ALTER TABLE hsn_master
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT '2000-01-01',
  ADD COLUMN IF NOT EXISTS effective_to   date; -- NULL = still current / open-ended

-- hsn_code can no longer be globally unique — multiple historical versions
-- of the same code must coexist. Replace with: at most one OPEN-ENDED
-- (effective_to IS NULL) row per code, so "the current rate" stays
-- unambiguous.
ALTER TABLE hsn_master DROP CONSTRAINT IF EXISTS hsn_master_hsn_code_unique;

CREATE UNIQUE INDEX IF NOT EXISTS hsn_master_one_open_version
  ON hsn_master (hsn_code)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_hsn_master_code_dates ON hsn_master (hsn_code, effective_from, effective_to);

-- Creates a new version of an HSN code: closes out whatever version is
-- currently open (effective_to = day before the new version starts) and
-- inserts the new one as the new open version. Atomic, so the Settings UI
-- never leaves hsn_master in a half-versioned state if the second step
-- fails. Restricted to 'master', matching hsn_master_write_master's RLS
-- policy this function's SECURITY DEFINER bypasses.
CREATE OR REPLACE FUNCTION hsn_master_insert_version(
  p_hsn_code      text,
  p_description   text,
  p_rate_type     text,
  p_fixed_rate    numeric,
  p_slabs         jsonb,
  p_effective_from date
)
RETURNS hsn_master AS $$
DECLARE
  v_row  hsn_master;
  v_open hsn_master;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master') THEN
    RAISE EXCEPTION 'Only master users can change HSN rates';
  END IF;

  SELECT * INTO v_open FROM hsn_master WHERE hsn_code = p_hsn_code AND effective_to IS NULL;

  IF FOUND THEN
    IF v_open.effective_from > p_effective_from THEN
      -- Backdating before the currently open version would leave it with an
      -- inverted (from > to) range — reject with a clear message instead of
      -- letting the unique-open-version index raise an opaque error later.
      RAISE EXCEPTION 'New version cannot start (%) before the currently open version (%) — pick a later effective date.', p_effective_from, v_open.effective_from;
    ELSIF v_open.effective_from = p_effective_from THEN
      -- Same-day correction (e.g. fixing a typo entered minutes ago): a
      -- strict "close the old, open a new" pair would try to write a
      -- second row with the exact same effective_from, colliding with
      -- hsn_master_one_open_version. Replace the still-open row in place —
      -- it never actually took effect as a distinct historical version.
      DELETE FROM hsn_master WHERE id = v_open.id;
    ELSE
      UPDATE hsn_master SET effective_to = p_effective_from - 1 WHERE id = v_open.id;
    END IF;
  END IF;

  INSERT INTO hsn_master (hsn_code, description, rate_type, fixed_rate, slabs, is_active, effective_from, effective_to)
  VALUES (p_hsn_code, p_description, p_rate_type, p_fixed_rate, p_slabs, true, p_effective_from, NULL)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION hsn_master_insert_version(text, text, text, numeric, jsonb, date) TO authenticated;
