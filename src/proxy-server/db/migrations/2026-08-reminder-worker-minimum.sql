-- =====================================================================
-- MINIMUM MIGRATION: Railway reminder-worker shadow mode (Phase R2)
--
-- Scope: ONLY the tables required for appointment-reminder shadow mode
-- (REMINDER_DRY_RUN=true, REMINDER_SOURCE=postgres, transport gates=base44).
--
-- Tables created:
--   reminder_runs           — singleton health row (engine writes every run)
--   reminder_leads          — production lead table (engine reads + ingest upserts)
--   reminder_claims         — atomic claim gate (unused in dry-run, required
--                             for forward-readiness when transport flips to railway)
--   reminder_activity_queue — Base44 Activity retry queue (flush is a no-op
--                             when empty, but the SELECT must not throw)
--
-- EXCLUDED (not needed in shadow mode):
--   reminder_notifications, reminder_action_tokens, reminder_actions,
--   reminder_form_nonces, test_leads, email_send_claims, email_send_logs,
--   users, refresh_tokens, gmail_oauth_states
--
-- Idempotent: safe to re-run. Uses CREATE TABLE IF NOT EXISTS.
-- This file is a SUBSET of db/schema.sql — running schema.sql also works
-- (it creates these plus the excluded tables), but this file is the
-- auditable minimum for shadow-mode go-live.
-- =====================================================================

-- ---------------------------------------------------------------------
-- reminder_runs (singleton — row id=1 always exists)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_runs (
  id                         INTEGER PRIMARY KEY DEFAULT 1,
  last_run_at                TIMESTAMPTZ,
  last_run_status            TEXT,
  last_run_duration_ms       INTEGER,
  last_run_error             TEXT,
  last_run_error_type        TEXT,
  consecutive_failures       INTEGER NOT NULL DEFAULT 0,
  last_successful_run_at     TIMESTAMPTZ,
  last_reminder_sent_at      TIMESTAMPTZ,
  last_reminder_lead_id      TEXT,
  last_reminder_window       TEXT,
  appointments_scanned       INTEGER,
  reminders_sent             INTEGER,
  reminders_skipped          INTEGER,
  gmail_status               TEXT NOT NULL DEFAULT 'unknown',
  gmail_last_error           TEXT,
  gmail_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  gmail_credentials_lock     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO reminder_runs (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION reminder_runs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reminder_runs_set_updated_at ON reminder_runs;
CREATE TRIGGER reminder_runs_set_updated_at
  BEFORE UPDATE ON reminder_runs
  FOR EACH ROW EXECUTE FUNCTION reminder_runs_touch_updated_at();

-- ---------------------------------------------------------------------
-- reminder_leads (production lead table — fed by lead-sync upsert)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_leads (
  id                          TEXT PRIMARY KEY,
  first_name                  TEXT NOT NULL,
  last_name                   TEXT NOT NULL,
  email                       TEXT,
  phone                       TEXT,
  property_address            TEXT,
  city                        TEXT,
  project_type                TEXT,
  follow_up_date              TEXT,
  follow_up_time              TEXT,
  follow_up_type              TEXT,
  appointment_date            TEXT,
  appointment_time            TEXT,
  assigned_rep                TEXT,
  assigned_rep_name           TEXT,
  assigned_rep_email          TEXT,
  assigned_rep_phone         TEXT,
  budget_range                TEXT,
  notes                       TEXT,
  customer_reminders_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  crm_created_date            TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- reminder_claims (atomic per-reminder claim — unused in dry-run, required
-- for real-send forward-readiness)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_key      TEXT NOT NULL,
  lead_id           TEXT NOT NULL,
  appointment_date  DATE NOT NULL,
  reminder_window   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  owner             TEXT,
  lease_expires_at  TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_error_type   TEXT,
  gmail_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS reminder_claims_reminder_key_uidx
  ON reminder_claims (reminder_key);

CREATE INDEX IF NOT EXISTS reminder_claims_lease_idx
  ON reminder_claims (lease_expires_at)
  WHERE status IN ('processing', 'failed');

CREATE OR REPLACE FUNCTION reminder_claims_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reminder_claims_set_updated_at ON reminder_claims;
CREATE TRIGGER reminder_claims_set_updated_at
  BEFORE UPDATE ON reminder_claims
  FOR EACH ROW EXECUTE FUNCTION reminder_claims_touch_updated_at();

-- ---------------------------------------------------------------------
-- reminder_activity_queue (Base44 Activity retry — flush is a no-op when
-- empty, but the SELECT must not throw)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_activity_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          TEXT NOT NULL,
  reminder_key     TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reminder_activity_queue_next_idx
  ON reminder_activity_queue (next_attempt_at);