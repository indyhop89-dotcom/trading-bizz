-- ─── Fix documents table (entity_id nullable since we may not always have one) ─
ALTER TABLE documents ALTER COLUMN entity_id DROP NOT NULL;
ALTER TABLE documents ALTER COLUMN drive_file_id DROP NOT NULL;
ALTER TABLE documents ALTER COLUMN drive_url DROP NOT NULL;
ALTER TABLE documents ALTER COLUMN file_name DROP NOT NULL;

-- ─── Credit / Debit Notes ─────────────────────────────────────────────────────
-- Tables already created in 004, just verify they exist
-- (credit_debit_notes and credit_debit_note_lines were in 004_accounting_tables.sql)

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES profiles,
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

ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_type ON notifications(notification_type, is_read);

-- ─── Stock opening balance — fix rate column to numeric ──────────────────────
ALTER TABLE stock_opening_balance
  ALTER COLUMN rate TYPE numeric(15,2) USING ROUND(rate::numeric, 2);

-- ─── Products — fix default_rate to numeric ───────────────────────────────────
ALTER TABLE products
  ALTER COLUMN default_rate TYPE numeric(15,2) USING ROUND(default_rate::numeric, 2);
