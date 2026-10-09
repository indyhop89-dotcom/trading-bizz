-- ============================================================================
-- 063_entity_document_numbering.sql
--
-- Entity-wise document numbering. Each entity can set its own number format
-- for Sales Invoice, Purchase Order, Proforma Invoice and Service Invoice:
-- prefix, financial-year style, separator, starting number, padding, optional
-- suffix, and whether the sequence restarts every financial year.
--
-- Stored as one JSON value per entity, e.g.
--   { "sales_invoice": { "enabled": true, "prefix": "KV", "fy_format": "YY-YY",
--                        "separator": "/", "start": 1, "padding": 4,
--                        "suffix": "", "reset_each_fy": true }, "po": { ... } }
--   → KV/26-27/0001
--
--   * One optional column. NULL (every existing entity) = keep numbering new
--     documents exactly as today (SHORTNAME-2627-001).
--   * No existing document number is changed — the format is only used when a
--     new document is created with its number left blank.
--   * Idempotent — safe to run again.
-- ============================================================================

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS numbering jsonb;

NOTIFY pgrst, 'reload schema';
