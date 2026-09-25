-- 2026-43-website-lead-intake.sql
--
-- Website → CRM lead intake (routes/websiteLeads.js).
--
-- 1. SMS consent captured by the website's forms is stored on the lead
--    (TCPA record: consent flag, when, which disclosure text version, where).
-- 2. website_lead_receipts records every website delivery by its idempotency
--    reference, so a retried delivery never creates a second lead or a second
--    activity note — including deliveries that were matched to an existing
--    lead (which keeps its own external_ref).
--
-- Startup-safe: nullable columns without defaults (no table rewrite), a new
-- table, IF NOT EXISTS everywhere.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_disclosure_version TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_source TEXT;

CREATE TABLE IF NOT EXISTS website_lead_receipts (
  external_ref  TEXT PRIMARY KEY,
  lead_id       UUID REFERENCES leads(id) ON DELETE SET NULL,
  action        TEXT,
  is_test       BOOLEAN NOT NULL DEFAULT FALSE,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
