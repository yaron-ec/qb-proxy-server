-- November 2026 "QuickBooks API quota management and long-term scalability"
-- CRM reliability request, following the confirmed monthly CorePlus quota
-- exhaustion incident (PR #81). Two additive, independent tables:
--
-- `qb_api_usage_monthly` — a durable, cross-process-safe counter of every
-- REAL outbound HTTP request this backend actually sends to Intuit's API
-- (lib/qbTokenManager.js#qbApiRequest, the ONE canonical path every QB data
-- call goes through — see that file's own header). Explicitly LOCALLY
-- MEASURED, never a substitute for Intuit's own authoritative usage figure
-- (Intuit exposes a real usage chart only via the Developer Portal UI, to
-- Workspace Owners/Admins, with no programmatic API this codebase could
-- poll — confirmed via Intuit's own documentation during this audit). One
-- row per calendar month (`month_key`, e.g. '2026-11' — matches Intuit's
-- own calendar-month quota reset, not a rolling 30-day window, per Intuit's
-- documented "all further CorePlus API calls will be blocked until the
-- following month" behavior). `call_count` is incremented via a single
-- atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (see
-- lib/qbApiUsageTracker.js) so concurrent requests across multiple
-- processes/replicas never race a lost-update. The three
-- `threshold_*_alerted_at` columns are the dedup marker for the 70/85/95%
-- early-warning emails — each fires at most once per threshold per month.
CREATE TABLE IF NOT EXISTS qb_api_usage_monthly (
  month_key TEXT PRIMARY KEY,
  call_count BIGINT NOT NULL DEFAULT 0,
  first_call_at TIMESTAMPTZ,
  last_call_at TIMESTAMPTZ,
  threshold_70_alerted_at TIMESTAMPTZ,
  threshold_85_alerted_at TIMESTAMPTZ,
  threshold_95_alerted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `qb_customer_metadata_cache` — a durable, TTL-based cache of QB Customer
-- display name / email / phone, keyed by `qb_customer_id`. This is PURE
-- enrichment data used only for CRM lead-matching display fields — never
-- the authoritative financial data (invoices/payments/estimates, which are
-- always fetched fresh on every sync, unaffected by this cache). Found
-- during this audit: server.js's QB Estimate Sync cron (every 15 minutes)
-- and lib/qbSyncTrigger.js's webhook-triggered sync both re-fetched full
-- customer records from Intuit on every single run with ZERO cross-run
-- caching (the in-process cache in the former is recreated fresh on every
-- tick; the latter had no caching at all, not even within one run) —
-- against ~100 mapped customers, every 15-minute tick, this alone projects
-- to roughly 290K calls/month, a second major contributor to the same
-- monthly-quota exhaustion incident alongside the already-addressed
-- inbound-reconciliation cron. A customer's display name/email/phone
-- changes rarely, so a bounded TTL cache (lib/qbCustomerCache.js, default
-- 24h, configurable) eliminates the overwhelming majority of these calls
-- with no loss of estimate-sync freshness (the estimate data itself is
-- untouched by this cache).
CREATE TABLE IF NOT EXISTS qb_customer_metadata_cache (
  qb_customer_id TEXT PRIMARY KEY,
  display_name TEXT,
  email TEXT,
  phone TEXT,
  raw_customer JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qb_customer_metadata_cache_fetched_at ON qb_customer_metadata_cache(fetched_at);
