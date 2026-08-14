-- =====================================================================
-- Rollback for 2026-11-crm-deals.sql  (MANUAL USE ONLY)
--
-- Drops the Railway-native deals table. DESTRUCTIVE: removes all Sale/Job
-- records stored here. Only run BEFORE any production data is populated,
-- or after a full data export. Never run against a populated production DB.
-- Does NOT touch leads or qb_invoice_sale_map (owned by other migrations).
-- =====================================================================

DROP TRIGGER IF EXISTS deals_set_updated_at ON deals;
DROP FUNCTION IF EXISTS deals_touch_updated_at();
DROP TABLE IF EXISTS deals;