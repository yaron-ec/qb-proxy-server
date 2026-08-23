-- =====================================================================
-- Lead Contact Fields Migration — 2026-13
--
-- Adds `state` column to the leads table (not present in the original
-- booking-core schema) and creates indexes on email/phone for fast
-- duplicate checking during contact-info updates.
--
-- Idempotent (IF NOT EXISTS). Safe to re-run.
-- Applied via: node db/migrate.js
-- =====================================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS state TEXT;

-- Indexes for duplicate detection (contact-info update conflict checks)
CREATE INDEX IF NOT EXISTS leads_email_lower_idx
  ON leads (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_phone_idx
  ON leads (phone) WHERE phone IS NOT NULL;