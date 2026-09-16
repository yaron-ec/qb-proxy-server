-- =====================================================================
-- 2026-39-company-settings-region.sql
--
-- Adds an admin-configurable operational region label to the
-- company_settings singleton (e.g. "SoCal", "NorCal", "SoCal + NorCal").
--
-- This is NOT a new tenancy/region data model — it does not scope any
-- other table and does not introduce multi-region routing/authorization.
-- It is purely a display label for the app shell (sidebar secondary
-- identity line), configured by an admin via Company Setup, so that
-- region is never inferred from an employee's name/email and never
-- hardcoded per company. NULL (default) means "not configured" — the
-- shell falls back to company_city/company_state, matching prior
-- behavior exactly.
--
-- Idempotent (IF NOT EXISTS). Safe to re-run.
-- Applied via: node db/migrate.js
-- =====================================================================

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS company_region TEXT;
