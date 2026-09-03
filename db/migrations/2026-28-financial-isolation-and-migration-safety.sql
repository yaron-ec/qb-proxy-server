-- =====================================================================
-- 2026-28-financial-isolation-and-migration-safety.sql
--
-- Two concerns:
--   1. FINANCIAL SALE ISOLATION — index invoices.deal_id for sale-scoped
--      financial queries. The column already exists (2026-14) with
--      FK REFERENCES deals(id) ON DELETE SET NULL, but had no index.
--      Without an index, every sale-scoped invoice lookup does a full scan.
--
--   2. MIGRATION SAFETY — schema_migrations table + advisory lock support.
--      Tracks which migrations have been applied so db/migrate.js can skip
--      already-applied files and prevent concurrent migration corruption.
--
-- Idempotent (IF NOT EXISTS). Safe to re-run.
-- =====================================================================

-- ── 1. Financial isolation: index on invoices.deal_id ──────────────────
-- Every sale-scoped financial query (GET /api/v1/deals/:id/financials,
-- GET /api/v1/invoices?deal_id=...) filters by deal_id. Without an index
-- these are full scans.
CREATE INDEX IF NOT EXISTS invoices_deal_id_idx ON invoices (deal_id) WHERE deal_id IS NOT NULL;

-- ── 2. Migration safety: schema_migrations table ────────────────────────
-- Tracks which migration files have been applied. db/migrate.js inserts
-- a row after each file succeeds, and skips files that already have a row.
-- This prevents destructive re-execution and provides an audit trail.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename     TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum     TEXT
);

-- ── 3. Financial isolation: qb_invoice_sale_map already has indexes ─────
-- (qb_invoice_sale_map_sale_idx, qb_invoice_sale_map_lead_idx from 2026-10)
-- No additional indexes needed — the ownership query is already indexed.

-- ── 4. Financial isolation: deal_expenses, deal_commissions, ────────────
-- deal_loan_payments already have deal_id UUID FK indexes from 2026-14.
-- No additional indexes needed.