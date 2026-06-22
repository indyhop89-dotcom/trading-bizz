-- Trading Bizz — Phase 1 Migration
-- Run this in Supabase SQL Editor

-- ── 1. profiles ──────────────────────────────────────────────────────────
CREATE TABLE profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  full_name   text NOT NULL,
  email       text NOT NULL,
  phone       text,
  role        text NOT NULL DEFAULT 'entity_user'
              CHECK (role IN ('master', 'entity_user', 'viewer')),
  is_active   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO profiles (id, full_name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.email
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── 2. entity_groups ─────────────────────────────────────────────────────
CREATE TABLE entity_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  created_at  timestamptz DEFAULT now()
);

-- ── 3. entities ──────────────────────────────────────────────────────────
CREATE TABLE entities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id              uuid REFERENCES entity_groups,
  name                  text NOT NULL,
  short_name            text,
  type                  text NOT NULL DEFAULT 'associate'
                        CHECK (type IN ('group', 'associate', 'external')),
  gstin                 text,
  pan                   text,
  state_code            text,
  state_name            text,
  address               text,
  city                  text,
  pincode               text,
  email                 text,
  phone                 text,
  bank_name             text,
  bank_account_no       text,
  bank_ifsc             text,
  bank_branch           text,
  reliance_vendor_id    text,
  reliance_sales_id     text,
  reliance_onboarded    boolean DEFAULT false,
  reliance_notes        text,
  is_active             boolean DEFAULT true,
  is_deleted            boolean DEFAULT false,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ── 4. user_entity_access ────────────────────────────────────────────────
CREATE TABLE user_entity_access (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES profiles NOT NULL,
  entity_id    uuid REFERENCES entities NOT NULL,
  access_level text DEFAULT 'full' CHECK (access_level IN ('full', 'view_only')),
  created_at   timestamptz DEFAULT now(),
  UNIQUE(user_id, entity_id)
);

-- ── 5. financial_years ───────────────────────────────────────────────────
CREATE TABLE financial_years (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  code        text NOT NULL UNIQUE,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  is_active   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- Seed current and next FY
INSERT INTO financial_years (name, code, start_date, end_date, is_active) VALUES
  ('FY 2024-25', '2425', '2024-04-01', '2025-03-31', false),
  ('FY 2025-26', '2526', '2025-04-01', '2026-03-31', true),
  ('FY 2026-27', '2627', '2026-04-01', '2027-03-31', false);

-- ── 6. products ──────────────────────────────────────────────────────────
CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  hsn_code     text NOT NULL,
  gst_rate     numeric(5,2) NOT NULL DEFAULT 0,
  unit         text DEFAULT 'Nos',
  default_rate bigint DEFAULT 0,
  is_active    boolean DEFAULT true,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- ── 7. stock_opening_balance ─────────────────────────────────────────────
CREATE TABLE stock_opening_balance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  product_id        uuid REFERENCES products NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  qty               numeric(15,3) DEFAULT 0,
  rate              bigint DEFAULT 0,
  hsn_code          text,
  gst_rate          numeric(5,2),
  as_of_date        date NOT NULL,
  notes             text,
  created_at        timestamptz DEFAULT now(),
  created_by        uuid REFERENCES profiles,
  UNIQUE(entity_id, product_id, financial_year_id)
);

-- ── 8. stock_movements ───────────────────────────────────────────────────
CREATE TABLE stock_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    uuid REFERENCES entities NOT NULL,
  product_id   uuid REFERENCES products NOT NULL,
  posting_date date NOT NULL,
  qty_in       numeric(15,3) DEFAULT 0,
  qty_out      numeric(15,3) DEFAULT 0,
  rate         bigint DEFAULT 0,
  voucher_type text NOT NULL,
  voucher_id   uuid NOT NULL,
  voucher_no   text,
  notes        text,
  is_cancelled boolean DEFAULT false,
  created_at   timestamptz DEFAULT now(),
  created_by   uuid REFERENCES profiles
);

-- ── 9. orders ────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no                 text NOT NULL UNIQUE,
  name                     text NOT NULL,
  financial_year_id        uuid REFERENCES financial_years NOT NULL,
  origin_entity_id         uuid REFERENCES entities,
  destination_entity_id    uuid REFERENCES entities,
  status                   text DEFAULT 'open'
                           CHECK (status IN ('open','in_progress','completed','cancelled')),
  movement_type            text DEFAULT 'domestic'
                           CHECK (movement_type IN ('domestic','export','blended')),
  total_legs               integer DEFAULT 0,
  total_pi_value           bigint DEFAULT 0,
  total_inv_value          bigint DEFAULT 0,
  total_margin             bigint DEFAULT 0,
  notes                    text,
  is_deleted               boolean DEFAULT false,
  created_at               timestamptz DEFAULT now(),
  created_by               uuid REFERENCES profiles,
  updated_at               timestamptz DEFAULT now()
);

