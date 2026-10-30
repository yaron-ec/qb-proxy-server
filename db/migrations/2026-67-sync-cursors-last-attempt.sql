-- 2026-67-sync-cursors-last-attempt.sql
--
-- October 2026 QuickBooks reliability recovery pass: sync_cursors previously
-- only tracked last_successful_sync_at, so there was no way to distinguish
-- "last time this cron succeeded" from "last time it ran at all" — a tick
-- that was entirely blocked by the rate-limit circuit breaker, or that
-- partially failed, left no record it ran at all. Forward-only, additive,
-- no data rewrite: every existing row's last_attempted_at is backfilled
-- from its own last_successful_sync_at (the best available prior evidence
-- of when it last ran), never null for a row that already has a success.
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;

UPDATE sync_cursors
SET last_attempted_at = last_successful_sync_at
WHERE last_attempted_at IS NULL AND last_successful_sync_at IS NOT NULL;
