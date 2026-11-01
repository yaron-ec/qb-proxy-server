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

module.exports = { isEstimateSyncCronEnabled };
