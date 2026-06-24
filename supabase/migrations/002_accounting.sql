-- Trading Bizz — Migration 002: Accounting & Operations Tables
-- Run this in Supabase SQL Editor AFTER 001_phase1.sql

-- ── 1. proforma_invoices ──────────────────────────────────────────────────
CREATE TABLE proforma_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pi_no               text NOT NULL,
  order_id            uuid REFERENCES orders,
  leg_id              uuid REFERENCES order_legs,
  from_entity_id      uuid REFERENCES entities NOT NULL,
  to_entity_id        uuid REFERENCES entities NOT NULL,
  financial_year_id   uuid REFERENCES financial_years NOT NULL,
  pi_date             date NOT NULL,
  valid_upto          date,
  is_interstate       boolean NOT NULL DEFAULT false,
  taxable_amount      bigint DEFAULT 0,
  cgst_amount         bigint DEFAULT 0,
  sgst_amount         bigint DEFAULT 0,
  igst_amount         bigint DEFAULT 0,
  total_amount        bigint DEFAULT 0,
  status              text DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','accepted','converted','cancelled')),
  converted_to_invoice_id uuid,
  notes               text,
  drive_file_id       text,
  drive_url           text,
  file_name           text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles,
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE proforma_invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pi_id           uuid REFERENCES proforma_invoices NOT NULL ON DELETE CASCADE,
  line_no         integer NOT NULL,
  product_id      uuid REFERENCES products,
  description     text NOT NULL,
  hsn_code        text NOT NULL,
  qty             numeric(15,3) NOT NULL,
  unit            text NOT NULL,
  rate            bigint NOT NULL,
  gst_rate        numeric(5,2) NOT NULL DEFAULT 0,
  taxable_amount  bigint NOT NULL DEFAULT 0,
  cgst_rate       numeric(5,2) DEFAULT 0,
  cgst_amount     bigint DEFAULT 0,
  sgst_rate       numeric(5,2) DEFAULT 0,
  sgst_amount     bigint DEFAULT 0,
  igst_rate       numeric(5,2) DEFAULT 0,
  igst_amount     bigint DEFAULT 0,
  total_amount    bigint NOT NULL DEFAULT 0
);

-- PI sequence per entity per FY
CREATE TABLE pi_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  last_sequence     integer DEFAULT 0,
  UNIQUE(entity_id, financial_year_id)
);

CREATE OR REPLACE FUNCTION next_pi_no(ent_id uuid, fy_id uuid)
RETURNS text AS $$
DECLARE
  fy_code   text;
  ent_short text;
  seq       integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  SELECT COALESCE(short_name, UPPER(LEFT(name,3))) INTO ent_short FROM entities WHERE id = ent_id;
  INSERT INTO pi_sequence (entity_id, financial_year_id, last_sequence)
  VALUES (ent_id, fy_id, 1)
  ON CONFLICT (entity_id, financial_year_id)
  DO UPDATE SET last_sequence = pi_sequence.last_sequence + 1
  RETURNING last_sequence INTO seq;
  RETURN 'PI-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── 2. purchase_orders ────────────────────────────────────────────────────
CREATE TABLE purchase_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no               text NOT NULL,
  order_id            uuid REFERENCES orders,
  leg_id              uuid REFERENCES order_legs,
  pi_id               uuid REFERENCES proforma_invoices,
  buyer_entity_id     uuid REFERENCES entities NOT NULL,
  seller_entity_id    uuid REFERENCES entities NOT NULL,
  financial_year_id   uuid REFERENCES financial_years NOT NULL,
  po_date             date NOT NULL,
  delivery_date       date,
  is_interstate       boolean NOT NULL DEFAULT false,
  taxable_amount      bigint DEFAULT 0,
  cgst_amount         bigint DEFAULT 0,
  sgst_amount         bigint DEFAULT 0,
  igst_amount         bigint DEFAULT 0,
  total_amount        bigint DEFAULT 0,
  status              text DEFAULT 'open'
                      CHECK (status IN ('open','partial','completed','cancelled')),
  notes               text,
  drive_file_id       text,
  drive_url           text,
  file_name           text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles,
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE purchase_order_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id           uuid REFERENCES purchase_orders NOT NULL ON DELETE CASCADE,
  line_no         integer NOT NULL,
  product_id      uuid REFERENCES products,
  description     text NOT NULL,
  hsn_code        text NOT NULL,
  qty             numeric(15,3) NOT NULL,
  unit            text NOT NULL,
  rate            bigint NOT NULL,
  gst_rate        numeric(5,2) NOT NULL DEFAULT 0,
  taxable_amount  bigint NOT NULL DEFAULT 0,
  cgst_rate       numeric(5,2) DEFAULT 0,
  cgst_amount     bigint DEFAULT 0,
  sgst_rate       numeric(5,2) DEFAULT 0,
  sgst_amount     bigint DEFAULT 0,
  igst_rate       numeric(5,2) DEFAULT 0,
  igst_amount     bigint DEFAULT 0,
  total_amount    bigint NOT NULL DEFAULT 0,
  qty_received    numeric(15,3) DEFAULT 0
);

