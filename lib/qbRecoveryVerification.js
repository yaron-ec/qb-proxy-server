/* eslint-disable no-undef */
'use strict';

/**
 * qbRecoveryVerification — ensures a "QuickBooks recovered" notification
 * genuinely reflects that dependent synchronization has caught up, never
 * merely that OAuth authentication succeeded or the shared circuit breaker
 * (lib/qbRateLimitBreaker.js) closed.
 *
 * Built for the November 2026 CRM final-acceptance request's explicit
 * requirement: "Recovery notifications must not be sent merely because
 * authentication succeeded or the circuit breaker closed. They must
 * accurately reflect whether dependent synchronization has also caught
 * up." Before this, productionWatchdog.js#handleSuccess sent its "Service
 * recovered" email for `quickbooks-integration` the instant
 * lib/monitoring/healthProbes.js#checkQbHealth reported healthy — which
 * only ever checks OAuth credential validity + the breaker's own state,
 * never whether a real sync tick has actually succeeded since recovery.
 *
 * DESIGN: when the watchdog's crash-loop detector resolves a
 * `quickbooks-integration` incident (the breaker/credential look healthy
 * again), that does NOT by itself send a notification. Instead it starts a
 * "pending verification" marker (durable, in `app_settings` — survives a
 * restart/replica change, same convention as qbRateLimitBreaker.js's own
 * state). Every subsequent healthy watchdog tick re-checks whether
 * dependent sync has genuinely caught up (both the QB Estimate Sync and QB
 * Inbound Reconciliation cursors show a real SUCCESSFUL run — not merely
 * an attempt — timestamped at or after the moment the breaker closed).
 * Only once that is true does exactly ONE "verified recovery" email go out,
 * carrying the actual evidence (the two cursors' own timestamps/outcomes)
 * rather than a bare "it's fixed" claim.
 *
 * This never blocks or delays the breaker/credential recovery itself —
 * sync resumes automatically as soon as the breaker closes, completely
 * independent of this module (see lib/qbRateLimitBreaker.js,
 * server.js's two QB crons). This module governs ONLY whether and when the
 * human-facing "recovered" notification is sent.
 */

const db = require('../db/client');

const PENDING_KEY = 'qb_recovery_pending_verification';

// Dependency-injection seam for tests — mirrors the convention already
// established by lib/qbApiUsageTracker.js / lib/qbCustomerCache.js.
const DEFAULT_DEPS = {
  query: (...args) => db.query(...args),
  getBreakerState: () => require('./qbRateLimitBreaker').getState(),
  getQbSyncStatus: () => require('./qbSyncStatus').getQbSyncStatus(),
};
let deps = { ...DEFAULT_DEPS };
function _setDeps(overrides) { deps = { ...deps, ...overrides }; }
function _resetDeps() { deps = { ...DEFAULT_DEPS }; }

async function getPending() {
  const r = await deps.query(`SELECT value FROM app_settings WHERE key = $1`, [PENDING_KEY]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function setPending(value) {
  await deps.query(
    `INSERT INTO app_settings (key, value, type) VALUES ($1, $2::jsonb, 'json')
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [PENDING_KEY, JSON.stringify(value)]
  );
}

/**
 * Called the moment the watchdog's crash-loop detector resolves a
 * `quickbooks-integration` incident — starts (or restarts) tracking for
 * this specific recovery event. Never itself sends a notification.
 */
async function markRecoveryPending(incidentId) {
  await setPending({ incidentId, since: new Date().toISOString(), notified: false });
}

/**
 * Called whenever `quickbooks-integration` is reported unhealthy again —
 * clears any stale pending-verification marker from an earlier recovery
 * attempt that never actually completed, so a later, genuinely new
 * recovery is never confused with it (and so a now-irrelevant "verified
 * recovery" email can never fire for a service that has since failed
 * again). Best-effort; never throws.
 */
async function clearOnFailure() {
  try {
    await setPending(null);
  } catch (e) {
    console.warn('[qb-recovery-verification] clearOnFailure failed (non-fatal): ' + e.message);
  }
}

/**
 * The actual catch-up check — read-only, never mutates anything. Requires
 * the breaker to be genuinely CLOSED (never merely "half-open trial
 * succeeded once") AND both QB sync cursors to show a real SUCCESSFUL run
 * timestamped at or after the breaker's own last close transition. A
 * cursor that has literally never run yet (`ever_run: false`) is not
 * evidence of a failed catch-up — a brand-new installation is never stuck
 * "unverified" forever.
 */
async function isQbSyncCaughtUp() {
  const state = await deps.getBreakerState();
  if (state.state !== 'closed') {
    return { caughtUp: false, reason: 'breaker_not_closed', breakerState: state.state };
  }
  const recoveredAt = state.last_transition_at ? new Date(state.last_transition_at) : null;

  let status;
  try {
    status = await deps.getQbSyncStatus();
  } catch (e) {
    return { caughtUp: false, reason: 'sync_status_unavailable', error: e.message };
  }

  const evidence = {};
  for (const key of ['estimate_sync', 'inbound_reconcile']) {
    const cursor = status[key];
    evidence[key] = cursor || null;
    if (!cursor || cursor.available === false) {
      return { caughtUp: false, reason: `${key}_unavailable`, evidence };
    }
    if (!cursor.ever_run) continue; // never ticked at all yet — not evidence of a failed catch-up
    const lastSuccess = cursor.last_successful_sync_at ? new Date(cursor.last_successful_sync_at) : null;
    if (!lastSuccess || (recoveredAt && lastSuccess.getTime() < recoveredAt.getTime())) {
      return { caughtUp: false, reason: `${key}_not_yet_resynced_since_recovery`, recoveredAt, evidence };
    }
  }
  return { caughtUp: true, recoveredAt, evidence };
}

/**
 * Called on every healthy `quickbooks-integration` watchdog tick. If a
 * recovery is pending verification and sync has now genuinely caught up,
 * invokes `sendFn(pending, caughtUp)` exactly once for this recovery event
 * and marks it notified. No-ops (never calls sendFn) when there is nothing
 * pending, it was already notified, or catch-up isn't confirmed yet — a
 * later tick will try again. Never throws back to the caller.
 */
async function maybeNotifyVerifiedRecovery(sendFn) {
  try {
    const pending = await getPending();
    if (!pending || pending.notified) return { notified: false, reason: 'no_pending_verification' };
    const caughtUp = await isQbSyncCaughtUp();
    if (!caughtUp.caughtUp) return { notified: false, reason: caughtUp.reason, caughtUp };
    await sendFn(pending, caughtUp);
    await setPending({ ...pending, notified: true, notified_at: new Date().toISOString() });
    return { notified: true };
  } catch (e) {
    console.warn('[qb-recovery-verification] maybeNotifyVerifiedRecovery failed (non-fatal): ' + e.message);
    return { notified: false, reason: 'error', error: e.message };
  }
}

module.exports = {
  markRecoveryPending,
  clearOnFailure,
  isQbSyncCaughtUp,
  maybeNotifyVerifiedRecovery,
  _getPending: getPending,
  _setDeps,
  _resetDeps,
};
