/* eslint-disable no-undef */
'use strict';

/**
 * productionWatchdogQbRecoveryVerification.test.js — November 2026 CRM
 * final-acceptance requirement: "Recovery notifications must not be sent
 * merely because authentication succeeded or the circuit breaker closed.
 * They must accurately reflect whether dependent synchronization has also
 * caught up."
 *
 * Proves productionWatchdog.js#handleSuccess/handleFailure wire
 * lib/qbRecoveryVerification.js correctly for the `quickbooks-integration`
 * service specifically, while leaving every other service's existing
 * "Service recovered" notification completely unchanged (regression
 * guard at the bottom).
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { ensureSchema: async () => {}, query: async () => ({ rows: [] }) },
};

function freshWatchdog() {
  delete require.cache[require.resolve('../productionWatchdog')];
  return require('../productionWatchdog');
}

function baseStubs({ qbHealthy, otherHealthy = true, recordSuccessResolves = false, incidentId = 'inc-qb-1' } = {}) {
  const dispatchCalls = [];
  const restores = [];
  restores.push(stub('../lib/monitoring/healthProbes', {
    probeService: async (service) => {
      if (service.id === 'quickbooks-integration') {
        return qbHealthy
          ? { serviceId: service.id, healthy: true, checkType: 'qb_integration', error: null }
          : { serviceId: service.id, healthy: false, checkType: 'qb_integration', error: 'breaker open' };
      }
      return { serviceId: service.id, healthy: otherHealthy, checkType: 'ok', error: otherHealthy ? null : 'down' };
    },
  }));
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async (serviceId) => ({ incident: { id: incidentId, failure_count: 1 }, isNew: true, isCrashLoop: false }),
    recordSuccess: async (serviceId) => (recordSuccessResolves
      ? { resolved: true, incident: { id: incidentId } }
      : { resolved: false, incident: null }),
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  restores.push(stub('../lib/monitoring/knownGoodBaseline', { verifyAndPromote: async () => {}, getBaseline: async () => null }));
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async (opts) => { dispatchCalls.push(opts); return {}; } }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', { evaluateRecovery: () => ({ action: 'none', reason: 'n/a' }), isEscalationError: () => false }));
  restores.push(stub('../lib/monitoring/railwayApiClient', { checkCapabilities: async () => ({ canRestart: false, reason: 'read-only token' }) }));
  // November 2026 final-acceptance follow-up, item 1: productionWatchdog.js
  // now also calls lib/qbAcceptanceReportScheduler.js for quickbooks-
  // integration — stubbed here (own dedicated coverage lives in
  // test/qbAcceptanceReportScheduler.test.js) so this file keeps testing
  // only the qbRecoveryVerification wiring it was written for.
  restores.push(stub('../lib/qbAcceptanceReportScheduler', {
    startSchedule: async () => 'schedule-1',
    supersedeActiveSchedule: async () => {},
    processDueReports: async () => ({ processed: false, reason: 'no_active_schedule' }),
  }));
  return { dispatchCalls, restores };
}

test('resolving the quickbooks-integration incident starts pending verification instead of immediately dispatching a "recovered" email', async () => {
  const calls = { markRecoveryPending: [], maybeNotifyVerifiedRecovery: [] };
  const { dispatchCalls, restores } = baseStubs({ qbHealthy: true, recordSuccessResolves: true });
  restores.push(stub('../lib/qbRecoveryVerification', {
    markRecoveryPending: async (incidentId) => { calls.markRecoveryPending.push(incidentId); },
    clearOnFailure: async () => {},
    maybeNotifyVerifiedRecovery: async (sendFn) => { calls.maybeNotifyVerifiedRecovery.push(sendFn); return { notified: false, reason: 'not_caught_up_yet' }; },
  }));

  try {
    const { runWatchdog } = freshWatchdog();
    await runWatchdog();
    assert.deepStrictEqual(calls.markRecoveryPending, ['inc-qb-1'], 'must start pending verification for this incident');
    assert.strictEqual(calls.maybeNotifyVerifiedRecovery.length, 1, 'must also check on this same tick whether it is already caught up');
    assert.strictEqual(
      dispatchCalls.some((c) => c.serviceId === 'quickbooks-integration' && c.errorType === 'recovery'),
      false,
      'the generic, unverified "recovered" alert must NEVER be dispatched for quickbooks-integration'
    );
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});

test('once dependent sync is verified caught up, exactly one "recovery_verified_sync_caught_up" email is dispatched with real evidence', async () => {
  const { dispatchCalls, restores } = baseStubs({ qbHealthy: true, recordSuccessResolves: false });
  restores.push(stub('../lib/qbRecoveryVerification', {
    markRecoveryPending: async () => {},
    clearOnFailure: async () => {},
    maybeNotifyVerifiedRecovery: async (sendFn) => {
      await sendFn(
        { incidentId: 'inc-qb-1' },
        { caughtUp: true, evidence: { estimate_sync: { last_successful_sync_at: '2026-11-25T20:00:00Z' }, inbound_reconcile: { last_successful_sync_at: '2026-11-25T20:05:00Z' } } }
      );
      return { notified: true };
    },
  }));

  try {
    const { runWatchdog } = freshWatchdog();
    await runWatchdog();
    const call = dispatchCalls.find((c) => c.serviceId === 'quickbooks-integration' && c.errorType === 'recovery_verified_sync_caught_up');
    assert.ok(call, 'a verified-recovery alert must be dispatched once catch-up is confirmed');
    assert.strictEqual(call.level, 'info');
    assert.match(call.errorSummary, /2026-11-25T20:00:00Z/, 'must include the real estimate-sync evidence timestamp');
    assert.match(call.errorSummary, /2026-11-25T20:05:00Z/, 'must include the real inbound-reconciliation evidence timestamp');
    assert.strictEqual(call.incidentId, 'inc-qb-1');
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});

test('a fresh quickbooks-integration failure clears any stale pending verification', async () => {
  const calls = { clearOnFailure: 0 };
  const { restores } = baseStubs({ qbHealthy: false });
  restores.push(stub('../lib/qbRecoveryVerification', {
    markRecoveryPending: async () => {},
    clearOnFailure: async () => { calls.clearOnFailure++; },
    maybeNotifyVerifiedRecovery: async () => ({ notified: false }),
  }));

  try {
    const { runWatchdog } = freshWatchdog();
    await runWatchdog();
    assert.strictEqual(calls.clearOnFailure, 1, 'a new QB failure must clear any stale pending-verification marker');
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});

test('regression guard: every OTHER service keeps its original, unverified "recovered" notification unchanged', async () => {
  const { dispatchCalls, restores } = baseStubs({ qbHealthy: true, otherHealthy: true });
  // Make a non-QB service resolve an incident too, to prove its path is untouched.
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async () => ({ incident: { id: 'inc-other', failure_count: 1 }, isNew: true, isCrashLoop: false }),
    recordSuccess: async (serviceId) => (serviceId !== 'quickbooks-integration'
      ? { resolved: true, incident: { id: 'inc-other' } }
      : { resolved: false, incident: null }),
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  restores.push(stub('../lib/qbRecoveryVerification', {
    markRecoveryPending: async () => {},
    clearOnFailure: async () => {},
    maybeNotifyVerifiedRecovery: async () => ({ notified: false }),
  }));

  try {
    const { runWatchdog } = freshWatchdog();
    await runWatchdog();
    const nonQbRecovered = dispatchCalls.filter((c) => c.serviceId !== 'quickbooks-integration' && c.errorType === 'recovery');
    assert.ok(nonQbRecovered.length > 0, 'at least one non-QB service must still send its original, unverified "recovered" notification exactly as before');
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});
