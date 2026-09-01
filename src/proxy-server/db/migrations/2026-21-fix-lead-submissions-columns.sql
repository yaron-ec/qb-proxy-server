-- =====================================================================
-- 2026-21-fix-lead-submissions-columns.sql — Add missing external_ref and
-- updated_at to lead_submissions
--
-- ROOT CAUSE: The lead_submissions table was created by
-- 2026-16-signnow-and-submissions.sql WITHOUT external_ref or updated_at.
-- 2026-14-crm-remaining-tables.sql would have created it WITH both columns,
-- but 2026-16 was deployed first. Since CREATE TABLE IF NOT EXISTS is a
-- no-op when the table exists, 2026-14's column definitions never applied.
--
-- The migration script migrateLeadSubmissionsToRailway.js uses:
--   ON CONFLICT (external_ref) DO UPDATE SET ... updated_at = NOW()
-- which requires both columns to exist.
--
-- Fix: ALTER TABLE ADD COLUMN IF NOT EXISTS for both + UNIQUE index.
--
-- Idempotent. Applied via: node db/migrate.js
-- =====================================================================

ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE lead_submissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT external_ref, COUNT(*) AS cnt
    FROM lead_submissions
    WHERE external_ref IS NOT NULL
    GROUP BY external_ref
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE external_ref values found in lead_submissions (% groups) — cannot add UNIQUE index. Resolve duplicates first.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS lead_submissions_external_ref_idx
  ON lead_submissions (external_ref);