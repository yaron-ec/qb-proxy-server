-- 2026-32-backfill-handoff-estimates-sync-source.sql
-- Backfill sync_source for existing handoff_estimates records that have NULL.
-- Records with a qb_estimate_id are sourced from QuickBooks.
-- Records with only a handoff_estimate_id (no QB link) are sourced from Handoff.
UPDATE handoff_estimates SET sync_source = 'QuickBooks'
  WHERE sync_source IS NULL AND qb_estimate_id IS NOT NULL;
UPDATE handoff_estimates SET sync_source = 'Handoff'
  WHERE sync_source IS NULL AND handoff_estimate_id IS NOT NULL AND qb_estimate_id IS NULL;
UPDATE handoff_estimates SET sync_source = 'Handoff'
  WHERE sync_source IS NULL AND handoff_estimate_id IS NULL AND source = 'Handoff';