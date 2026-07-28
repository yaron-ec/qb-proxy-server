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
  crm_created_date           TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ---------------------------------------------------------------------
  -- reminder_leads: representative snapshot columns (stored at ingestion time so
  -- the action flow NEVER reads representative data from Base44).
  -- ---------------------------------------------------------------------
  ALTER TABLE reminder_leads ADD COLUMN IF NOT EXISTS assigned_rep_name  TEXT;
  ALTER TABLE reminder_leads ADD COLUMN IF NOT EXISTS assigned_rep_email TEXT;
  ALTER TABLE reminder_leads ADD COLUMN IF NOT EXISTS assigned_rep_phone TEXT;

  -- ---------------------------------------------------------------------
  -- reminder_action_tokens — opaque token registrations created at email-send
  -- time. Only SHA-256(token) is stored; the raw token exists only in the
  -- customer's email link and is never logged.
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS reminder_action_tokens (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash             TEXT NOT NULL,
    lead_id                TEXT NOT NULL,
    appointment_fingerprint TEXT NOT NULL,
    action_type            TEXT NOT NULL CHECK (action_type IN ('confirm','reschedule','contact')),
    expires_at             TIMESTAMPTZ NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    snapshot               JSONB,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS reminder_action_tokens_hash_uidx ON reminder_action_tokens (token_hash);
  CREATE INDEX IF NOT EXISTS reminder_action_tokens_lead_idx ON reminder_action_tokens (lead_id);
  CREATE INDEX IF NOT EXISTS reminder_action_tokens_expire_idx ON reminder_action_tokens (expires_at) WHERE status = 'active';

  -- ---------------------------------------------------------------------
  -- reminder_actions — event log for customer actions. token_hash links to
  -- reminder_action_tokens (the raw token is NEVER stored). Completion rows
  -- carry the idempotency guarantees via partial UNIQUE indexes.
  -- ---------------------------------------------------------------------
  -- Idempotent: CREATE IF NOT EXISTS only. Never DROP in production —
  -- reminder_actions holds the immutable customer-action audit log.
  CREATE TABLE IF NOT EXISTS reminder_actions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash              TEXT NOT NULL,
    lead_id                 TEXT NOT NULL,
    appointment_fingerprint TEXT NOT NULL,
    action_type             TEXT NOT NULL CHECK (action_type IN ('confirm','reschedule','contact')),
    event_type              TEXT NOT NULL CHECK (event_type IN ('page_opened','action_completed','button_clicked')),
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
    requested_date          TEXT CHECK (requested_date IS NULL OR requested_date ~ '^\d{4}-\d{2}-\d{2}$'),
    requested_time          TEXT CHECK (requested_time IS NULL OR requested_time ~ '^\d{2}:\d{2}$'),
    note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
    note_hash               TEXT,
    expires_at              TIMESTAMPTZ,
    clicked_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    ip                      TEXT,
    user_agent              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS reminder_actions_token_idx ON reminder_actions (token_hash);
  CREATE INDEX IF NOT EXISTS reminder_actions_lead_idx ON reminder_actions (lead_id);
  CREATE INDEX IF NOT EXISTS reminder_actions_appt_idx ON reminder_actions (appointment_fingerprint);
  -- Appointment-specific confirmation idempotency: exactly one completed confirm per appointment.
  CREATE UNIQUE INDEX IF NOT EXISTS reminder_actions_confirm_uidx
    ON reminder_actions (appointment_fingerprint)
    WHERE action_type = 'confirm' AND event_type = 'action_completed';
  -- Duplicate reschedule protection: one completed request per (appointment, requested date/time, note).
  CREATE UNIQUE INDEX IF NOT EXISTS reminder_actions_reschedule_uidx
    ON reminder_actions (appointment_fingerprint, requested_date, requested_time, note_hash)
    WHERE action_type = 'reschedule' AND event_type = 'action_completed';

  -- ---------------------------------------------------------------------
  -- reminder_notifications — internal notification queue (Railway only).
  -- Enqueued atomically with the customer action; delivered by a separate
  -- Gmail path. A Gmail failure never loses the customer action.
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS reminder_notifications (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id                 TEXT NOT NULL,
    appointment_fingerprint TEXT NOT NULL,
    notification_type       TEXT NOT NULL CHECK (notification_type IN ('confirm','reschedule')),
    assigned_rep            TEXT,
    assigned_rep_email      TEXT,
    recipient_emails        TEXT NOT NULL,
    subject                 TEXT NOT NULL,
    body                    TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
    attempt_count           INTEGER NOT NULL DEFAULT 0,
    last_error              TEXT,
    next_attempt_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS reminder_notifications_status_idx ON reminder_notifications (status, next_attempt_at);

  -- ---------------------------------------------------------------------
  -- reminder_form_nonces — one-time CSRF nonces for POST forms. Hash-only
  -- storage (raw nonce never stored).
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS reminder_form_nonces (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nonce_hash    TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS reminder_form_nonces_hash_uidx ON reminder_form_nonces (nonce_hash);
  CREATE INDEX IF NOT EXISTS reminder_form_nonces_token_idx ON reminder_form_nonces (token_hash);

  -- =====================================================================
  -- Phase 1 — Railway Email Service + Railway Authentication
  -- (Also in db/migrations/2026-07-email-service.sql for explicit runs.)
  -- =====================================================================

  -- email_send_claims — idempotency gate for every ad-hoc email send.
  CREATE TABLE IF NOT EXISTS email_send_claims (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key   TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','sent','failed')),
    recipient         TEXT,
    subject           TEXT,
    gmail_message_id  TEXT,
    last_error        TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at           TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS email_send_claims_key_uidx ON email_send_claims (idempotency_key);

  -- email_send_logs — per-attempt delivery audit trail.
  CREATE TABLE IF NOT EXISTS email_send_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id          UUID REFERENCES email_send_claims(id) ON DELETE CASCADE,
    idempotency_key   TEXT NOT NULL,
    role              TEXT,
    recipient         TEXT NOT NULL,
    cc                TEXT[],
    reply_to          TEXT,
    sender            TEXT,
    subject           TEXT,
    gmail_message_id  TEXT,
    status            TEXT NOT NULL CHECK (status IN ('sent','failed')),
    error             TEXT,
    attempts          INTEGER NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS email_send_logs_claim_idx ON email_send_logs (claim_id);
  CREATE INDEX IF NOT EXISTS email_send_logs_created_idx ON email_send_logs (created_at);

  -- users — Railway identity source of truth (PERMANENT; replaces Base44 auth).
  CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL,
    full_name     TEXT,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','manager','sales_rep','office','user')),
    password_hash TEXT,
    google_sub    TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (lower(email));
  CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uidx ON users (google_sub) WHERE google_sub IS NOT NULL;

  -- refresh_tokens — rotating, revocable refresh sessions (hash-only storage).
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   TEXT NOT NULL,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rotated_from TEXT,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_uidx ON refresh_tokens (token_hash);
  CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
  CREATE INDEX IF NOT EXISTS refresh_tokens_active_idx ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;