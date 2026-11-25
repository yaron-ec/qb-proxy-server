'use strict';

/**
 * qbSyncCronConfig — the ONE place QB_SYNC_CRON_ENABLED is interpreted,
 * shared by server.js (which actually gates the QB Estimate Sync cron's
 * registration) and lib/systemHealthChecks.js (which needs the SAME answer
 * to correctly label the "Handoff Estimates (via QuickBooks)" health card
 * as scheduled-sync-disabled rather than a generic staleness warning).
 *
 * November 2026 investigation: System Health showed "Degraded" with a
 * stale last-sync timestamp while Railway env vars showed
 * QB_SYNC_CRON_ENABLED=false — the health check had no way to say WHY the
 * cron looked dead (disabled vs. crashing vs. never deployed) because it
 * never read this flag at all. Keeping the flag's interpretation in one
 * module — rather than duplicating `=== 'false'` in two files — avoids the
 * exact class of bug this codebase already paid for once with the
 * QB_ENVIRONMENT/QB_SANDBOX split (see lib/qbEnvironment.js's header):
 * two call sites silently disagreeing about the same on/off switch.
 *
 * Default: enabled. Only the literal string 'false' turns it off — any
 * other value (including unset) leaves the cron running, matching the
 * comment server.js has carried since this flag was introduced.
 */
function isEstimateSyncCronEnabled() {
  return process.env.QB_SYNC_CRON_ENABLED !== 'false';
}

/**
 * QB_INBOUND_RECONCILE_INTERVAL_MINUTES — November 2026 "sustained 429
 * never recovers" incident: real production logs showed the Intuit error
 * body itself reading "You have reached the monthly limit of 500K CorePlus
 * API calls" — a genuine, longer-horizon PROVIDER QUOTA EXHAUSTION, not a
 * transient blip. At the mapped-customer count observed in those same logs
 * (104), lib/qbInboundSync.js's own 15-minute, ~2-calls-per-customer
 * reconciliation cron alone projects to roughly 599,000 calls/month
 * (104 × 2 × 96 ticks/day × 30) — already over that 500K quota on its own,
 * with zero bug, overlap, or excessive retry required; the Estimate Sync
 * cron's own call volume and any manual/webhook-triggered syncs are
 * additional. This is this one cron's dominant, O(customer-count) share of
 * total QuickBooks call volume, the one lever that reduces it the most for
 * the least risk: it does not change what gets synced, only how often —
 * the near-real-time path (the QB webhook) is unaffected either way; this
 * cron has always been documented as its "scheduled recovery fallback."
 * Default raised from 15 to 60 minutes (quartering this cron's own share of
 * monthly call volume); configurable per-installation as the mapped-
 * customer count grows. Only a clean divisor or multiple of 60 is
 * supported (the only shapes any installation of this cron actually
 * needs) — an unsupported value falls back to the default rather than
 * silently misinterpreting it.
 */
const DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES = 60;

function getInboundReconcileIntervalMinutes() {
  const raw = process.env.QB_INBOUND_RECONCILE_INTERVAL_MINUTES;
  const n = raw != null && raw !== '' ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES;
}

function inboundReconcileCronExpression() {
  const minutes = getInboundReconcileIntervalMinutes();
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
  }
  console.warn(`[qb-sync-cron-config] QB_INBOUND_RECONCILE_INTERVAL_MINUTES=${minutes} is not a clean divisor/multiple of 60 — falling back to the default ${DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES}-minute interval`);
  return '0 * * * *';
}

module.exports = {
  isEstimateSyncCronEnabled,
  getInboundReconcileIntervalMinutes,
  inboundReconcileCronExpression,
  DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES,
};