CREATE TABLE po_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  last_sequence     integer DEFAULT 0,
  UNIQUE(entity_id, financial_year_id)
);

CREATE OR REPLACE FUNCTION next_po_no(ent_id uuid, fy_id uuid)
RETURNS text AS $$
DECLARE
  fy_code text;
  seq     integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  INSERT INTO po_sequence (entity_id, financial_year_id, last_sequence)
  VALUES (ent_id, fy_id, 1)
  ON CONFLICT (entity_id, financial_year_id)
  DO UPDATE SET last_sequence = po_sequence.last_sequence + 1
  RETURNING last_sequence INTO seq;
  RETURN 'PO-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── 3. invoices ───────────────────────────────────────────────────────────
CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no          text NOT NULL,
  invoice_type        text NOT NULL DEFAULT 'sales'
                      CHECK (invoice_type IN ('sales','purchase','intercompany')),
  source_invoice_id   uuid REFERENCES invoices,   -- for auto-created purchase side
  order_id            uuid REFERENCES orders,
  leg_id              uuid REFERENCES order_legs,
  pi_id               uuid REFERENCES proforma_invoices,
  po_id               uuid REFERENCES purchase_orders,
  seller_entity_id    uuid REFERENCES entities NOT NULL,
  buyer_entity_id     uuid REFERENCES entities NOT NULL,
  financial_year_id   uuid REFERENCES financial_years NOT NULL,
  invoice_date        date NOT NULL,
  due_date            date,
  is_interstate       boolean NOT NULL DEFAULT false,
  place_of_supply     text,
  -- E-invoice
  einvoice_irn        text,
  einvoice_ack_no     text,
  einvoice_ack_date   date,
  einvoice_qr_code    text,
  -- Totals (paise)
  taxable_amount      bigint DEFAULT 0,
  cgst_amount         bigint DEFAULT 0,
  sgst_amount         bigint DEFAULT 0,
  igst_amount         bigint DEFAULT 0,
  tds_amount          bigint DEFAULT 0,
  tcs_amount          bigint DEFAULT 0,
  total_amount        bigint DEFAULT 0,
  paid_amount         bigint DEFAULT 0,
  outstanding_amount  bigint DEFAULT 0,
  status              text DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','paid','partial','cancelled')),
  notes               text,
  drive_file_id       text,
  drive_url           text,
  file_name           text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles,
  updated_at          timestamptz DEFAULT now(),
  submitted_at        timestamptz,
  submitted_by        uuid REFERENCES profiles
);

CREATE TABLE invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid REFERENCES invoices NOT NULL ON DELETE CASCADE,
  line_no         integer NOT NULL,
  product_id      uuid REFERENCES products,
  description     text NOT NULL,
  hsn_code        text NOT NULL,
  qty             numeric(15,3) NOT NULL,
  unit            text NOT NULL,
  rate            bigint NOT NULL,
  gst_rate        numeric(5,2) NOT NULL DEFAULT 0,
  taxable_amount  bigint NOT NULL DEFAULT 0,
  cgst_rate       numeric(5,2) DEFAULT 0,
  cgst_amount     bigint DEFAULT 0,
  sgst_rate       numeric(5,2) DEFAULT 0,
  sgst_amount     bigint DEFAULT 0,
  igst_rate       numeric(5,2) DEFAULT 0,
  igst_amount     bigint DEFAULT 0,
  total_amount    bigint NOT NULL DEFAULT 0
);

