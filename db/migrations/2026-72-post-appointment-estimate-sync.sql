-- =====================================================================
-- 2026-72-post-appointment-estimate-sync.sql — automatic, per-appointment
-- QuickBooks estimate sync scheduling (CRM feature: "Automatic
-- Post-Appointment QuickBooks Estimate Sync and Follow-Up Enrollment").
--
-- Separate, additive migration from 2026-70/2026-71 (the base estimate
-- follow-up sequence + its automatic-detection extension) — never edits
-- either, per this codebase's "never edit an already-applied/already-
-- reviewed migration" convention (db/migrate.js never re-executes a
-- filename it has already recorded in schema_migrations; PR #64, which
-- carries 2026-71, was still open/unmerged when this file was written, but
-- it had already been pushed and reviewed once, so a fresh file is used
-- rather than amending it in place).
--
-- post_appointment_estimate_syncs: one row per ELIGIBLE real customer
-- appointment (never a Phone Call follow-up — those are never an
-- `appointments` row at all, see CLAUDE.md's "A Phone Call is never an
-- appointment"), tracking a durable, idempotent retry schedule for
-- checking QuickBooks for that appointment's estimate:
--   3h after the appointment's end time (first attempt), then 24h/48h/72h,
--   then once daily through day 7 — see
--   lib/postAppointmentEstimateSync.js#RETRY_OFFSETS_HOURS for the exact,
--   single source of truth for this schedule (duplicated here only as a
--   comment, never as a second implementation).
--
-- UNIQUE(appointment_id) is the idempotency guarantee: a scheduler tick
-- that runs more than once (worker restart, overlapping ticks) can never
-- create two competing schedule rows for the same appointment —
-- `INSERT ... ON CONFLICT (appointment_id) DO NOTHING` is always safe.
--
-- status:
--   'pending'    — not yet due, or due and waiting for the next worker tick
--   'processing' — claimed by a worker (atomic UPDATE ... WHERE
--                  status='pending' ... RETURNING, same claim pattern as
--                  estimate_followup_steps) — a crash here is always safe
--                  to re-claim, since it's just a read-only sync check
--                  immediately followed by writing the real result; no
--                  separate recovery mechanism needed.
--   'completed'  — a qualifying estimate (one with confirmed QuickBooks
--                  delivery evidence) was found and auto-enrollment
--                  succeeded (or the engine's own fail-closed reply-
--                  monitoring gate held it — that is still "found", just
--                  not yet sent; the found estimate is still recorded).
--   'stopped'    — the lead became ineligible (sold / terminal-lost /
--                  no longer a valid send target) before a qualifying
--                  estimate was found.
--   'expired'    — the 7-day search window elapsed with no qualifying
--                  estimate found.
--
-- last_result: 'not_found' | 'found_unverified' | 'found_verified_enrolled'
--   | 'lead_ineligible' | 'error' — a short, queryable summary of the most
--   recent attempt, shown on the Lead Detail page (never raw QuickBooks
--   response text).
--
-- handoff_estimate_id: set the moment ANY matching handoff_estimates row
-- is found (even before its delivery is verified) so the Lead Detail page
-- can link directly to it while the schedule keeps re-checking for
-- delivery evidence.
-- =====================================================================

CREATE TABLE IF NOT EXISTS post_appointment_estimate_syncs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id        UUID NOT NULL REFERENCES appointments(id),
  lead_id               UUID NOT NULL REFERENCES leads(id),
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','stopped','expired')),
  attempt_number        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ NOT NULL,
  last_attempt_at       TIMESTAMPTZ,
  last_result           TEXT CHECK (last_result IS NULL OR last_result IN
                        ('not_found','found_unverified','found_verified_enrolled','lead_ineligible','error')),
  last_error            TEXT,
  handoff_estimate_id   UUID REFERENCES handoff_estimates(id),
  window_expires_at     TIMESTAMPTZ NOT NULL,
  stopped_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (appointment_id)
);
CREATE INDEX IF NOT EXISTS post_appointment_estimate_syncs_lead_idx ON post_appointment_estimate_syncs (lead_id);
CREATE INDEX IF NOT EXISTS post_appointment_estimate_syncs_due_idx ON post_appointment_estimate_syncs (status, next_attempt_at);

CREATE OR REPLACE FUNCTION post_appointment_estimate_syncs_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS post_appointment_estimate_syncs_set_updated_at ON post_appointment_estimate_syncs;
CREATE TRIGGER post_appointment_estimate_syncs_set_updated_at BEFORE UPDATE ON post_appointment_estimate_syncs
  FOR EACH ROW EXECUTE FUNCTION post_appointment_estimate_syncs_touch_updated_at();

-- Widen estimate_followup_sequences.enrollment_method's CHECK constraint
-- again (2026-71 already widened it once, for 'auto_qb_email_status') to
-- also allow 'auto_post_appointment_sync' — the enrollment this new
-- post-appointment sync job triggers directly once it finds confirmed
-- QuickBooks delivery evidence (lib/estimateFollowupEngine.js#enroll,
-- called from lib/postAppointmentEstimateSync.js). Kept as its own
-- separate, attributable method value rather than reusing
-- 'auto_qb_email_status' so the Lead Detail / admin UI can show WHICH
-- automatic trigger actually caused a given enrollment.
ALTER TABLE estimate_followup_sequences
DROP CONSTRAINT IF EXISTS estimate_followup_sequences_enrollment_method_check;

ALTER TABLE estimate_followup_sequences
ADD CONSTRAINT estimate_followup_sequences_enrollment_method_check
CHECK (enrollment_method IN ('confirm_sent', 'manual_enroll', 'auto_qb_email_status', 'auto_post_appointment_sync'));
