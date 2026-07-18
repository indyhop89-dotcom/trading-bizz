-- ============================================================================
-- 014_child_and_missing_table_rls.sql
--
-- THIS MIGRATION LOCKS DOWN DATA. Same pre-flight requirement as
-- 012_enable_access_control_rls.sql — do not run until:
--   1. At least one profile has role = 'master'.
--   2. Every other real user has at least one row in user_entity_access
--      (Settings → Users), or they will see zero rows in every scoped
--      table below until granted access (fails safe/closed, not open).
--
-- WHY THIS RE-ASSERTS ALL OF 012, NOT JUST THE NEW GAPS
-- 012 enables RLS on `bill_discounting_events` and creates policies on it.
-- That table did not exist anywhere in migrations 001-012 — it was only
-- ever created live, out-of-band (see 013's notes). If 012 was ever run as
-- one pasted script, the ALTER TABLE on a nonexistent table would raise an
-- error and, run inside the Supabase SQL editor's implicit transaction,
-- roll back *everything else in that script* — meaning invoices/payments/
-- proforma_invoices/purchase_orders/credit_debit_notes/expenses/
-- stock_opening_balance/profiles/user_entity_access/expense_categories may
-- never have actually gotten their 012 policies applied at all, even though
-- the file exists and looks correct. Every statement below is written to be
-- safe to re-run whether or not 012 succeeded (ENABLE ROW LEVEL SECURITY is
-- idempotent; DROP POLICY IF EXISTS + CREATE POLICY replaces cleanly).
-- Run this migration instead of re-running 012 by hand.
-- ============================================================================

-- ── Re-assert every 012 policy (idempotent — see note above) ───────────────
ALTER TABLE proforma_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pi_select ON proforma_invoices;
CREATE POLICY pi_select ON proforma_invoices FOR SELECT USING (
  is_super_admin() OR has_entity_grant(from_entity_id) OR (has_entity_grant(to_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS pi_write ON proforma_invoices;
CREATE POLICY pi_write ON proforma_invoices FOR ALL USING (
  is_super_admin() OR has_entity_grant(from_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(from_entity_id)
);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_select ON purchase_orders;
CREATE POLICY po_select ON purchase_orders FOR SELECT USING (
  is_super_admin() OR has_entity_grant(seller_entity_id) OR (has_entity_grant(buyer_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS po_write ON purchase_orders;
CREATE POLICY po_write ON purchase_orders FOR ALL USING (
  is_super_admin() OR has_entity_grant(seller_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(seller_entity_id)
);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_select ON invoices;
CREATE POLICY invoices_select ON invoices FOR SELECT USING (
  is_super_admin() OR has_entity_grant(seller_entity_id) OR (has_entity_grant(buyer_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS invoices_write ON invoices;
CREATE POLICY invoices_write ON invoices FOR ALL USING (
  is_super_admin() OR has_entity_grant(seller_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(seller_entity_id)
);

ALTER TABLE credit_debit_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cdn_select ON credit_debit_notes;
CREATE POLICY cdn_select ON credit_debit_notes FOR SELECT USING (
  is_super_admin() OR has_entity_grant(issuer_entity_id) OR (has_entity_grant(receiver_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS cdn_write ON credit_debit_notes;
CREATE POLICY cdn_write ON credit_debit_notes FOR ALL USING (
  is_super_admin() OR has_entity_grant(issuer_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(issuer_entity_id)
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT USING (
  is_super_admin() OR has_entity_grant(origin_entity_id) OR has_entity_grant(destination_entity_id)
);
DROP POLICY IF EXISTS orders_write ON orders;
CREATE POLICY orders_write ON orders FOR ALL USING (
  is_super_admin() OR has_entity_grant(origin_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(origin_entity_id)
);

ALTER TABLE order_legs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_legs_select ON order_legs;
CREATE POLICY order_legs_select ON order_legs FOR SELECT USING (
  is_super_admin() OR has_entity_grant(from_entity_id) OR has_entity_grant(to_entity_id)
);
DROP POLICY IF EXISTS order_legs_write ON order_legs;
CREATE POLICY order_legs_write ON order_legs FOR ALL USING (
  is_super_admin() OR has_entity_grant(from_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(from_entity_id)
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id) OR (has_entity_grant(party_entity_id) AND status <> 'draft')
);
DROP POLICY IF EXISTS payments_write ON payments;
CREATE POLICY payments_write ON payments FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

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
-- NEW: line-item / child tables — each visible exactly when its parent
-- document is visible, writable only by the same side that can write the
-- parent. A direct API call with a guessed parent id can no longer read or
-- write these rows outside that scope.
-- ============================================================================

ALTER TABLE proforma_invoice_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pi_lines_select ON proforma_invoice_lines;
CREATE POLICY pi_lines_select ON proforma_invoice_lines FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM proforma_invoices p WHERE p.id = pi_id AND (
      is_super_admin() OR has_entity_grant(p.from_entity_id) OR (has_entity_grant(p.to_entity_id) AND p.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS pi_lines_write ON proforma_invoice_lines;
CREATE POLICY pi_lines_write ON proforma_invoice_lines FOR ALL USING (
  EXISTS (SELECT 1 FROM proforma_invoices p WHERE p.id = pi_id AND (is_super_admin() OR has_entity_grant(p.from_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM proforma_invoices p WHERE p.id = pi_id AND (is_super_admin() OR has_entity_grant(p.from_entity_id)))
);

ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_lines_select ON purchase_order_lines;
CREATE POLICY po_lines_select ON purchase_order_lines FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM purchase_orders p WHERE p.id = po_id AND (
      is_super_admin() OR has_entity_grant(p.seller_entity_id) OR (has_entity_grant(p.buyer_entity_id) AND p.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS po_lines_write ON purchase_order_lines;
CREATE POLICY po_lines_write ON purchase_order_lines FOR ALL USING (
  EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = po_id AND (is_super_admin() OR has_entity_grant(p.seller_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = po_id AND (is_super_admin() OR has_entity_grant(p.seller_entity_id)))
);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_lines_select ON invoice_lines;
CREATE POLICY invoice_lines_select ON invoice_lines FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (
      is_super_admin() OR has_entity_grant(i.seller_entity_id) OR (has_entity_grant(i.buyer_entity_id) AND i.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS invoice_lines_write ON invoice_lines;
CREATE POLICY invoice_lines_write ON invoice_lines FOR ALL USING (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (is_super_admin() OR has_entity_grant(i.seller_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (is_super_admin() OR has_entity_grant(i.seller_entity_id)))
);

ALTER TABLE tds_tcs_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_tcs_select ON tds_tcs_entries;
CREATE POLICY tds_tcs_select ON tds_tcs_entries FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (
      is_super_admin() OR has_entity_grant(i.seller_entity_id) OR (has_entity_grant(i.buyer_entity_id) AND i.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS tds_tcs_write ON tds_tcs_entries;
CREATE POLICY tds_tcs_write ON tds_tcs_entries FOR ALL USING (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (is_super_admin() OR has_entity_grant(i.seller_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND (is_super_admin() OR has_entity_grant(i.seller_entity_id)))
);

ALTER TABLE credit_debit_note_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cdn_lines_select ON credit_debit_note_lines;
CREATE POLICY cdn_lines_select ON credit_debit_note_lines FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM credit_debit_notes n WHERE n.id = note_id AND (
      is_super_admin() OR has_entity_grant(n.issuer_entity_id) OR (has_entity_grant(n.receiver_entity_id) AND n.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS cdn_lines_write ON credit_debit_note_lines;
CREATE POLICY cdn_lines_write ON credit_debit_note_lines FOR ALL USING (
  EXISTS (SELECT 1 FROM credit_debit_notes n WHERE n.id = note_id AND (is_super_admin() OR has_entity_grant(n.issuer_entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM credit_debit_notes n WHERE n.id = note_id AND (is_super_admin() OR has_entity_grant(n.issuer_entity_id)))
);

ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pay_alloc_select ON payment_allocations;
CREATE POLICY pay_alloc_select ON payment_allocations FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM payments p WHERE p.id = payment_id AND (
      is_super_admin() OR has_entity_grant(p.entity_id) OR (has_entity_grant(p.party_entity_id) AND p.status <> 'draft')
    )
  )
);
DROP POLICY IF EXISTS pay_alloc_write ON payment_allocations;
CREATE POLICY pay_alloc_write ON payment_allocations FOR ALL USING (
  EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND (is_super_admin() OR has_entity_grant(p.entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND (is_super_admin() OR has_entity_grant(p.entity_id)))
);

ALTER TABLE bill_discounting_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bdi_select ON bill_discounting_invoices;
CREATE POLICY bdi_select ON bill_discounting_invoices FOR SELECT USING (
  EXISTS (SELECT 1 FROM bill_discounting_events e WHERE e.id = event_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
);
DROP POLICY IF EXISTS bdi_write ON bill_discounting_invoices;
CREATE POLICY bdi_write ON bill_discounting_invoices FOR ALL USING (
  EXISTS (SELECT 1 FROM bill_discounting_events e WHERE e.id = event_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM bill_discounting_events e WHERE e.id = event_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
);

ALTER TABLE bill_discounting_repayments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bdr_select ON bill_discounting_repayments;
CREATE POLICY bdr_select ON bill_discounting_repayments FOR SELECT USING (
  EXISTS (SELECT 1 FROM bill_discounting_events e WHERE e.id = event_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
);
DROP POLICY IF EXISTS bdr_write ON bill_discounting_repayments;
CREATE POLICY bdr_write ON bill_discounting_repayments FOR ALL USING (
  EXISTS (SELECT 1 FROM bill_discounting_events e WHERE e.id = event_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM bill_discounting_events e WHERE e.id = event_id AND (is_super_admin() OR has_entity_grant(e.entity_id)))
);

-- ============================================================================
-- NEW: invoice_payments / expense_payments / banks — created in 013, still
-- had RLS disabled until now.
-- ============================================================================

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invpay_select ON invoice_payments;
CREATE POLICY invpay_select ON invoice_payments FOR SELECT USING (
  is_super_admin() OR has_entity_grant(entity_id) OR has_entity_grant(party_entity_id)
);
DROP POLICY IF EXISTS invpay_write ON invoice_payments;
CREATE POLICY invpay_write ON invoice_payments FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);

ALTER TABLE expense_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exppay_select ON expense_payments;
CREATE POLICY exppay_select ON expense_payments FOR SELECT USING (
  is_super_admin() OR has_entity_grant(from_entity_id)
);
DROP POLICY IF EXISTS exppay_write ON expense_payments;
CREATE POLICY exppay_write ON expense_payments FOR ALL USING (
  is_super_admin() OR has_entity_grant(from_entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(from_entity_id)
);

-- banks is shared master data (a financier isn't owned by one entity) —
-- readable by anyone authenticated (needed for dropdowns), writable by
-- super admins only, same pattern as products/hsn_master/expense_categories.
ALTER TABLE banks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS banks_select ON banks;
CREATE POLICY banks_select ON banks FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS banks_write ON banks;
CREATE POLICY banks_write ON banks FOR ALL USING (
  is_super_admin()
) WITH CHECK (
  is_super_admin()
);

-- ============================================================================
-- NEW: notifications — RLS was force-disabled in 007_missing_tables.sql and
-- never re-enabled. Re-adds the original 001 select/update policies AND an
-- INSERT policy that 001 never had at all — without it, every client-side
-- notification insert (generateNotifications(), the invoice-cancelled-
-- after-E-way-Bill alert) would start silently failing the moment RLS is
-- turned back on.
-- ============================================================================
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_select ON notifications;
CREATE POLICY notif_select ON notifications FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS notif_insert ON notifications;
CREATE POLICY notif_insert ON notifications FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS notif_update ON notifications;
CREATE POLICY notif_update ON notifications FOR UPDATE USING (user_id = auth.uid());

-- ============================================================================
-- NEW: documents — modernized to use the same is_super_admin()/
-- has_entity_grant() helpers as everything else, replacing the legacy
-- user_has_entity_access() wrapper from 001. Same net permission (a single
-- entity_id gate), just consolidated onto one set of helper functions so
-- there's one place to audit, not two.
-- ============================================================================
DROP POLICY IF EXISTS documents_access ON documents;
CREATE POLICY documents_access ON documents FOR ALL USING (
  is_super_admin() OR has_entity_grant(entity_id)
) WITH CHECK (
  is_super_admin() OR has_entity_grant(entity_id)
);
