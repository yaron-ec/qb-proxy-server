-- =====================================================================
-- R1A CRM Core Migration — DOWN MIGRATION (ROLLBACK)
-- File: db/rollback/2026-09-crm-core.down.sql
--
-- Reverses db/migrations/2026-09-crm-core.sql.
-- Run manually ONLY. Never auto-applied (lives outside db/migrations/).
--
-- Rollback order: exact reverse of the up migration.
--   1. settings   (no FK dependencies)
--   2. activities (FK -> leads; drop before leads columns)
--   3. leads indexes
--   4. leads columns (reverse order of addition)
--
-- DATA LOSS ASSESSMENT:
--   * leads columns: In R1A the leads endpoints are READ-ONLY, so no
--     values are written to the 12 new columns. Rolling back before R1B
--     begins is LOSSLESS. After R1B (lead writes), column values are lost.
--   * activities: R1A exposes POST /leads/:id/activities. Any activity
--     rows created by users are DESTROYED on rollback. Export first if
--     rollback is needed after activity writes.
--   * settings: singleton seed row only in R1A. No data loss.
--
-- RECOMMENDED ROLLBACK WINDOW:
--   SAFE   : Anytime before R1B begins (zero data loss).
--   CAUTION : After R1B lead writes begin (leads column data lost).
--   UNSAFE  : After users create activities (activity data lost) unless
--             exported first.
--
-- IDEMPOTENT: every statement uses IF EXISTS. Safe to re-run.
-- =====================================================================

-- 1. settings (no FK dependencies; drop first)
DROP TRIGGER IF EXISTS settings_set_updated_at ON settings;
DROP TABLE IF EXISTS settings;
DROP FUNCTION IF EXISTS settings_touch_updated_at();

-- 2. activities (FK -> leads; drop before leads columns)
DROP TRIGGER IF EXISTS activities_set_updated_at ON activities;
DROP TABLE IF EXISTS activities;
DROP FUNCTION IF EXISTS activities_touch_updated_at();

-- 3. leads indexes (drop before columns; IF EXISTS = idempotent)
DROP INDEX IF EXISTS leads_follow_up_date_idx;
DROP INDEX IF EXISTS leads_crm_created_date_idx;
DROP INDEX IF EXISTS leads_record_type_idx;
DROP INDEX IF EXISTS leads_status_idx;

-- 4. leads columns (reverse order of addition).
--    DROP COLUMN auto-cascades to indexes and CHECK constraints on that
--    column, so the CHECK constraints on record_type / follow_up_type /
--    meeting_stage are dropped with their columns. No separate
--    DROP CONSTRAINT needed.
ALTER TABLE leads DROP COLUMN IF EXISTS meeting_stage;
ALTER TABLE leads DROP COLUMN IF EXISTS follow_up_type;
ALTER TABLE leads DROP COLUMN IF EXISTS follow_up_time;
ALTER TABLE leads DROP COLUMN IF EXISTS follow_up_date;
ALTER TABLE leads DROP COLUMN IF EXISTS record_type;
ALTER TABLE leads DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE leads DROP COLUMN IF EXISTS crm_created_date;
ALTER TABLE leads DROP COLUMN IF EXISTS photo_urls;
ALTER TABLE leads DROP COLUMN IF EXISTS customer_reminders_disabled;
ALTER TABLE leads DROP COLUMN IF EXISTS is_new_intake_lead;
ALTER TABLE leads DROP COLUMN IF EXISTS lead_score;
ALTER TABLE leads DROP COLUMN IF EXISTS message;