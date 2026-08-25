-- =====================================================================
-- 2026-20-fix-partial-unique-indexes.sql — Replace partial UNIQUE indexes
-- with non-partial UNIQUE indexes for ON CONFLICT inference
--
-- 2026-19 created partial unique indexes (WHERE col IS NOT NULL) on
-- activities.external_ref and signnow_documents.external_ref. PostgreSQL
-- CANNOT infer a partial index for `ON CONFLICT (col)` without an explicit
-- WHERE clause in the conflict target. The migration scripts use
-- `ON CONFLICT (external_ref) DO UPDATE` (no WHERE), so the partial indexes
-- are not matchable → "there is no unique or exclusion constraint matching
-- the ON CONFLICT specification".
--
-- Fix: DROP the partial indexes and CREATE non-partial UNIQUE indexes.
-- PostgreSQL allows multiple NULLs in a UNIQUE index (NULLs are not
-- considered equal), so rows with NULL external_ref do not conflict.
-- This makes ON CONFLICT (external_ref) inference work correctly.
--
-- Idempotent (DROP IF EXISTS + CREATE IF NOT EXISTS). Safe to re-run.
-- Applied via: node db/migrate.js
-- =====================================================================

-- ── activities.external_ref ────────────────────────────────────────────
DROP INDEX IF EXISTS activities_external_ref_idx;
CREATE UNIQUE INDEX IF NOT EXISTS activities_external_ref_idx
  ON activities (external_ref);

-- ── signnow_documents.external_ref ─────────────────────────────────────
DROP INDEX IF EXISTS signnow_documents_external_ref_idx;
CREATE UNIQUE INDEX IF NOT EXISTS signnow_documents_external_ref_idx
  ON signnow_documents (external_ref);