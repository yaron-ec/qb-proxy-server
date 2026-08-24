-- =====================================================================
-- 2026-10-qb-invoice-sale-map.down.sql
-- Reverses 2026-10-qb-invoice-sale-map.sql. Manual-only. Never auto-applied.
--
-- DATA LOSS: destroys qb_invoice_sale_map + qb_invoices_cache and ALL their
-- data, including every sale→invoice ownership mapping. This rollback is
-- intended ONLY to undo a failed/empty apply (before any production backfill).
-- If real mapping rows exist, EXPORT FIRST — rollback destroys them.
--
-- RECOMMENDED ROLLBACK WINDOW:
--   SAFE   : Anytime before production backfill writes mappings (zero loss).
--   UNSAFE : After mappings exist (full loss of ownership data).
--
-- IDEMPOTENT: every statement uses IF EXISTS. Safe to re-run.
-- =====================================================================

-- 2. qb_invoices_cache
DROP TRIGGER IF EXISTS qb_invoices_cache_set_updated_at ON qb_invoices_cache;
DROP TABLE IF EXISTS qb_invoices_cache;
DROP FUNCTION IF EXISTS qb_invoices_cache_touch_updated_at();

-- 1. qb_invoice_sale_map
DROP TRIGGER IF EXISTS qb_invoice_sale_map_set_updated_at ON qb_invoice_sale_map;
DROP TABLE IF EXISTS qb_invoice_sale_map;
DROP FUNCTION IF EXISTS qb_invoice_sale_map_touch_updated_at();