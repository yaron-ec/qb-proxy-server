-- =====================================================================
-- 2026-25-leads-google-contact-fields.sql
--
-- Adds Google Contact sync state columns to the leads table.
--
-- These are per-lead fields with NO canonical Railway representation.
-- The GoogleContactSyncPanel frontend reads:
--   lead.google_contact_sync_status   ('synced', 'error', 'pending')
--   lead.google_contact_resource_name (Google People API resource name)
--   lead.google_contact_sync_error    (last error message)
--
-- The sync-contact endpoint (POST /by-external/:externalRef/sync-contact)
-- writes these columns after a successful Google People API call.
--
-- Without these columns, the UPDATE leads SET google_contact_sync_status = ...
-- statement fails with "column does not exist" — the same class of defect
-- as the google_calendar_sync_status column that was never added.
--
-- Idempotent (IF NOT EXISTS). Safe to re-run.
-- Applied via: node db/migrate.js
-- =====================================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_contact_sync_status TEXT
  CHECK (google_contact_sync_status IS NULL
         OR google_contact_sync_status IN ('synced', 'error', 'pending'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_contact_resource_name TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_contact_sync_error TEXT;