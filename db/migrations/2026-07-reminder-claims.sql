-- Email migration (minimal): Railway reminder operational tables.
-- Idempotent. Safe to re-run. Creates ONLY reminder_* tables. Does NOT modify any
-- existing QuickBooks, credential-store, CRM, email_send_claims, or other table.
-- Applied by: npm run migrate  (NOT run automatically by server startup.)

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
);;

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
);;

CREATE TABLE IF NOT EXISTS reminder_activity_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          TEXT NOT NULL,
  reminder_key     TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);;
