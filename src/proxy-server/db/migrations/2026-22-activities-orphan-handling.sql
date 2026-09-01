-- =====================================================================
-- 2026-22 — Activities orphan handling
--
-- Activities may reference Base44 lead_ids for leads that were deleted
-- from Base44 before migration. These are historical HubSpot email/meeting
-- records worth preserving. Make lead_id nullable and add original_lead_ref
-- to store the original Base44 lead_id for orphaned activities.
--
-- Idempotent. Safe to re-run.
-- =====================================================================

-- Allow NULL lead_id for orphaned activities (parent lead deleted)
ALTER TABLE activities ALTER COLUMN lead_id DROP NOT NULL;

-- Store the original Base44 lead_id for orphaned activities
ALTER TABLE activities ADD COLUMN IF NOT EXISTS original_lead_ref TEXT;

-- Index for orphan lookups
CREATE INDEX IF NOT EXISTS activities_original_lead_ref_idx
  ON activities (original_lead_ref) WHERE original_lead_ref IS NOT NULL;

-- Update the lead index to work with nullable lead_id
DROP INDEX IF EXISTS activities_lead_idx;
CREATE INDEX IF NOT EXISTS activities_lead_idx
  ON activities (lead_id, created_at DESC) WHERE lead_id IS NOT NULL;