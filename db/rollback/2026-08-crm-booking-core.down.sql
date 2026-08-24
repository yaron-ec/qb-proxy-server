-- =====================================================================
-- CRM Booking Core Migration — DOWN MIGRATION (ROLLBACK)
-- File: db/rollback/2026-08-crm-booking-core.down.sql
--
-- Reverses db/migrations/2026-08-crm-booking-core.sql.
-- Run manually ONLY. Never auto-applied (lives outside db/migrations/).
--
-- Rollback order: exact reverse of the up migration.
--   1. base44_entity_map  (FK -> leads; no other deps)
--   2. projection_outbox  (FK -> leads; trigger + table + function)
--   3. leads columns: origin_system, projection_revision
--   4. calendar_outbox    (FK -> appointments; table)
--   5. appointments column: version
--   6. appointment_events (trigger + table + function; FK -> appointments)
--   7. booking_idempotency (FK -> leads, appointments; table)
--   8. appointments        (triggers + table + functions)
--   9. appointment_types   (table; seed data destroyed)
--  10. leads               (trigger + table + function)
--  11. owners              (trigger + table + function)
--  12. btree_gist extension: LEFT IN PLACE (shared extension; other present
--      or future objects may depend on it). Not dropped.
--
-- DATA LOSS ASSESSMENT:
--   * owners / leads / appointments / appointment_types / appointment_events /
--     booking_idempotency / calendar_outbox / projection_outbox /
--     base44_entity_map: ALL are destroyed with their data. This rollback is
--     intended ONLY to undo a failed/empty booking-core apply (before any
--     booking data exists). If real appointments/outbox rows exist, EXPORT
--     FIRST — rollback destroys them permanently.
--   * leads columns origin_system / projection_revision: values lost.
--
-- RECOMMENDED ROLLBACK WINDOW:
--   SAFE   : Anytime before the booking engine writes any data (zero data loss).
--   UNSAFE : After bookings/appointments/outbox rows exist (full data loss for
--            those tables) unless exported first.
--
-- NOTE: This rollback does NOT touch 2026-09-crm-core.sql (R1A) objects. If R1A
-- has also been applied, run 2026-09-crm-core.down.sql FIRST, then this file.
--
-- IDEMPOTENT: every statement uses IF EXISTS. Safe to re-run.
-- =====================================================================

-- 1. base44_entity_map
DROP TRIGGER IF EXISTS base44_entity_map_set_updated_at ON base44_entity_map;
DROP TABLE IF EXISTS base44_entity_map;
DROP FUNCTION IF EXISTS base44_entity_map_touch_updated_at();

-- 2. projection_outbox
DROP TRIGGER IF EXISTS projection_outbox_set_updated_at ON projection_outbox;
DROP TABLE IF EXISTS projection_outbox;
DROP FUNCTION IF EXISTS projection_outbox_touch_updated_at();

-- 3. leads columns added by booking-core (origin_system, projection_revision)
ALTER TABLE leads DROP COLUMN IF EXISTS origin_system;
ALTER TABLE leads DROP COLUMN IF EXISTS projection_revision;

-- 4. calendar_outbox
DROP TABLE IF EXISTS calendar_outbox;

-- 5. appointments column: version
ALTER TABLE appointments DROP COLUMN IF EXISTS version;

-- 6. appointment_events
DROP TRIGGER IF EXISTS appointment_events_no_update ON appointment_events;
DROP TABLE IF EXISTS appointment_events;
DROP FUNCTION IF EXISTS appointment_events_immutable();

-- 7. booking_idempotency
DROP TABLE IF EXISTS booking_idempotency;

-- 8. appointments (triggers, table, functions)
DROP TRIGGER IF EXISTS appointments_no_delete ON appointments;
DROP TRIGGER IF EXISTS appointments_set_updated_at ON appointments;
DROP TABLE IF EXISTS appointments;
DROP FUNCTION IF EXISTS appointments_no_delete();
DROP FUNCTION IF EXISTS appointments_touch_updated_at();

-- 9. appointment_types
DROP TABLE IF EXISTS appointment_types;

-- 10. leads (trigger, table, function)
DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
DROP TABLE IF EXISTS leads;
DROP FUNCTION IF EXISTS leads_touch_updated_at();

-- 11. owners (trigger, table, function)
DROP TRIGGER IF EXISTS owners_set_updated_at ON owners;
DROP TABLE IF EXISTS owners;
DROP FUNCTION IF EXISTS owners_touch_updated_at();

-- 12. btree_gist extension: intentionally LEFT IN PLACE (shared).
--     Re-enable the line below ONLY if this is the only consumer of btree_gist
--     on the target database and you are certain no other object depends on it.
-- DROP EXTENSION IF EXISTS btree_gist;