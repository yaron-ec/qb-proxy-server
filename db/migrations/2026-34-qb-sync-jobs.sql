-- 2026-34-qb-sync-jobs.sql
-- Track async QB sync jobs for the job/polling pattern.
-- The /sync/qb-estimates endpoint creates a job record, starts the sync in
-- the background, and returns the job ID immediately (202 Accepted). The
-- frontend polls GET /sync/qb-estimates/status/:jobId for progress.
--
-- This prevents the 30-second frontend timeout that occurred when the
-- synchronous runQbEstimateSync() took 60-300+ seconds to fetch all QB
-- estimates + customers from the Intuit API.

CREATE TABLE IF NOT EXISTS qb_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL DEFAULT 'estimate_sync',
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
  progress JSONB DEFAULT '{}', -- { found, fetched, matched, imported, updated, unmatched, errors }
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  triggered_by TEXT DEFAULT 'manual',
  force_full BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_qb_sync_jobs_status ON qb_sync_jobs (status);
CREATE INDEX IF NOT EXISTS idx_qb_sync_jobs_created ON qb_sync_jobs (started_at DESC);