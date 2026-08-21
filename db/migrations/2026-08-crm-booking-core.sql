-- =====================================================================
-- R1A PREREQUISITE — CRM Booking Core Migration — 2026-08
--
-- Extracts the Phase 1 Booking Engine + Phase 2 Google Calendar Outbox +
-- Phase 3A Base44 Lead Projection Outbox schema from the canonical
-- db/schema.sql (lines 406-659) into an explicit, reviewable, dry-runnable,
-- rollback-able migration artifact.
--
-- This file is a VERBATIM extraction. It does NOT redesign the schema.
-- db/schema.sql remains the canonical source (ensureSchema() runs the full
-- file at boot). This migration exists so the booking-core block has its
-- own SHA-verified, dry-runnable, rollback-able artifact — matching the
-- discipline already applied to 2026-09-crm-core.sql (R1A).
--
-- PREREQUISITE FOR: 2026-09-crm-core.sql (R1A), whose first statement is
--   ALTER TABLE leads ADD COLUMN ...  — requires the `leads` table this
--   migration creates.
--
-- TARGET: the single Railway PostgreSQL instance (disciplined-heart/Postgres)
--   referenced by the proxy-server DATABASE_URL. No second database.
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS / IF EXISTS / CREATE OR
--   REPLACE / ON CONFLICT DO NOTHING. Safe to re-run.
--
-- DO NOT RUN IN PRODUCTION until approved. This file is applied via:
--   node db/migrate.js   (runs ensureSchema() then all db/migrations/*.sql
--   in filename order: ...-booking-core.sql, then 2026-09-crm-core.sql)
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
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT appointments_no_active_overlap EXCLUDE USING gist (
      owner_id WITH =,
      busy_range WITH &&
    ) WHERE (status IN ('scheduled','confirmed'))
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