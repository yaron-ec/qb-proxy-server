-- =====================================================================
-- 2026-57: google_contacts_outbox (CRM STABILITY PHASE, completion pass,
-- Section D — closing the schema-drift baseline).
--
-- This table was previously created via raw DDL at runtime
-- (lib/googleContactsOutbox.js#ensureContactsOutbox, called once per
-- process by scripts/calendarOutboxWorker.js — a long-running worker, so
-- not the "fresh process every tick" deadlock class of risk documented in
-- CLAUDE.md's reminder-worker/schema.sql incident, but still a genuine
-- "No DDL at runtime" violation flagged by test/schemaDriftGuard.test.js's
-- known-offenders baseline). Moved here so the table is guaranteed present
-- by db/migrate.js before any process (API, worker) starts — the one
-- sanctioned path. ensureContactsOutbox() itself is kept as an exported
-- no-op (lib/googleContactsOutbox.js) so existing callers (the worker, two
-- integration tests) don't need updating, but it no longer executes DDL.
--
-- Idempotent — safe to re-run. Startup-safe: additive table only.
-- =====================================================================

CREATE TABLE IF NOT EXISTS google_contacts_outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          UUID NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS google_contacts_outbox_ready_idx
  ON google_contacts_outbox (next_attempt_at)
  WHERE status IN ('pending', 'failed');
