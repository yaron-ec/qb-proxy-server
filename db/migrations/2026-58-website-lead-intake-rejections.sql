-- 2026-58-website-lead-intake-rejections.sql
--
-- CRM PRODUCTION reliability audit (website lead intake investigation):
-- closes a real observability gap. Before this, a rejected delivery attempt
-- (missing/mismatched x-webhook-secret, or the module disabled) left NO
-- trace anywhere — not a log line, not a row. website_lead_receipts only
-- ever gets a row AFTER the secret check passes, so "0 total received" in
-- System Health was indistinguishable from "the website never attempted a
-- single delivery" versus "the website has been trying and getting
-- rejected the whole time" (e.g. a secret rotated on one side but not the
-- other). This table records every rejection (never the secret value
-- itself, never customer data) so that distinction becomes visible.
--
-- Startup-safe: additive table only, no existing table touched.

CREATE TABLE IF NOT EXISTS website_lead_intake_rejections (
  id          BIGSERIAL PRIMARY KEY,
  reason      TEXT NOT NULL,              -- 'not_configured' | 'unauthorized'
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS website_lead_intake_rejections_received_at_idx
  ON website_lead_intake_rejections (received_at);