-- ── 10. order_sequence ───────────────────────────────────────────────────
CREATE TABLE order_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_year_id uuid REFERENCES financial_years NOT NULL UNIQUE,
  last_sequence     integer DEFAULT 0
);

-- Seed sequences for existing FYs
INSERT INTO order_sequence (financial_year_id, last_sequence)
SELECT id, 0 FROM financial_years;

-- Function to generate next order number
CREATE OR REPLACE FUNCTION next_order_no(fy_id uuid)
RETURNS text AS $$
DECLARE
  fy_code text;
  seq     integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  UPDATE order_sequence SET last_sequence = last_sequence + 1
  WHERE financial_year_id = fy_id
  RETURNING last_sequence INTO seq;
  RETURN 'ORD-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── 11. order_legs ───────────────────────────────────────────────────────
CREATE TABLE order_legs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid REFERENCES orders NOT NULL,
  leg_no          integer NOT NULL,
  from_entity_id  uuid REFERENCES entities NOT NULL,
  to_entity_id    uuid REFERENCES entities NOT NULL,
  leg_type        text DEFAULT 'domestic' CHECK (leg_type IN ('domestic','export')),
  is_interstate   boolean NOT NULL DEFAULT false,
  movement_status text DEFAULT 'pending'
                  CHECK (movement_status IN ('pending','in_transit','delivered')),
  cargo_status    text DEFAULT 'awaiting_cargo',
  dispatch_date   date,
  delivery_date   date,
  pi_value        bigint DEFAULT 0,
  invoice_value   bigint DEFAULT 0,
  margin_value    bigint DEFAULT 0,
  margin_pct      numeric(5,2),
  notes           text,
  created_at      timestamptz DEFAULT now(),
  created_by      uuid REFERENCES profiles,
  UNIQUE(order_id, leg_no)
);

-- ── 12. leg_stock_items ──────────────────────────────────────────────────
CREATE TABLE leg_stock_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leg_id              uuid REFERENCES order_legs NOT NULL,
  product_id          uuid REFERENCES products,
  description         text NOT NULL,
  hsn_code            text NOT NULL,
  unit                text NOT NULL DEFAULT 'Nos',
  qty_from_prev_leg   numeric(15,3) DEFAULT 0,
  qty_from_inventory  numeric(15,3) DEFAULT 0,
  qty_removed         numeric(15,3) DEFAULT 0,
  qty_forwarded       numeric(15,3) NOT NULL,
  prev_leg_cost       bigint DEFAULT 0,
  inventory_cost      bigint DEFAULT 0,
  blended_cost        bigint NOT NULL,
  margin_pct          numeric(7,4) NOT NULL DEFAULT 0,
  sell_rate           bigint NOT NULL,
  gst_rate            numeric(5,2) NOT NULL DEFAULT 0,
  taxable_amount      bigint NOT NULL DEFAULT 0,
  cgst_rate           numeric(5,2) DEFAULT 0,
  cgst_amount         bigint DEFAULT 0,
  sgst_rate           numeric(5,2) DEFAULT 0,
  sgst_amount         bigint DEFAULT 0,
  igst_rate           numeric(5,2) DEFAULT 0,
  igst_amount         bigint DEFAULT 0,
  total_amount        bigint NOT NULL DEFAULT 0,
  line_no             integer NOT NULL,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- ── 13. leg_document_checklist ───────────────────────────────────────────
CREATE TABLE leg_document_checklist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leg_id      uuid REFERENCES order_legs NOT NULL,
  doc_slot    text NOT NULL,
  doc_label   text NOT NULL,
  slot_order  integer NOT NULL,
  status      text DEFAULT 'pending' CHECK (status IN ('pending','uploaded','na')),
  document_id uuid,
  na_reason   text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  updated_by  uuid REFERENCES profiles,
  UNIQUE(leg_id, doc_slot)
);

-- ── 14. documents ────────────────────────────────────────────────────────
CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid REFERENCES entities NOT NULL,
  leg_id          uuid REFERENCES order_legs,
  doc_slot        text NOT NULL,
  doc_label       text,
  source_type     text,
  source_id       uuid,
  drive_file_id   text NOT NULL,
  drive_url       text NOT NULL,
  file_name       text NOT NULL,
  file_size_bytes integer,
  mime_type       text DEFAULT 'application/pdf',
  doc_no          text,
  doc_date        date,
  doc_amount      bigint,
  notes           text,
  uploaded_at     timestamptz DEFAULT now(),
  uploaded_by     uuid REFERENCES profiles
);

-- Add FK from checklist to documents
ALTER TABLE leg_document_checklist
  ADD CONSTRAINT fk_checklist_document
  FOREIGN KEY (document_id) REFERENCES documents(id);

-- ── 15. audit_log ────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid REFERENCES entities,
  user_id     uuid REFERENCES profiles NOT NULL,
  action      text NOT NULL,
  table_name  text NOT NULL,
  record_id   uuid NOT NULL,
  record_no   text,
  changes     jsonb,
  created_at  timestamptz DEFAULT now()
);

