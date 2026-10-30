'use strict';

/**
 * syncOutcome — a single, shared classifier for "how did this sync tick go?"
 * used by both the QB Estimate Sync cron and the QB Inbound Reconciliation
 * cron's sync_cursors bookkeeping (server.js), so the Integrations page can
 * show a real, honest status instead of a hardcoded "Last Sync: Never".
 *
 *   'no_work'  — nothing needed attempting (e.g. zero mapped customers).
 *   'success'  — everything attempted succeeded, the run completed normally.
 *   'partial'  — some items succeeded, some failed and/or the breaker
 *                stopped the run early after at least one success.
 *   'blocked'  — the circuit breaker was already open before/at the very
 *                first item, so nothing could be attempted at all.
 *   'failed'   — the run completed (not breaker-blocked) but every attempted
 *                item failed.
 */
function classifySyncOutcome({ attempted = 0, succeeded = 0, failed = 0, stoppedEarly = false }) {
  if (!attempted) return 'no_work';
  if (stoppedEarly && succeeded === 0) return 'blocked';
  if (stoppedEarly) return 'partial';
  if (failed > 0 && succeeded === 0) return 'failed';
  if (failed > 0) return 'partial';
  return 'success';
}

/** Whether this outcome should advance last_successful_sync_at. Only a
 * clean, uninterrupted run counts — 'partial'/'blocked'/'failed' advance
 * only last_attempted_at, so "last successful" never silently includes a
 * run that didn't actually finish the job. */
function isSuccessfulOutcome(outcome) {
  return outcome === 'success' || outcome === 'no_work';
}

module.exports = { classifySyncOutcome, isSuccessfulOutcome };
