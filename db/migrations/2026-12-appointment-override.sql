-- =====================================================================
-- Appointment Admin-Override Conflict Exemption — 2026-12
--
-- Adds `override_conflict BOOLEAN NOT NULL DEFAULT FALSE` to appointments
-- and recreates the active-overlap EXCLUDE constraint with an extended
-- partial predicate that EXEMPTS override_conflict=true rows.
--
-- Effect:
--   * Normal bookings (override_conflict = false): the EXCLUDE constraint
--     applies IDENTICALLY to before — overlapping active busy_range still
--     raises 23P01. Zero behavior change for every existing + new normal row.
--   * Authorized admin-override bookings (override_conflict = true): the row
--     is exempt from the partial predicate, so the INSERT succeeds even when
--     busy_range overlaps an existing active appointment. The existing
--     appointment is never touched; the override coexists (explicit double-book
--     as the admin intended). No global disable, no SET CONSTRAINTS, no per-tx
--     defer — all concurrent normal bookings remain fully protected.
--
-- The flag is set ONLY by bookingService.createBooking and ONLY when the
-- public capture route has already verified a Railway admin JWT + server-side
-- email allowlist (lib/captureOverrideAuth.js). There is no other writer.
--
-- Audit: the appointment_events 'created' row's new_values records
--   override_conflict + override_actor (admin email) for every override.
--
-- ATOMICITY: the DROP of the existing constraint and the ADD of the
--   extended-predicate constraint run inside a SINGLE DO block = a single
--   transaction. If the ADD fails for any reason, the DROP rolls back too,
--   so the DB is NEVER left without overlap protection. (The new predicate is
--   strictly less restrictive than the original, so the ADD cannot fail on
--   data grounds — existing rows that satisfied the original also satisfy the
--   extended predicate — but the atomic wrap is defense-in-depth.)
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; the constraint is DROP-if-present then
--   re-ADD inside the DO block on every run, so re-running produces the exact
--   same end state. Safe to re-run.
--
-- TARGET: the single Railway PostgreSQL instance (DATABASE_URL).
-- DO NOT RUN IN PRODUCTION until approved. Applied via:
--   node db/migrate.js   (runs ensureSchema() then all db/migrations/*.sql
--   in filename order)
-- =====================================================================

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS override_conflict BOOLEAN NOT NULL DEFAULT FALSE;

-- Atomically DROP the existing constraint (if any) and ADD the extended-
-- predicate constraint. Both statements run inside one DO block = one
-- transaction: an ADD failure rolls back the DROP, so the DB is never left
-- without an active-overlap guard. Idempotent (re-run produces the same state).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_no_active_overlap'
      AND conrelid = 'appointments'::regclass
  ) THEN
    ALTER TABLE appointments DROP CONSTRAINT appointments_no_active_overlap;
  END IF;
  ALTER TABLE appointments
    ADD CONSTRAINT appointments_no_active_overlap EXCLUDE USING gist (
      owner_id WITH =,
      busy_range WITH &&
    ) WHERE (status IN ('scheduled','confirmed') AND NOT override_conflict);
END $$;