CREATE TABLE tds_tcs_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            uuid REFERENCES invoices NOT NULL,
  entry_type            text NOT NULL CHECK (entry_type IN ('tds','tcs')),
  section_code          text NOT NULL,
  section_desc          text,
  deducted_by_entity_id uuid REFERENCES entities NOT NULL,
  deductee_entity_id    uuid REFERENCES entities NOT NULL,
  base_amount           bigint NOT NULL,
  rate                  numeric(5,2) NOT NULL,
  amount                bigint NOT NULL,
  payment_date          date,
  challan_no            text,
  is_paid               boolean DEFAULT false,
  created_at            timestamptz DEFAULT now()
);

CREATE TABLE inv_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  last_sequence     integer DEFAULT 0,
  UNIQUE(entity_id, financial_year_id)
);

CREATE OR REPLACE FUNCTION next_inv_no(ent_id uuid, fy_id uuid)
RETURNS text AS $$
DECLARE
  fy_code text;
  seq     integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  INSERT INTO inv_sequence (entity_id, financial_year_id, last_sequence)
  VALUES (ent_id, fy_id, 1)
  ON CONFLICT (entity_id, financial_year_id)
  DO UPDATE SET last_sequence = inv_sequence.last_sequence + 1
  RETURNING last_sequence INTO seq;
  RETURN 'INV-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── 4. expenses ───────────────────────────────────────────────────────────
CREATE TABLE expenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_no          text NOT NULL,
  entity_id           uuid REFERENCES entities NOT NULL,
  order_id            uuid REFERENCES orders,
  leg_id              uuid REFERENCES order_legs,
  financial_year_id   uuid REFERENCES financial_years NOT NULL,
  expense_date        date NOT NULL,
  category            text NOT NULL DEFAULT 'other'
                      CHECK (category IN (
                        'transport','labour','freight','loading_unloading',
                        'brokerage','bank_charges','duty_tax','insurance',
                        'office','professional','repair','other'
                      )),
  description         text NOT NULL,
  amount              bigint NOT NULL,
  gst_rate            numeric(5,2) DEFAULT 0,
  gst_amount          bigint DEFAULT 0,
  total_amount        bigint NOT NULL,
  vendor_entity_id    uuid REFERENCES entities,
  vendor_name         text,
  vendor_gstin        text,
  status              text DEFAULT 'unpaid'
                      CHECK (status IN ('unpaid','paid','cancelled')),
  payment_ref         text,
  notes               text,
  drive_file_id       text,
  drive_url           text,
  file_name           text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles,
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE exp_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  last_sequence     integer DEFAULT 0,
  UNIQUE(entity_id, financial_year_id)
);

CREATE OR REPLACE FUNCTION next_exp_no(ent_id uuid, fy_id uuid)
RETURNS text AS $$
DECLARE
  fy_code text;
  seq     integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  INSERT INTO exp_sequence (entity_id, financial_year_id, last_sequence)
  VALUES (ent_id, fy_id, 1)
  ON CONFLICT (entity_id, financial_year_id)
  DO UPDATE SET last_sequence = exp_sequence.last_sequence + 1
  RETURNING last_sequence INTO seq;
  RETURN 'EXP-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── 5. payments ───────────────────────────────────────────────────────────
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_no          text NOT NULL,
  payment_type        text NOT NULL
                      CHECK (payment_type IN ('receipt','payment','internal_transfer')),
  entity_id           uuid REFERENCES entities NOT NULL,
  party_entity_id     uuid REFERENCES entities,
  party_name          text,
  financial_year_id   uuid REFERENCES financial_years NOT NULL,
  payment_date        date NOT NULL,
  amount              bigint NOT NULL,
  tds_amount          bigint DEFAULT 0,
  tcs_amount          bigint DEFAULT 0,
  net_amount          bigint NOT NULL,
  payment_mode        text NOT NULL DEFAULT 'bank_transfer'
                      CHECK (payment_mode IN ('bank_transfer','cash','cheque','upi','adjustment')),
  bank_account        text,
  reference_no        text,
  reference_date      date,
  status              text DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','cancelled')),
  notes               text,
  drive_file_id       text,
  drive_url           text,
  file_name           text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles,
  submitted_at        timestamptz
);

