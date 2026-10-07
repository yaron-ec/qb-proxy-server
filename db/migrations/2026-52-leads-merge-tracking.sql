-- =====================================================================
-- 2026-52-leads-merge-tracking.sql — Add leads merge-tracking columns
--
-- routes/mergeLeads.js's POST /merge (admin-only lead dedup) soft-deletes
-- the merged-away lead with:
--   UPDATE leads SET status = 'DNQ', notes = ..., duplicate_merged = true,
--                    last_merge_date = NOW(), merge_count = COALESCE(...)+1
--                    ... WHERE id = $2
-- inside a single BEGIN/COMMIT transaction that also reassigns the merged
-- lead's activities/tasks/deals/invoices/appointments/estimates to the
-- surviving lead. None of these 3 columns were ever migrated, so this
-- UPDATE has always thrown "column duplicate_merged does not exist" —
-- which, because it's the last statement before COMMIT, rolled back the
-- ENTIRE merge (including the already-reassigned child records) on every
-- single use. The feature has never worked.
--
-- test/mergeLeads.test.js only asserts these fields appear in the route's
-- SOURCE TEXT (`src.includes('duplicate_merged = true')`), never against a
-- real Postgres instance, so this was never caught. The frontend already
-- ships full (hidden, system) field definitions for all three in
-- crm-frontend/src/components/properties/propertyDefinitions.jsx, so the
-- intended schema — not the code — was what was missing.
--
-- Startup-safe: additive columns only, ADD COLUMN IF NOT EXISTS.
-- =====================================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS duplicate_merged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_merge_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merge_count INTEGER NOT NULL DEFAULT 0;
