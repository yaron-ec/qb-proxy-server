-- =====================================================================
-- Railway PostgreSQL schema for the EC Construction Group reminder system.
--
-- OWNERSHIP: Railway owns ALL operational state. Base44 is NOT used for
-- locking, claims, leases, retries, cron, health, or alerts. Base44 is used
-- only to read CRM Lead records and to write the final REMINDER_SENT
-- Activity row after a reminder has been successfully delivered.
--
-- Tables:
--   reminder_claims        atomic per-reminder claim (UNIQUE reminder_key)
--   reminder_runs          singleton health/heartbeat row
--   reminder_activity_queue  bounded retry queue for the Base44 Activity write
--
-- Applied idempotently on worker boot by db/client.js ensureSchema().
-- Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- reminder_claims
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_key      TEXT NOT NULL,                 -- reminder:{leadId}:{window}:{appointmentDate}
  lead_id           TEXT NOT NULL,
  appointment_date  DATE NOT NULL,
  reminder_window   TEXT NOT NULL,                 -- 48h|24h|12h|2h|30min|catchup
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|processing|sent|failed
  owner             TEXT,                           -- <hostname>:<pid>
  lease_expires_at  TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_error_type   TEXT,                           -- transient|gmail_credentials|gmail_send
  gmail_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at           TIMESTAMPTZ
);

-- THE atomic gate: real database uniqueness on reminder_key.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_claims_reminder_key_uidx
  ON reminder_claims (reminder_key);

-- Fast lease-recovery scan over in-flight / retryable rows only.
CREATE INDEX IF NOT EXISTS reminder_claims_lease_idx
  ON reminder_claims (lease_expires_at)
  WHERE status IN ('processing', 'failed');

-- Keep updated_at honest on every UPDATE.
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
-- reminder_runs  (singleton — row id=1 always exists)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_runs (
  id                         INTEGER PRIMARY KEY DEFAULT 1,
  last_run_at                TIMESTAMPTZ,
  last_run_status            TEXT,                    -- success|failed|skipped|dry_run|running
  last_run_duration_ms       INTEGER,
  last_run_error             TEXT,
  last_run_error_type        TEXT,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  last_successful_run_at     TIMESTAMPTZ,
  last_reminder_sent_at      TIMESTAMPTZ,
  last_reminder_lead_id      TEXT,
  last_reminder_window       TEXT,
  appointments_scanned       INTEGER,
  reminders_sent             INTEGER,
  reminders_skipped          INTEGER,
  gmail_status               TEXT NOT NULL DEFAULT 'unknown', -- ok|credentials_invalid|unknown
  gmail_last_error           TEXT,
  gmail_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  gmail_credentials_lock     BOOLEAN NOT NULL DEFAULT FALSE,  -- blocks ALL sending until cleared
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
-- reminder_activity_queue — bounded retry for the Base44 Activity write.
-- A reminder is "sent" the moment Gmail accepts it (reminder_claims.status
-- = 'sent'). The Base44 Activity write is for CRM visibility ONLY; if it
-- fails it is retried here independently and NEVER triggers a re-send.
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

-- ---------------------------------------------------------------------
-- test_leads — SYNTHETIC dataset for the dry-run / test path only.
-- Created and populated by db/seedTestLeads.js when REMINDER_TEST_SEED=true.
-- In REMINDER_SOURCE=postgres mode the reminder worker reads leads from here
-- instead of Base44, so the engine can be validated with ZERO Base44 access.
-- This table is never used by production and never holds real customer data.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_leads (
  id                          TEXT PRIMARY KEY,
  first_name                  TEXT NOT NULL,
  last_name                   TEXT NOT NULL,
  email                       TEXT,
  phone                       TEXT,
  property_address            TEXT,
  city                        TEXT,
  project_type                TEXT,
  follow_up_date              TEXT,        -- 'YYYY-MM-DD' string (mirrors Base44)
  follow_up_time              TEXT,
  follow_up_type              TEXT,        -- 'Meeting' | 'Phone Call'
  appointment_date            TEXT,        -- 'YYYY-MM-DD' string (mirrors Base44)
  appointment_time            TEXT,
  assigned_rep                TEXT,
  budget_range                TEXT,
  notes                       TEXT,
  customer_reminders_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  crm_created_date            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- reminder_leads — PRODUCTION lead table for the reminder system.
--
-- Fed by POST /api/reminders/leads/upsert (CRM create/update) and by the
-- one-time importer (db/importLeads.js). The production reminder worker
-- (REMINDER_SOURCE=postgres, REMINDER_TEST_MODE off) reads from here.
--
-- Columns are EXACTLY the fields the reminder engine (lib/reminderEngine.js)
-- reads — nothing more (no lead_score, no status, no source, no timezone:
-- all appointment times are interpreted as America/Los_Angeles by the
-- engine, so they are stored as plain 'YYYY-MM-DD' / 'HH:MM' strings).
--   id                         external CRM lead id (stable upsert key)
--   first_name / last_name     customer name
--   email / phone              customer contact
--   property_address / city    appointment location
--   project_type               job type (shown in reminder emails)
--   follow_up_date/time/type   follow-up appointment (preferred when present)
--   appointment_date/time      standalone appointment
--   assigned_rep               rep name (engine derives the staff email)
--   budget_range / notes       context shown in the staff reminder email
--   customer_reminders_disabled true = customer opted out of customer-facing
--                              reminders (staff reminders still fire)
--   crm_created_date           when the lead was created in the CRM
--                              (engine uses it for the 24h catch-up window)
--   created_at / updated_at    operational upsert timestamps
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
  budget_range                TEXT,
  notes                       TEXT,
  customer_reminders_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  crm_created_date            TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);