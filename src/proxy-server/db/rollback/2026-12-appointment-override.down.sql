-- =====================================================================
-- Appointment Admin-Override Conflict Exemption — DOWN MIGRATION (ROLLBACK)
-- File: db/rollback/2026-12-appointment-override.down.sql
--
-- Reverses db/migrations/2026-12-appointment-override.sql.
-- Run manually ONLY. Never auto-applied (lives outside db/migrations/).
--
-- ORDER:
--   1. Atomically DROP the extended-predicate EXCLUDE constraint and ADD the
--      ORIGINAL constraint (no override exemption) — both inside a single
--      DO block = a single transaction.
--   2. Drop the override_conflict column.
--
-- ATOMICITY / GUARD BEHAVIOR:
--   * The DROP and ADD run inside one DO block. If the ADD fails — which it
--     WILL (23P01) when an active override_conflict=true row overlaps an
--     existing active row under the original (no-exemption) predicate — the
--     DROP rolls back too, so the extended-predicate constraint REMAINS in
--     place. The rollback REFUSES to proceed while active override rows
--     would violate the restored original constraint. This is the intended
--     guard: never leave the DB without overlap protection, and never
--     silently drop the override exemption while override rows exist.
--   * To run this rollback cleanly, first neutralize every active
--     override_conflict=true row (cancel or reschedule it) so it no longer
--     participates in the active-overlap predicate. Then the ADD succeeds
--     and the column can be dropped.
--   * Normal rows (override_conflict=false) are unaffected and remain
--     protected throughout — the original constraint is restored before the
--     column is dropped.
--
-- IDEMPOTENT: every statement uses IF EXISTS / DO blocks. Safe to re-run.
-- =====================================================================

-- 1. Atomically DROP the extended-predicate constraint and ADD the ORIGINAL
--    constraint (no override exemption). Single DO block = single transaction:
--    an ADD failure rolls back the DROP, so the extended-predicate constraint
--    remains if the original cannot be restored. Idempotent.
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
    ) WHERE (status IN ('scheduled','confirmed'));
END $$;

-- 2. Drop the override_conflict column. Runs only after the DO block above
--    commits (the original constraint is restored). If active override rows
--    blocked the ADD, the DO block raised and this statement never executes.
ALTER TABLE appointments DROP COLUMN IF EXISTS override_conflict;