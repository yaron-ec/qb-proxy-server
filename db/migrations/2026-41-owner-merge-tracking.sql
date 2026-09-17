-- =====================================================================
-- 2026-41-owner-merge-tracking.sql — Additive columns supporting
-- POST /api/v1/owners/merge (routes/owners.js).
--
-- A duplicate owner is never physically deleted by the merge endpoint —
-- it is deactivated (is_active = false, already an existing, respected
-- filter everywhere owners are listed for assignment) and tagged with
-- where it went, so:
--   - every existing "active owners" query (GET /api/v1/owners, lead/deal
--     owner pickers, resolveOwnerScope, etc.) automatically stops
--     surfacing it with NO code change beyond this migration.
--   - the merge is traceable later without a separate audit table.
--
-- Purely additive (nullable columns, IF NOT EXISTS) — safe to apply
-- against the current production schema, no backfill required.
-- =====================================================================

ALTER TABLE owners ADD COLUMN IF NOT EXISTS merged_into_owner_id UUID REFERENCES owners(id);
ALTER TABLE owners ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS owners_merged_into_idx ON owners (merged_into_owner_id) WHERE merged_into_owner_id IS NOT NULL;
