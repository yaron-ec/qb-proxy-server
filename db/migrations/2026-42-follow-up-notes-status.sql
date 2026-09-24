-- 2026-42-follow-up-notes-status.sql
--
-- Follow-Up / Next Update is independent of the Appointment (appointments
-- table). The follow-up model gains notes + status so New Lead and Lead Detail
-- can capture a complete next action.
--
-- Startup-safe: nullable columns (no default, no table rewrite, no backfill)
-- and CHECK constraints added NOT VALID (no scan of existing rows). Existing
-- rows keep NULL notes/status (UI treats a dated follow-up with NULL status as
-- 'pending').

ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_notes TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_status TEXT;

-- Widen the follow-up type list (2026-09-crm-core allowed only 'Phone Call' /
-- 'Meeting'). NOT VALID: existing rows are not re-scanned at startup (no
-- lock-heavy validation, no startup failure on legacy values); new writes are
-- checked. The list mirrors lib/followUp.js FOLLOW_UP_TYPES.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_follow_up_type_check;
ALTER TABLE leads ADD CONSTRAINT leads_follow_up_type_check
  CHECK (follow_up_type IS NULL OR follow_up_type IN ('Phone Call','Text','Email','Meeting','Other')) NOT VALID;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_follow_up_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_follow_up_status_check
  CHECK (follow_up_status IS NULL OR follow_up_status IN ('pending','completed')) NOT VALID;

-- Reminder projection carries the canonical appointment's kind so customer
-- reminders are keyed to the real appointment (Meeting vs Phone Call) rather
-- than to the lead's follow-up. Nullable, no default: startup-safe.
ALTER TABLE reminder_leads ADD COLUMN IF NOT EXISTS appointment_type TEXT;
