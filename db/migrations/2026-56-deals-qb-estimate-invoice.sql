-- =====================================================================
-- 2026-56: Deal-level QuickBooks Estimate tracking (CRM STABILITY PHASE,
-- completion pass, Section B).
--
-- QB Invoice ownership already has a canonical, deal-scoped mechanism
-- (qb_invoice_sale_map, migration 2026-10) — real Invoice creation
-- (lib/qbEstimateInvoice.js) writes into that existing table, never a new
-- one, so multi-project attribution (lib/customerPaymentWaterfall.js) and
-- payment resolution are never regressed.
--
-- QB Estimates have no equivalent per-deal tracking yet — the existing
-- `estimates` and `handoff_estimates` tables are a different, pre-existing
-- entity (the CRM/Handoff estimate BUILDER, which CLAUDE.md requires stays
-- the authoritative estimate-building surface; this migration does not
-- touch either table). A QB Estimate created directly from a Deal (e.g. to
-- hand a customer a formal QuickBooks quote once a Handoff estimate is
-- approved) needs its own deal-scoped identity so a double-click/retry
-- never creates two QB Estimates for the same Deal.
--
-- Startup-safe: additive columns only, ADD COLUMN IF NOT EXISTS.
-- =====================================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS qb_estimate_id TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS qb_estimate_number TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS qb_estimate_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS deals_qb_estimate_id_idx
  ON deals (qb_estimate_id) WHERE qb_estimate_id IS NOT NULL;
