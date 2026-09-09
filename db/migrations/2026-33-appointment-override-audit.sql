-- 2026-33-appointment-override-audit.sql
--
-- Admin Override Contract: replaces the exclusion constraint with
-- advisory-lock + transaction conflict check, and adds audit columns.
--
-- Design:
--   The exclusion constraint is replaced by a shared application-level
--   conflict check that runs inside a PostgreSQL transaction with a
--   transaction-scoped advisory lock on the owner schedule. This provides
--   equivalent atomic protection against concurrent normal double-booking
--   while allowing authorized admin overrides.
--
--   override_authorized / override_authorized_by / override_authorized_at
--   are AUDIT metadata only. They are NOT used to exempt rows from
--   conflict detection. Overridden appointments still block future normal
--   bookings.
--
-- Deployment safety:
--   The migration runs at boot (db/migrate.js) before the new code serves
--   traffic. Railway single-service deploy: old container stops, migration
--   runs, new container starts with advisory-lock conflict check. No
--   protection gap.
--
-- REVERSIBLE: re-add the exclusion constraint with:
--   ALTER TABLE appointments ADD CONSTRAINT appointments_no_active_overlap
--   EXCLUDE USING gist (owner_id WITH =, busy_range WITH &&)
--   WHERE (status IN ('scheduled','confirmed'));

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS override_authorized BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS override_authorized_by TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS override_authorized_at TIMESTAMPTZ;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_active_overlap;
