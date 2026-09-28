-- 2026-44-phone-call-followup-reminders.sql
--
-- Phone Call = follow-up / reminder, never an appointment.
--
-- 1. followup_calendar_reminders — one row per lead: the state of that lead's
--    Phone Call follow-up REMINDER event on Google Calendar (a non-blocking,
--    "free" visibility event). The CRM follow-up (leads.follow_up_*) is the
--    canonical source; lib/booking/followUpReminders.js reconciles Google to
--    it idempotently (deterministic event id per lead → a reschedule/owner
--    change updates the same event, never a second one).
--
-- 2. legacy_phone_call_conversions — backup + audit of every legacy
--    Phone Call APPOINTMENT row (pre-rule data) moved to the lead's follow-up
--    by lib/booking/legacyPhoneCallConversion.js: the full appointment row and
--    the lead's previous follow-up fields are kept, so each conversion is
--    reversible (scripts/revertLegacyPhoneCallConversion.js). Ambiguous rows
--    are recorded (action 'ambiguous') and left untouched.
--
-- Startup-safe: new tables only, IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS followup_calendar_reminders (
  lead_id          UUID PRIMARY KEY,
  google_event_id  TEXT NOT NULL,
  -- bumped each time the reminder is removed, so a later follow-up for the
  -- same lead gets a fresh deterministic id (a deleted Google id is never reused)
  generation       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'expired')),
  followup_kind    TEXT NOT NULL DEFAULT 'phone_call',
  start_at         TIMESTAMPTZ,
  owner_email      TEXT,
  fingerprint      TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ,
  synced_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS followup_calendar_reminders_status_idx ON followup_calendar_reminders (status);

CREATE TABLE IF NOT EXISTS legacy_phone_call_conversions (
  appointment_id        UUID PRIMARY KEY,
  lead_id               UUID,
  action                TEXT NOT NULL CHECK (action IN ('converted', 'deduplicated', 'ambiguous', 'reverted')),
  reason                TEXT,
  appointment_before    JSONB NOT NULL,
  lead_followup_before  JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at           TIMESTAMPTZ
);

-- 3. followup_reminder_runs — single-row heartbeat of the calendar worker's
--    Phone Call pass (last run + counts + the worker's deployed commit), read
--    by the aggregate integrity check (routes/phoneCallIntegrity.js).
CREATE TABLE IF NOT EXISTS followup_reminder_runs (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at  TIMESTAMPTZ NOT NULL,
  last_stats   JSONB,
  commit_sha   TEXT
);
