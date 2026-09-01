-- =====================================================================
-- 2026-19-migration-constraint-fixes.sql — ON CONFLICT constraint fixes
--
-- Horizontal audit of ALL migration scripts found 2 schema mismatches
-- where ON CONFLICT targets had no matching UNIQUE constraint/index in
-- the Railway schema:
--
--   1. company_settings.company_name
--      Used by: migrateSmallDatasetsToRailway.js
--      ON CONFLICT (company_name) DO UPDATE
--      Schema (2026-14): company_name TEXT NOT NULL — NO UNIQUE constraint
--      ROOT CAUSE of dry-run #1 transaction abort.
--
--   2. appointments.idempotency_key
--      Used by: migrateAppointmentsToRailway.js
--      ON CONFLICT (idempotency_key) DO UPDATE
--      Schema (2026-08): idempotency_key TEXT NOT NULL — NO UNIQUE constraint
--      (booking_idempotency is a SEPARATE table; not the same column)
--      Would fail once leads migration succeeds and appointments are tested.
--
-- Also promotes 2 self-created indexes to schema-level (previously created
-- dynamically inside data-migration scripts, not declared in any schema
-- migration file):
--
--   3. activities.external_ref
--      Used by: migrateActivitiesToRailway.js (self-creates column + index)
--      ON CONFLICT (external_ref) DO UPDATE
--      Schema (2026-09): no external_ref column at all
--
--   4. signnow_documents.external_ref
--      Used by: migrateSignNowDocumentsToRailway.js (self-creates column + index)
--      ON CONFLICT (external_ref) DO UPDATE
--      Schema (2026-16): no external_ref column at all
--
-- SAFETY: Each constraint addition is guarded by a duplicate check. If
-- duplicate values exist, the migration STOPS with an exception (fail-closed).
-- No constraint is added blindly.
--
-- IDEMPOTENT: IF NOT EXISTS on all DDL. Safe to re-run.
-- Applied via: node db/migrate.js
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. company_settings.company_name UNIQUE
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT company_name, COUNT(*) AS cnt
    FROM company_settings
    WHERE company_name IS NOT NULL
    GROUP BY company_name
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE company_name values found in company_settings (% groups) — cannot add UNIQUE constraint. Resolve duplicates first.', dup_count
      USING HINT = 'SELECT company_name, COUNT(*) FROM company_settings GROUP BY company_name HAVING COUNT(*) > 1';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS company_settings_company_name_uidx
  ON company_settings (company_name);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. appointments.idempotency_key UNIQUE
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT idempotency_key, COUNT(*) AS cnt
    FROM appointments
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE idempotency_key values found in appointments (% groups) — cannot add UNIQUE constraint. Resolve duplicates first.', dup_count
      USING HINT = 'SELECT idempotency_key, COUNT(*) FROM appointments GROUP BY idempotency_key HAVING COUNT(*) > 1';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_idempotency_key_uidx
  ON appointments (idempotency_key);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. activities.external_ref (promote self-created to schema-level)
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE activities ADD COLUMN IF NOT EXISTS external_ref TEXT;

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT external_ref, COUNT(*) AS cnt
    FROM activities
    WHERE external_ref IS NOT NULL
    GROUP BY external_ref
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE external_ref values found in activities (% groups) — cannot add UNIQUE index. Resolve duplicates first.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS activities_external_ref_idx
  ON activities (external_ref) WHERE external_ref IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. signnow_documents.external_ref (promote self-created to schema-level)
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS external_ref TEXT;

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT external_ref, COUNT(*) AS cnt
    FROM signnow_documents
    WHERE external_ref IS NOT NULL
    GROUP BY external_ref
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE external_ref values found in signnow_documents (% groups) — cannot add UNIQUE index. Resolve duplicates first.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS signnow_documents_external_ref_idx
  ON signnow_documents (external_ref) WHERE external_ref IS NOT NULL;