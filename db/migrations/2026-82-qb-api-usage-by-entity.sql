-- November 2026 "QuickBooks API consumption root-cause investigation"
-- follow-up: official Intuit Developer Portal usage data (500,766 CorePlus
-- calls/30 days — query/invoice 201,180, query/payment 201,175, Customer
-- 98,285) confirmed the dominant cost was lib/qbInboundSync.js#syncAllMappedCustomers's
-- per-customer, non-incremental Invoice/Payment full-refetch loop, run on
-- every reconciliation tick. qb_api_usage_monthly (migration 2026-80) gave
-- only ONE aggregate monthly number — no way to see WHICH entity/subsystem
-- is driving usage, no daily granularity, no projected end-of-month figure.
--
-- `qb_api_usage_by_entity_daily` — one row per (date, entity, subsystem),
-- incremented atomically alongside the existing monthly total (never
-- replacing it — lib/qbApiUsageTracker.js writes both from the same single
-- call site, lib/qbTokenManager.js#qbApiRequest, so the two can never
-- diverge). `entity` is the QuickBooks entity name the call targeted
-- (Invoice, Payment, Customer, Estimate, CompanyInfo, or a '+'-joined list
-- for a single multi-entity CDC call, e.g. 'Invoice+Payment') and
-- `subsystem` is HOW it was called (query, cdc, direct_get, batch) — both
-- classified from the real request URL at the one canonical call site, see
-- lib/qbApiUsageTracker.js#classifyQbCallUrl. 'unknown'/'unknown' is a
-- valid, intentionally-logged fallback for any future call shape this
-- classifier doesn't yet recognize — never silently dropped from the count.
CREATE TABLE IF NOT EXISTS qb_api_usage_by_entity_daily (
  call_date DATE NOT NULL,
  entity TEXT NOT NULL,
  subsystem TEXT NOT NULL,
  call_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (call_date, entity, subsystem)
);
CREATE INDEX IF NOT EXISTS idx_qb_api_usage_by_entity_daily_date ON qb_api_usage_by_entity_daily(call_date);