-- ── 16. notifications ────────────────────────────────────────────────────
CREATE TABLE notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES profiles NOT NULL,
  title             text NOT NULL,
  message           text NOT NULL,
  notification_type text NOT NULL,
  source_type       text,
  source_id         uuid,
  entity_id         uuid REFERENCES entities,
  is_read           boolean DEFAULT false,
  is_dismissed      boolean DEFAULT false,
  due_date          date,
  created_at        timestamptz DEFAULT now()
);

-- ── INDEXES ──────────────────────────────────────────────────────────────
CREATE INDEX idx_entities_group ON entities(group_id);
CREATE INDEX idx_entities_type ON entities(type) WHERE is_deleted = false;
CREATE INDEX idx_uea_user ON user_entity_access(user_id);
CREATE INDEX idx_uea_entity ON user_entity_access(entity_id);
CREATE INDEX idx_orders_fy ON orders(financial_year_id, status);
CREATE INDEX idx_orders_no ON orders(order_no);
CREATE INDEX idx_legs_order ON order_legs(order_id, leg_no);
CREATE INDEX idx_leg_stock ON leg_stock_items(leg_id);
CREATE INDEX idx_checklist_leg ON leg_document_checklist(leg_id, status);
CREATE INDEX idx_docs_leg ON documents(leg_id, doc_slot);
CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at);
CREATE INDEX idx_audit_record ON audit_log(table_name, record_id);
CREATE INDEX idx_stock_entity ON stock_movements(entity_id, product_id, posting_date);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_entity_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_opening_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE leg_stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE leg_document_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Helper: check entity access
CREATE OR REPLACE FUNCTION user_has_entity_access(entity_uuid uuid)
RETURNS boolean AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master') THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM user_entity_access
    WHERE user_id = auth.uid() AND entity_id = entity_uuid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Profiles: users see own profile, master sees all
CREATE POLICY "profiles_select" ON profiles FOR SELECT
  USING (id = auth.uid() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master'));
CREATE POLICY "profiles_update" ON profiles FOR UPDATE
  USING (id = auth.uid());

-- Entity groups: all authenticated users can read
CREATE POLICY "entity_groups_select" ON entity_groups FOR SELECT TO authenticated USING (true);
CREATE POLICY "entity_groups_write" ON entity_groups FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master'));

-- Entities: master sees all, others see assigned
CREATE POLICY "entities_select" ON entities FOR SELECT
  USING (user_has_entity_access(id) OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master'));
CREATE POLICY "entities_write" ON entities FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('master', 'entity_user')));

-- Financial years: all authenticated users can read
CREATE POLICY "fy_select" ON financial_years FOR SELECT TO authenticated USING (true);

-- Products: all authenticated users can read
CREATE POLICY "products_select" ON products FOR SELECT TO authenticated USING (true);
CREATE POLICY "products_write" ON products FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('master', 'entity_user')));

-- User entity access: master manages, users see own
CREATE POLICY "uea_select" ON user_entity_access FOR SELECT
  USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master'));
CREATE POLICY "uea_write" ON user_entity_access FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master'));

-- Stock
CREATE POLICY "stock_ob_access" ON stock_opening_balance FOR ALL
  USING (user_has_entity_access(entity_id));
CREATE POLICY "stock_mov_access" ON stock_movements FOR ALL
  USING (user_has_entity_access(entity_id));

-- Orders
CREATE POLICY "orders_select" ON orders FOR SELECT
  USING (
    user_has_entity_access(origin_entity_id) OR
    user_has_entity_access(destination_entity_id) OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master')
  );
CREATE POLICY "orders_write" ON orders FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('master','entity_user')));

-- Order legs, stock items, checklist, documents
CREATE POLICY "legs_access" ON order_legs FOR ALL
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id AND (
    user_has_entity_access(o.origin_entity_id) OR
    user_has_entity_access(o.destination_entity_id) OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master')
  )));
CREATE POLICY "leg_stock_access" ON leg_stock_items FOR ALL
  USING (EXISTS (SELECT 1 FROM order_legs l JOIN orders o ON o.id = l.order_id WHERE l.id = leg_id));
CREATE POLICY "checklist_access" ON leg_document_checklist FOR ALL
  USING (EXISTS (SELECT 1 FROM order_legs WHERE id = leg_id));
CREATE POLICY "documents_access" ON documents FOR ALL
  USING (user_has_entity_access(entity_id));

-- Notifications: users see own
CREATE POLICY "notif_select" ON notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "notif_update" ON notifications FOR UPDATE USING (user_id = auth.uid());

-- Audit: master sees all, others see their entity
CREATE POLICY "audit_select" ON audit_log FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'master') OR
    user_id = auth.uid()
  );
CREATE POLICY "audit_insert" ON audit_log FOR INSERT WITH CHECK (user_id = auth.uid());
