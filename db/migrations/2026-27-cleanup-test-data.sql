-- =====================================================================
-- 2026-27-cleanup-test-data.sql — Remove disposable E2E test records
--
-- The Lead-delete E2E verification (admin/verify-lead-delete) created
-- disposable test leads, appointments, reminder claims, and activities
-- during repair iterations. The first two runs failed before cleanup,
-- leaving orphaned test data. This migration safely removes all of it.
--
-- Test data signatures:
--   leads.external_ref LIKE 'fk-test-%'
--   leads.email LIKE '%@test.local'
--   leads.first_name = 'FKTest' AND last_name = 'DeleteTest'
--   appointments.idempotency_key LIKE 'fk-test-%'
--   reminder_claims.reminder_key LIKE 'fk-test:%'
--
-- Safety:
--   - Appointments are IMMUTABLE (no physical DELETE). Active test
--     appointments are CANCELLED, then lead_id is SET NULL by the FK.
--   - All other test records are physically deleted.
--   - No production data is touched (all predicates use test signatures).
-- =====================================================================

-- 1. Cancel any still-active test appointments (immutability-safe)
UPDATE appointments
SET status = 'cancelled', version = COALESCE(version, 1) + 1, updated_at = NOW()
WHERE idempotency_key LIKE 'fk-test-%'
  AND status IN ('scheduled', 'confirmed');

-- 2. Clean up reminder text refs for test leads (TEXT lead_id, no FK)
DELETE FROM reminder_claims WHERE reminder_key LIKE 'fk-test:%';
DELETE FROM reminder_activity_queue WHERE lead_id IN (
  SELECT id::text FROM leads WHERE external_ref LIKE 'fk-test-%' OR email LIKE '%@test.local'
);
UPDATE reminder_runs SET last_reminder_lead_id = NULL
WHERE last_reminder_lead_id IN (
  SELECT id::text FROM leads WHERE external_ref LIKE 'fk-test-%' OR email LIKE '%@test.local'
);

-- 3. Delete test leads (FK CASCADE handles activities, tasks, invoices, etc.)
--     FK SET NULL handles appointments and deals.
DELETE FROM leads
WHERE external_ref LIKE 'fk-test-%'
   OR email LIKE '%@test.local'
   OR (first_name = 'FKTest' AND last_name = 'DeleteTest');

-- 4. Cancel any orphaned test appointments (lead_id already NULL from prior runs)
UPDATE appointments
SET status = 'cancelled', version = COALESCE(version, 1) + 1, updated_at = NOW()
WHERE idempotency_key LIKE 'fk-test-%'
  AND status IN ('scheduled', 'confirmed');