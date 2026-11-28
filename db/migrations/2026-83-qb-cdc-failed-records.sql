-- 2026-83-qb-cdc-failed-records.sql
-- November 2026 final-acceptance follow-up, item 2 (CDC failure and
-- financial integrity): closes a real gap in lib/qbInboundSync.js's CDC
-- incremental sync (PR #88/#89) — when an individual Invoice/Payment item
-- in a CDC response fails to process (an upsert throws), the sync's own
-- watermark still advances past that item's own LastUpdatedTime (safe for
-- every item that DID succeed, since re-processing an already-upserted
-- record is idempotent) — but CDC's `changedSince` filter means that
-- SPECIFIC failed record will never be returned by a future CDC call
-- again unless QuickBooks changes it a second time. Idempotency alone
-- therefore does not guarantee the failed record is ever retried; without
-- this table, the only remaining safety net was the once-daily full
-- per-customer reconciliation (lib/qbInboundSync.js#syncAllMappedCustomers),
-- which can itself be deferred for an extended period by the quota-based
-- throttle (lib/qbApiUsageTracker.js#isNonEssentialSyncAllowed).
--
-- qb_cdc_failed_records stores the RAW CDC payload of every item that
-- failed to process, so a later retry can reprocess it directly — zero
-- additional QuickBooks API calls needed for the common case (a
-- transient DB error, or a dependency like the matching lead/deal not
-- existing yet at the moment of the original CDC tick, which may well
-- exist by the time of a later retry). See lib/qbInboundSync.js's
-- retryFailedCdcRecords() for the read/retry path.
CREATE TABLE IF NOT EXISTS qb_cdc_failed_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice', 'payment')),
  qb_id TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INT NOT NULL DEFAULT 1,
  last_error TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, qb_id)
);

-- Only unresolved rows matter for both the retry loop's own query and the
-- health check below — a partial index keeps both cheap indefinitely even
-- as resolved history accumulates.
CREATE INDEX IF NOT EXISTS idx_qb_cdc_failed_records_unresolved
  ON qb_cdc_failed_records (first_failed_at)
  WHERE resolved_at IS NULL;