CREATE TABLE payment_allocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        uuid REFERENCES payments NOT NULL ON DELETE CASCADE,
  allocated_type    text NOT NULL CHECK (allocated_type IN ('invoice','expense','advance')),
  allocated_id      uuid NOT NULL,
  allocated_no      text,
  allocated_amount  bigint NOT NULL,
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE pay_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  last_sequence     integer DEFAULT 0,
  UNIQUE(entity_id, financial_year_id)
);

CREATE OR REPLACE FUNCTION next_pay_no(ent_id uuid, fy_id uuid, pay_type text)
RETURNS text AS $$
DECLARE
  fy_code text;
  prefix  text;
  seq     integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  prefix := CASE pay_type WHEN 'receipt' THEN 'REC' WHEN 'payment' THEN 'PAY' ELSE 'TRF' END;
  INSERT INTO pay_sequence (entity_id, financial_year_id, last_sequence)
  VALUES (ent_id, fy_id, 1)
  ON CONFLICT (entity_id, financial_year_id)
  DO UPDATE SET last_sequence = pay_sequence.last_sequence + 1
  RETURNING last_sequence INTO seq;
  RETURN prefix || '-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── 6. bill_discounting ───────────────────────────────────────────────────
CREATE TABLE bill_discounting (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_no         text NOT NULL,
  entity_id           uuid REFERENCES entities NOT NULL,
  financial_year_id   uuid REFERENCES financial_years NOT NULL,
  bank_name           text NOT NULL,
  bank_branch         text,
  account_no          text,
  invoice_amount      bigint NOT NULL,
  discounted_amount   bigint NOT NULL,
  discount_rate       numeric(5,2),
  discount_charges    bigint DEFAULT 0,
  net_received        bigint NOT NULL,
  disbursement_date   date NOT NULL,
  due_date            date NOT NULL,
  repaid_amount       bigint DEFAULT 0,
  outstanding_amount  bigint DEFAULT 0,
  status              text DEFAULT 'active'
                      CHECK (status IN ('active','partially_repaid','repaid','overdue')),
  notes               text,
  drive_file_id       text,
  drive_url           text,
  file_name           text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles,
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE bill_discounting_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id     uuid REFERENCES bill_discounting NOT NULL ON DELETE CASCADE,
  invoice_id      uuid REFERENCES invoices NOT NULL,
  invoice_amount  bigint NOT NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE bill_discounting_repayments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id     uuid REFERENCES bill_discounting NOT NULL ON DELETE CASCADE,
  repayment_date  date NOT NULL,
  amount          bigint NOT NULL,
  reference_no    text,
  notes           text,
  created_at      timestamptz DEFAULT now(),
  created_by      uuid REFERENCES profiles
);

CREATE TABLE bd_sequence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid REFERENCES entities NOT NULL,
  financial_year_id uuid REFERENCES financial_years NOT NULL,
  last_sequence     integer DEFAULT 0,
  UNIQUE(entity_id, financial_year_id)
);

CREATE OR REPLACE FUNCTION next_bd_no(ent_id uuid, fy_id uuid)
RETURNS text AS $$
DECLARE
  fy_code text;
  seq     integer;
BEGIN
  SELECT code INTO fy_code FROM financial_years WHERE id = fy_id;
  INSERT INTO bd_sequence (entity_id, financial_year_id, last_sequence)
  VALUES (ent_id, fy_id, 1)
  ON CONFLICT (entity_id, financial_year_id)
  DO UPDATE SET last_sequence = bd_sequence.last_sequence + 1
  RETURNING last_sequence INTO seq;
  RETURN 'BD-' || fy_code || '-' || LPAD(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── 7. credit_debit_notes ─────────────────────────────────────────────────
CREATE TABLE credit_debit_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_no             text NOT NULL,
  note_type           text NOT NULL CHECK (note_type IN ('credit_note','debit_note')),
  against_invoice_id  uuid REFERENCES invoices NOT NULL,
  issuer_entity_id    uuid REFERENCES entities NOT NULL,
  receiver_entity_id  uuid REFERENCES entities NOT NULL,
  financial_year_id   uuid REFERENCES financial_years NOT NULL,
  note_date           date NOT NULL,
  reason              text NOT NULL
                      CHECK (reason IN ('return','rate_correction','quantity_correction','other')),
  reason_notes        text,
  is_interstate       boolean NOT NULL DEFAULT false,
  taxable_amount      bigint DEFAULT 0,
  cgst_amount         bigint DEFAULT 0,
  sgst_amount         bigint DEFAULT 0,
  igst_amount         bigint DEFAULT 0,
  total_amount        bigint DEFAULT 0,
  status              text DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','cancelled')),
  drive_file_id       text,
  drive_url           text,
  file_name           text,
  is_deleted          boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  created_by          uuid REFERENCES profiles
);

