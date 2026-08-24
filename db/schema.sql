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

  -- ---------------------------------------------------------------------
  -- gmail_oauth_states — temporary OAuth state store for the one-time
  -- Gmail OAuth authorization flow (lib/gmailOAuthRouter.js).
  -- Stores ONLY the SHA-256 hash of the state (never the raw state).
  -- States expire in 10 minutes and are single-use.
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS gmail_oauth_states (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_hash      TEXT NOT NULL,
    expected_email  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS gmail_oauth_states_hash_uidx
    ON gmail_oauth_states (state_hash);
  CREATE INDEX IF NOT EXISTS gmail_oauth_states_expires_idx
    ON gmail_oauth_states (expires_at)
    WHERE used_at IS NULL;

  -- =====================================================================
  -- Phase 1 — Railway Booking Engine (canonical owners, leads, appointments)
  -- CANONICAL SOURCE: this file (db/schema.sql), applied by ensureSchema() at
  -- startup and by db/migrate.js. There is NO second copy in db/migrations/.
  -- Domains are separate (Lead / Appointment / Reminder). No hard delete;
  -- cancellation is a status change. Appointments reference a stable canonical
  -- owner UUID (email is a convenience field). Immutable audit trail.
  -- =====================================================================

  CREATE EXTENSION IF NOT EXISTS btree_gist;

  CREATE TABLE IF NOT EXISTS owners (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email        TEXT UNIQUE,
    display_name TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE OR REPLACE FUNCTION owners_touch_updated_at()
  RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS owners_set_updated_at ON owners;
  CREATE TRIGGER owners_set_updated_at BEFORE UPDATE ON owners
    FOR EACH ROW EXECUTE FUNCTION owners_touch_updated_at();

  CREATE TABLE IF NOT EXISTS leads (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_ref     TEXT UNIQUE,
    first_name       TEXT NOT NULL,
    last_name        TEXT NOT NULL,
    email            TEXT,
    phone            TEXT,
    property_address TEXT,
    city             TEXT,
    zip              TEXT,
    project_type     TEXT,
    budget_range     TEXT,
    start_timeframe  TEXT,
    source           TEXT,
    referral_name    TEXT,
    owner_id         UUID NOT NULL REFERENCES owners(id),
    status           TEXT NOT NULL DEFAULT 'new',
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads (owner_id);
  CREATE INDEX IF NOT EXISTS leads_email_idx ON leads (lower(email)) WHERE email IS NOT NULL;
  CREATE OR REPLACE FUNCTION leads_touch_updated_at()
  RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
  CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION leads_touch_updated_at();

  CREATE TABLE IF NOT EXISTS appointment_types (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     TEXT NOT NULL UNIQUE,
    default_duration_minutes INTEGER NOT NULL DEFAULT 60
                             CHECK (default_duration_minutes > 0 AND default_duration_minutes <= 480),
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO appointment_types (name, default_duration_minutes) VALUES
    ('Consultation', 60), ('Estimate', 60), ('Inspection', 60), ('Site Visit', 60),
    ('Roofing', 60), ('ADU', 90), ('Kitchen', 90), ('Bathroom', 90), ('Pool', 60),
    ('Permit', 30), ('Zoom', 30), ('General Meeting', 60)
  ON CONFLICT (name) DO NOTHING;

  CREATE TABLE IF NOT EXISTS appointments (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id                   UUID NOT NULL REFERENCES leads(id),
    owner_id                  UUID NOT NULL REFERENCES owners(id),
    appointment_type_id       UUID NOT NULL REFERENCES appointment_types(id),
    start_at                  TIMESTAMPTZ NOT NULL,
    end_at                    TIMESTAMPTZ NOT NULL,
    duration_override_minutes INTEGER,
    timezone                  TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    busy_range                TSTZRANGE NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled','confirmed','completed','cancelled','rescheduled','no_show')),
    idempotency_key           TEXT NOT NULL,
    calendar_sync_status      TEXT NOT NULL DEFAULT 'pending'
                              CHECK (calendar_sync_status IN ('pending','synced','retrying','failed')),
    google_event_id           TEXT,
    google_travel_event_id    TEXT,
    calendar_last_error       TEXT,
    calendar_synced_at        TIMESTAMPTZ,
    override_conflict         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- override_conflict=true rows are EXEMPT from the active-overlap guard.
    -- Set ONLY by bookingService.createBooking for authorized admin overrides
    -- (public capture route verifies a Railway admin JWT + email allowlist).
    -- Normal rows (override_conflict=false) remain fully protected.
    CONSTRAINT appointments_no_active_overlap EXCLUDE USING gist (
      owner_id WITH =,
      busy_range WITH &&
    ) WHERE (status IN ('scheduled','confirmed') AND NOT override_conflict)
  );
  CREATE INDEX IF NOT EXISTS appointments_owner_idx ON appointments (owner_id);
  CREATE INDEX IF NOT EXISTS appointments_lead_idx ON appointments (lead_id);
  CREATE INDEX IF NOT EXISTS appointments_status_idx ON appointments (status);
  CREATE INDEX IF NOT EXISTS appointments_start_idx ON appointments (start_at);
  CREATE OR REPLACE FUNCTION appointments_touch_updated_at()
  RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS appointments_set_updated_at ON appointments;
  CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_touch_updated_at();

  -- D2: appointments are NEVER physically deleted. Cancellation is a status
  -- change; historical rows remain permanently for audit/reporting.
  CREATE OR REPLACE FUNCTION appointments_no_delete()
  RETURNS TRIGGER AS $$ BEGIN
    RAISE EXCEPTION 'appointments are immutable: physical DELETE not permitted; use status = ''cancelled''';
  END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS appointments_no_delete ON appointments;
  CREATE TRIGGER appointments_no_delete BEFORE DELETE ON appointments
    FOR EACH ROW EXECUTE FUNCTION appointments_no_delete();

  CREATE TABLE IF NOT EXISTS booking_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    lead_id         UUID NOT NULL REFERENCES leads(id),
    appointment_id  UUID NOT NULL REFERENCES appointments(id),
    request_hash    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS appointment_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id  UUID NOT NULL REFERENCES appointments(id),
    actor           TEXT,
    action          TEXT NOT NULL CHECK (action IN (
      'created','updated','rescheduled','cancelled','completed',
      'owner_changed','appointment_type_changed','duration_changed','status_changed'
    )),
    previous_values JSONB,
    new_values      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS appointment_events_appt_idx ON appointment_events (appointment_id);
  CREATE OR REPLACE FUNCTION appointment_events_immutable()
  RETURNS TRIGGER AS $$ BEGIN
    RAISE EXCEPTION 'appointment_events is immutable: UPDATE/DELETE not permitted';
  END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS appointment_events_no_update ON appointment_events;
  CREATE TRIGGER appointment_events_no_update BEFORE UPDATE OR DELETE ON appointment_events
    FOR EACH ROW EXECUTE FUNCTION appointment_events_immutable();

  -- =====================================================================
  -- Phase 2 — Google Calendar Outbox (durable outbox saga, Railway-owned).
  -- calendar_outbox is the durable side-effect queue for Google Calendar.
  -- Rows are enqueued INSIDE the booking mutation transaction (create/cancel/
  -- reschedule/update). A separate worker drains pending rows and calls Google
  -- idempotently; the booking tx NEVER makes a Google API call. If the tx rolls
  -- back, its outbox rows roll back with it.
  -- =====================================================================

  -- Per-appointment monotonic version; increments on every mutation that may
  -- enqueue a calendar operation. Used in the outbox idempotency key so a later
  -- legitimate operation of the same action type is allowed (new version) while
  -- a retry of the same logical operation is deduped (same version).
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE IF NOT EXISTS calendar_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id  UUID NOT NULL REFERENCES appointments(id),
    action          TEXT NOT NULL CHECK (action IN (
                      'create_main','create_travel','update_main','update_travel',
                      'cancel_main','cancel_travel')),
    slot            TEXT NOT NULL,                 -- {dateYYYYMMDD}{startHHMM} (LA)
    version         INTEGER NOT NULL,              -- appointment.version at enqueue
    google_event_id TEXT NOT NULL,                 -- deterministic target Google event id
    calendar_id     TEXT NOT NULL DEFAULT 'primary',
    payload         JSONB,                          -- full event body (NULL for cancel)
    idempotency_key TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','synced','failed','dead')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    last_error      TEXT,
    claimed_by      TEXT,
    claimed_at      TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS calendar_outbox_idem_uidx ON calendar_outbox (idempotency_key);
  CREATE INDEX IF NOT EXISTS calendar_outbox_claim_idx
    ON calendar_outbox (status, next_attempt_at)
    WHERE status IN ('pending','failed');
  CREATE INDEX IF NOT EXISTS calendar_outbox_appt_idx ON calendar_outbox (appointment_id);
  CREATE INDEX IF NOT EXISTS calendar_outbox_processing_idx
    ON calendar_outbox (claimed_at) WHERE status = 'processing';

  -- =====================================================================
  -- Phase 3A — Base44 Lead Projection Outbox (Railway-side).
  -- One-way Railway -> Base44 projection. Railway remains the source of truth;
  -- Base44 is a temporary projection target. The projection worker is NOT
  -- auto-deployed. No Base44 schema dependency here (the Lead.railway_lead_id
  -- field is a separate Phase 3B gate).
  -- =====================================================================

  -- Per-Lead monotonic projection revision. Incremented ONLY by
  -- projectionService.recordLeadAggregateChange (no generic trigger) on a
  -- Base44-visible aggregate change. 0 = never projected.
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS projection_revision INTEGER NOT NULL DEFAULT 0;

  -- Explicit origin marker. 'railway' = created by the Railway booking engine
  -- (projected to Base44); 'base44' = originated in Base44 (never projected back).
  --
  -- MIGRATION-SAFE DESIGN: the column is intentionally NULLABLE (no NOT NULL,
  -- no DEFAULT). If `leads` already has rows when this ALTER runs, they receive
  -- NULL origin_system (CHECK passes NULL), so the migration never fails. NULL
  -- is treated as "unknown provenance" — the projection origin gate skips
  -- non-'railway' leads, so legacy rows are NEVER silently classified as railway
  -- and NEVER projected. NOT NULL enforcement is a DEFERRED gate: after an
  -- explicit, verified provenance backfill, a later migration adds
  -- `origin_system TEXT NOT NULL`. New booking-engine inserts always declare
  -- 'railway' explicitly (bookingService.createBooking).
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS origin_system TEXT
    CHECK (origin_system IN ('railway','base44'));

  CREATE TABLE IF NOT EXISTS projection_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(id),
    revision        INTEGER NOT NULL,               -- leads.projection_revision at enqueue
    action          TEXT NOT NULL,                  -- audit reason (lead_created, appointment_rescheduled, ...)
    idempotency_key TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','synced','failed','dead')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    last_error      TEXT,
    claimed_by      TEXT,
    claimed_at      TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS projection_outbox_idem_uidx ON projection_outbox (idempotency_key);
  CREATE INDEX IF NOT EXISTS projection_outbox_claim_idx
    ON projection_outbox (status, next_attempt_at)
    WHERE status IN ('pending','failed');
  CREATE INDEX IF NOT EXISTS projection_outbox_lead_idx ON projection_outbox (lead_id, revision);

  CREATE OR REPLACE FUNCTION projection_outbox_touch_updated_at()
  RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS projection_outbox_set_updated_at ON projection_outbox;
  CREATE TRIGGER projection_outbox_set_updated_at BEFORE UPDATE ON projection_outbox
    FOR EACH ROW EXECUTE FUNCTION projection_outbox_touch_updated_at();

  -- Durable Railway<->Base44 Lead ID mapping. Lead-aggregate only (no
  -- appointment rows). railway_revision = last projected projection_revision.
  CREATE TABLE IF NOT EXISTS base44_entity_map (
    railway_lead_id   UUID PRIMARY KEY REFERENCES leads(id),
    base44_id         TEXT NOT NULL,                 -- Base44 Lead entity UUID
    railway_revision  INTEGER NOT NULL DEFAULT 0,
    last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS base44_entity_map_base44_uidx ON base44_entity_map (base44_id);
  CREATE OR REPLACE FUNCTION base44_entity_map_touch_updated_at()
  RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS base44_entity_map_set_updated_at ON base44_entity_map;
  CREATE TRIGGER base44_entity_map_set_updated_at BEFORE UPDATE ON base44_entity_map
    FOR EACH ROW EXECUTE FUNCTION base44_entity_map_touch_updated_at();