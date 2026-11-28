-- 2026-84-qb-acceptance-report-schedule.sql
-- November 2026 final-acceptance follow-up, item 1 (durable automatic
-- acceptance reporting): a single, durable row per genuine QuickBooks
-- recovery event, anchored on the SAME "verified recovery" timestamp
-- lib/qbRecoveryVerification.js#isQbSyncCaughtUp already establishes
-- (breaker closed + both sync cursors genuinely caught up) — never a
-- second, independently-computed timestamp. lib/qbAcceptanceReportScheduler.js
-- reads/writes this table from inside the existing production watchdog
-- cron tick (productionWatchdog.js, already running every ~15 minutes in
-- artistic-determination, completely independent of any Claude session)
-- to automatically email the 24h/72h/7-day acceptance reports to staff —
-- no new cron, no new service, no new QuickBooks API calls.
--
-- Only one row may be "active" (superseded_at IS NULL) at a time — a
-- fresh QuickBooks failure before a schedule completes marks it
-- superseded (see lib/qbAcceptanceReportScheduler.js#supersedeActiveSchedule)
-- so a later, genuinely new recovery is never confused with it and old
-- reports are never sent for a recovery that didn't actually hold.
CREATE TABLE IF NOT EXISTS qb_acceptance_report_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_verified_at TIMESTAMPTZ NOT NULL,
  report_24h_sent_at TIMESTAMPTZ,
  report_72h_sent_at TIMESTAMPTZ,
  report_7d_sent_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qb_acceptance_report_schedule_active
  ON qb_acceptance_report_schedule (recovery_verified_at)
  WHERE superseded_at IS NULL;