CREATE TABLE credit_debit_note_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id         uuid REFERENCES credit_debit_notes NOT NULL ON DELETE CASCADE,
  line_no         integer NOT NULL,
  product_id      uuid REFERENCES products,
  description     text NOT NULL,
  hsn_code        text NOT NULL,
  qty             numeric(15,3) NOT NULL,
  unit            text NOT NULL,
  rate            bigint NOT NULL,
  gst_rate        numeric(5,2) NOT NULL DEFAULT 0,
  taxable_amount  bigint NOT NULL DEFAULT 0,
  cgst_amount     bigint DEFAULT 0,
  sgst_amount     bigint DEFAULT 0,
  igst_amount     bigint DEFAULT 0,
  total_amount    bigint NOT NULL DEFAULT 0
);

-- ── INDEXES ───────────────────────────────────────────────────────────────
CREATE INDEX idx_pi_order    ON proforma_invoices(order_id, leg_id);
CREATE INDEX idx_pi_from     ON proforma_invoices(from_entity_id, financial_year_id);
CREATE INDEX idx_pi_status   ON proforma_invoices(status) WHERE is_deleted = false;
CREATE INDEX idx_po_order    ON purchase_orders(order_id, leg_id);
CREATE INDEX idx_po_buyer    ON purchase_orders(buyer_entity_id, financial_year_id);
CREATE INDEX idx_inv_seller  ON invoices(seller_entity_id, invoice_date);
CREATE INDEX idx_inv_buyer   ON invoices(buyer_entity_id, invoice_date);
CREATE INDEX idx_inv_status  ON invoices(status) WHERE is_deleted = false;
CREATE INDEX idx_inv_due     ON invoices(due_date) WHERE status NOT IN ('paid','cancelled');
CREATE INDEX idx_exp_entity  ON expenses(entity_id, expense_date);
CREATE INDEX idx_exp_order   ON expenses(order_id);
CREATE INDEX idx_exp_cat     ON expenses(category, financial_year_id);
CREATE INDEX idx_pay_entity  ON payments(entity_id, payment_date);
CREATE INDEX idx_pay_alloc   ON payment_allocations(allocated_id, allocated_type);
CREATE INDEX idx_bd_entity   ON bill_discounting(entity_id, due_date);
CREATE INDEX idx_bd_status   ON bill_discounting(status) WHERE is_deleted = false;

-- ── DISABLE RLS on new tables (same as 001 fix) ───────────────────────────
ALTER TABLE proforma_invoices        DISABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoice_lines   DISABLE ROW LEVEL SECURITY;
ALTER TABLE pi_sequence              DISABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders          DISABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines     DISABLE ROW LEVEL SECURITY;
ALTER TABLE po_sequence              DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines            DISABLE ROW LEVEL SECURITY;
ALTER TABLE tds_tcs_entries          DISABLE ROW LEVEL SECURITY;
ALTER TABLE inv_sequence             DISABLE ROW LEVEL SECURITY;
ALTER TABLE expenses                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE exp_sequence             DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations      DISABLE ROW LEVEL SECURITY;
ALTER TABLE pay_sequence             DISABLE ROW LEVEL SECURITY;
ALTER TABLE bill_discounting         DISABLE ROW LEVEL SECURITY;
ALTER TABLE bill_discounting_invoices    DISABLE ROW LEVEL SECURITY;
ALTER TABLE bill_discounting_repayments DISABLE ROW LEVEL SECURITY;
ALTER TABLE bd_sequence              DISABLE ROW LEVEL SECURITY;
ALTER TABLE credit_debit_notes       DISABLE ROW LEVEL SECURITY;
ALTER TABLE credit_debit_note_lines  DISABLE ROW LEVEL SECURITY;
