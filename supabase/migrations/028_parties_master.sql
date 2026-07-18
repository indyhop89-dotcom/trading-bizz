-- ============================================================================
-- 028_parties_master.sql
--
-- A global "parties" master (vendors/suppliers you pay), shared across ALL
-- entities so the same party isn't re-typed per entity. Each party carries its
-- GST/PAN/contact details plus default payment terms, so recording an expense
-- against a party can auto-fill GSTIN and compute a payment due date instead of
-- re-entering everything by hand.
--
-- expenses gains:
--   party_id  → the tagged party (optional; ON DELETE SET NULL keeps the
--               expense if the party is later removed)
--   due_date  → when payment is due (expense_date + party's payment_days),
--               editable per expense
--
-- Access: readable by any signed-in user (needed for dropdowns); only
-- master/admin may add/edit/remove parties — matching the app's hasFullAccess
-- convention. Idempotent so a re-run (or partial earlier apply) is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS parties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  gstin           text,
  pan             text,
  address         text,
  contact_person  text,
  phone           text,
  email           text,
  payment_terms   text,            -- optional label, e.g. "Net 30", "Advance"
  payment_days    int,             -- days from expense date to due date (drives due_date)
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  is_deleted      boolean NOT NULL DEFAULT false,
  created_at      timestamptz DEFAULT now(),
  created_by      uuid REFERENCES profiles(id)
);

-- Same GSTIN can't be entered twice — the government-unique key that best
-- guards against the duplicate-party problem this master is meant to solve.
-- Partial so the many parties with no GSTIN don't collide on NULL/''.
CREATE UNIQUE INDEX IF NOT EXISTS parties_gstin_unique
  ON parties (upper(gstin))
  WHERE gstin IS NOT NULL AND gstin <> '' AND is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_parties_active ON parties (name) WHERE is_deleted = false AND is_active = true;

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parties_select ON parties;
CREATE POLICY parties_select ON parties FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS parties_write ON parties;
CREATE POLICY parties_write ON parties FOR ALL
  USING     (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('master','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('master','admin')));

-- ── expenses: link to a party + payment due date ────────────────────────────
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS due_date date;

CREATE INDEX IF NOT EXISTS idx_expenses_party ON expenses (party_id) WHERE party_id IS NOT NULL;
