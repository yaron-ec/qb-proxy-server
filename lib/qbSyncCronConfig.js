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
 * reconciliation cron alone projected to roughly 599,000 calls/month
 * (104 × 2 × 96 ticks/day × 30) — already over that 500K quota on its own.
 * Default was first raised from 15 to 60 minutes here as an immediate
 * mitigation (quartering this cron's call volume without changing WHAT it
 * synced).
 *
 * SUPERSEDED (November 2026 "QB API consumption root-cause investigation"
 * follow-up, confirmed against OFFICIAL Intuit Developer Portal usage data:
 * query/invoice + query/payment = 402,355 of 500,766 total calls, 80.3%):
 * this interval now governs lib/qbInboundSync.js#syncInvoicesPaymentsIncremental
 * instead of the old per-customer full-refetch loop — a company-wide,
 * Change-Data-Capture-based incremental sync (1-2 real calls total per
 * tick, covering EVERY mapped customer's changes at once, instead of 2
 * calls PER customer). That call-shape change is what actually reduces
 * cost by ~97%+ (confirmed via the per-tick math in CLAUDE.md's own QB API
 * consumption section) — not the interval alone — so the default is
 * lowered BACK to 15 minutes here: the 60-minute mitigation's entire
 * rationale (per-customer full-fetch cost) no longer applies to this now-
 * incremental path, and a shorter interval improves financial-data
 * freshness with no meaningful cost increase. The old, expensive full
 * per-customer reconciliation (lib/qbInboundSync.js#syncAllMappedCustomers)
 * still exists, completely unchanged, as a once-daily safety net — see
 * DEFAULT_FULL_RECONCILE_INTERVAL_HOURS below — never removed, only run far
 * less often now that the frequent path no longer needs its expensive
 * shape. Only a clean divisor or multiple of 60 is supported for the
 * incremental interval — an unsupported value falls back to the default
 * rather than silently misinterpreting it.
 */
const DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES = 15;

/**
 * QB_FULL_RECONCILE_INTERVAL_HOURS — the once-daily (default) safety-net
 * pass that still runs the ORIGINAL, unchanged, per-customer full
 * invoice/payment reconciliation (lib/qbInboundSync.js#syncAllMappedCustomers)
 * — catching anything the incremental CDC path's narrower scope could
 * theoretically miss (a genuine hard delete outside CDC's Deleted-status
 * reporting, a cursor-bridging edge case, general self-healing drift
 * correction) — per the explicit instruction never to blindly replace full
 * reconciliation without guaranteeing missed-event recovery and data
 * completeness. Writes its OWN cursor (`quickbooks_full_reconcile`,
 * distinct from the incremental path's `quickbooks_inbound_reconcile`) so
 * the two can be monitored independently and neither cadence's staleness
 * threshold has to compromise for the other.
 */
const DEFAULT_FULL_RECONCILE_INTERVAL_HOURS = 24;

function getFullReconcileIntervalHours() {
  const raw = process.env.QB_FULL_RECONCILE_INTERVAL_HOURS;
  const n = raw != null && raw !== '' ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_FULL_RECONCILE_INTERVAL_HOURS;
}

function fullReconcileCronExpression() {
  const hours = getFullReconcileIntervalHours();
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '0 3 * * *' : `0 3 */${days} * *`;
  }
  if (hours > 0 && hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  console.warn(`[qb-sync-cron-config] QB_FULL_RECONCILE_INTERVAL_HOURS=${hours} is not a clean divisor/multiple of 24 — falling back to the default ${DEFAULT_FULL_RECONCILE_INTERVAL_HOURS}-hour interval`);
  return '0 3 * * *';
}

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
  getFullReconcileIntervalHours,
  fullReconcileCronExpression,
  DEFAULT_FULL_RECONCILE_INTERVAL_HOURS,
};
