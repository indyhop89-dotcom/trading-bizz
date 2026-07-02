-- ============================================================================
-- 012_enable_access_control_rls.sql
--
-- Part 2 of 2. THIS MIGRATION ACTUALLY LOCKS DOWN DATA. Do not run it until
-- you have completed the pre-flight steps below, or every non-master user
-- will suddenly see zero rows in every scoped table.
--
-- ── PRE-FLIGHT (do this first, in order) ────────────────────────────────────
-- 1. Check who's currently in profiles and confirm nobody is role='master' yet
--      SELECT id, email, role FROM profiles;
-- 2. Promote yourself (or whoever should be super admin) — replace the email:
--      UPDATE profiles SET role = 'master' WHERE email = 'you@example.com';
-- 3. Log into the app as that user, open Settings → Users, and grant every
--    other user the entities they should see (or promote more of them to
--    'master' if they should also be super admins).
-- 4. Only once every real user either has role='master' or at least one row
--    in user_entity_access, run this file.
--
-- If you skip step 4's check and someone has neither, they will see nothing
-- (fails safe/closed, not open) until you grant them access.
-- ============================================================================

-- ── proforma_invoices ────────────────────────────────────────────────────────
ALTER TABLE proforma_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pi_select ON proforma_invoices;
CREATE POLICY pi_select ON proforma_invoices FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(from_entity_id)
  OR (has_entity_grant(to_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS pi_write ON proforma_invoices;
CREATE POLICY pi_write ON proforma_invoices FOR ALL USING (
  is_super_admin() OR has_entity_grant(from_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(from_entity_id)
);

-- ── purchase_orders ──────────────────────────────────────────────────────────
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_select ON purchase_orders;
CREATE POLICY po_select ON purchase_orders FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(seller_entity_id)
  OR (has_entity_grant(buyer_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS po_write ON purchase_orders;
CREATE POLICY po_write ON purchase_orders FOR ALL USING (
  is_super_admin() OR has_entity_grant(seller_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(seller_entity_id)
);

-- ── invoices ─────────────────────────────────────────────────────────────────
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_select ON invoices;
CREATE POLICY invoices_select ON invoices FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(seller_entity_id)
  OR (has_entity_grant(buyer_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS invoices_write ON invoices;
CREATE POLICY invoices_write ON invoices FOR ALL USING (
  is_super_admin() OR has_entity_grant(seller_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(seller_entity_id)
);

-- ── credit_debit_notes ───────────────────────────────────────────────────────
ALTER TABLE credit_debit_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cdn_select ON credit_debit_notes;
CREATE POLICY cdn_select ON credit_debit_notes FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(issuer_entity_id)
  OR (has_entity_grant(receiver_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS cdn_write ON credit_debit_notes;
CREATE POLICY cdn_write ON credit_debit_notes FOR ALL USING (
  is_super_admin() OR has_entity_grant(issuer_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(issuer_entity_id)
);

-- ── orders (no draft concept — visible to both parties from creation) ──────
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(origin_entity_id)
  OR has_entity_grant(destination_entity_id)
);
DROP POLICY IF EXISTS orders_write ON orders;
CREATE POLICY orders_write ON orders FOR ALL USING (
  is_super_admin() OR has_entity_grant(origin_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(origin_entity_id)
);

-- ── order_legs ───────────────────────────────────────────────────────────────
ALTER TABLE order_legs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_legs_select ON order_legs;
CREATE POLICY order_legs_select ON order_legs FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(from_entity_id)
  OR has_entity_grant(to_entity_id)
);
DROP POLICY IF EXISTS order_legs_write ON order_legs;
CREATE POLICY order_legs_write ON order_legs FOR ALL USING (
  is_super_admin() OR has_entity_grant(from_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(from_entity_id)
);

-- ── payments ─────────────────────────────────────────────────────────────────
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT USING (
  is_super_admin()
  OR has_entity_grant(entity_id)
  OR (has_entity_grant(party_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS payments_write ON payments;
CREATE POLICY payments_write ON payments FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

-- ── expenses (single-entity, no counterparty visibility) ───────────────────
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id)
);
DROP POLICY IF EXISTS expenses_write ON expenses;
CREATE POLICY expenses_write ON expenses FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

-- ── bill_discounting_events (single-entity) ─────────────────────────────────
-- NOTE: verify this table name/columns against your live DB before running —
-- your migration files define `bill_discounting`, but seed data inserts into
-- `bill_discounting_events` with entity_id present in both. If your live
-- table is actually named differently, edit the table name below first.
ALTER TABLE bill_discounting_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bde_select ON bill_discounting_events;
CREATE POLICY bde_select ON bill_discounting_events FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id)
);
DROP POLICY IF EXISTS bde_write ON bill_discounting_events;
CREATE POLICY bde_write ON bill_discounting_events FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

-- ── stock_opening_balance (single-entity) ───────────────────────────────────
ALTER TABLE stock_opening_balance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_select ON stock_opening_balance;
CREATE POLICY stock_select ON stock_opening_balance FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id)
);
DROP POLICY IF EXISTS stock_write ON stock_opening_balance;
CREATE POLICY stock_write ON stock_opening_balance FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

-- ── profiles ─────────────────────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles FOR SELECT USING (
  is_super_admin() OR id = auth.uid()
);
DROP POLICY IF EXISTS profiles_update ON profiles;
CREATE POLICY profiles_update ON profiles FOR UPDATE USING (
  is_super_admin() OR id = auth.uid()
) WITH CHECK (
  is_super_admin() OR id = auth.uid()
);

-- ── user_entity_access — only super admins manage grants; users can read
--    their own grants (used by the app to know what they've been given) ────
ALTER TABLE user_entity_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS uea_select ON user_entity_access;
CREATE POLICY uea_select ON user_entity_access FOR SELECT USING (
  is_super_admin() OR user_id = auth.uid()
);
DROP POLICY IF EXISTS uea_write ON user_entity_access;
CREATE POLICY uea_write ON user_entity_access FOR ALL USING (
  is_super_admin()
) WITH CHECK (
  is_super_admin()
);

-- ── expense_categories — everyone can read (needed for dropdowns), only
--    super admins can manage the list ───────────────────────────────────────
ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expcat_select ON expense_categories;
CREATE POLICY expcat_select ON expense_categories FOR SELECT USING (true);
DROP POLICY IF EXISTS expcat_write ON expense_categories;
CREATE POLICY expcat_write ON expense_categories FOR ALL USING (
  is_super_admin()
) WITH CHECK (
  is_super_admin()
);

-- ============================================================================
-- KNOWN GAP (documented, not silently skipped):
-- Line-item / child tables — proforma_invoice_lines, purchase_order_lines,
-- invoice_lines, credit_debit_note_lines, tds_tcs_entries,
-- bill_discounting_invoices, bill_discounting_repayments, payment_allocations,
-- documents, notifications, reconciliation records — are NOT covered by this
-- migration. They're only ever fetched scoped to a parent id that the app
-- reaches through an already-protected parent query, so today's UI can't
-- expose them, but a direct API call with a guessed parent id still could.
-- Recommend a follow-up pass once the primary tables above are verified
-- working correctly in production.
-- ============================================================================
