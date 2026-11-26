/* eslint-disable no-undef */
'use strict';

/**
 * productionWatchdogRecoveryExecution.test.js — November 2026 P0 outage
 * follow-up.
 *
 * Found during the incident: lib/monitoring/recoveryPolicy.js#evaluateRecovery
 * only ever RETURNED a decision ("restart recommended"); productionWatchdog.js's
 * own attemptSafeRecovery() function, which would have actually called
 * railwayApiClient.restartService(), had ZERO call sites anywhere in the
 * codebase. The alert email's own "AUTO_RECOVERY_ATTEMPTED: restart" /
 * "AUTO_RECOVERY_RESULT: ...One controlled restart permitted." text was
 * therefore pure fiction — nothing was ever restarted automatically. Two
 * production services (qb-proxy-server, noble-illumination) stayed crashed
 * for roughly three hours until a human intervened.
 *
 * Fixed: handleFailure() now calls executeRecovery(), which actually invokes
 * railwayApiClient.restartService() when safe, bounded to exactly one
 * attempt per open incident (persisted on monitoring_incidents.recovery_action,
 * via recordRecoveryOutcome()) and reflects the REAL outcome in the alert.
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

function freshWatchdog() {
  delete require.cache[require.resolve('../productionWatchdog')];
  return require('../productionWatchdog');
}

function baseStubs({ restartResult, caps, dbUpdates } = {}) {
  const restores = [];
  restores.push(stub('../lib/monitoring/knownGoodBaseline', { verifyAndPromote: async () => {}, getBaseline: async () => null }));
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async (opts) => opts }));
  restores.push(stub('../lib/monitoring/railwayApiClient', {
    checkCapabilities: async () => caps || { canRestart: true, reason: 'ok' },
    restartService: async (projectId, serviceId) => {
      dbUpdates?.restartCalls?.push({ projectId, serviceId });
      return restartResult || { success: true, restartId: 'restart-1' };
    },
  }));
  const dbPath = require.resolve('../db/client');
  const prevDb = require.cache[dbPath];
  delete require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      ensureSchema: async () => {},
      query: async (sql, params) => {
        if (sql.includes('UPDATE monitoring_incidents SET recovery_action')) {
          dbUpdates?.recoveryUpdates?.push({ incidentId: params[0], action: params[1], outcome: params[2] });
        }
        return { rows: [] };
      },
    },
  };
  restores.push(() => { if (prevDb) require.cache[dbPath] = prevDb; else delete require.cache[dbPath]; });
  return restores;
}

test('executeRecovery actually calls railwayApi.restartService for an eligible, non-circuit-breaker service with Railway IDs on a brand-new incident, and verifies health before confirming recovery', async () => {
  const dbUpdates = { restartCalls: [], recoveryUpdates: [] };
  const restores = baseStubs({ dbUpdates });
  let recordSuccessCalls = 0;
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async () => ({ incident: { id: 42, failure_count: 1, recovery_action: null, recovery_result: null }, isNew: true, isCrashLoop: false }),
    recordSuccess: async (id) => { recordSuccessCalls++; return { resolved: true, incident: { id: 42 } }; },
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', {
    evaluateRecovery: () => ({ action: 'restart', reason: 'Transient failure on previously-healthy service. One controlled restart permitted.' }),
    isEscalationError: () => false,
  }));
  // Health check is independently polled AFTER the restart — never trusted
  // from the restartService() API call alone. Stub it to report healthy
  // on the very first poll so this test doesn't actually wait 90s.
  restores.push(stub('../lib/monitoring/healthProbes', {
    probeService: async (service) => ({ serviceId: service.id, healthy: true, checkType: 'http', httpStatus: 200 }),
  }));
  const alerts = [];
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async (opts) => { alerts.push(opts); return opts; } }));
  try {
    const { handleFailure } = freshWatchdog();
    const service = { id: 'qb-proxy-server', railwayProjectId: 'proj-1', railwayServiceId: 'svc-1' };
    await handleFailure(service, { error: 'fetch failed', checkType: 'http' });
    assert.strictEqual(dbUpdates.restartCalls.length, 1, 'restartService must actually be called');
    assert.deepStrictEqual(dbUpdates.restartCalls[0], { projectId: 'proj-1', serviceId: 'svc-1' });
    assert.strictEqual(dbUpdates.recoveryUpdates.length, 2, 'the real outcome is persisted once for the restart attempt and once for the verified result');
    assert.match(dbUpdates.recoveryUpdates[0].outcome, /Restart triggered via Railway API/);
    assert.match(dbUpdates.recoveryUpdates[1].outcome, /VERIFIED healthy/);
    assert.strictEqual(recordSuccessCalls, 1, 'a verified recovery must resolve the incident immediately, not wait for the next regular tick');
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].level, 'info');
    assert.strictEqual(alerts[0].errorType, 'recovery_verified');
    assert.strictEqual(alerts[0].incidentId, 42);
  } finally {
    restores.forEach((r) => r());
  }
});

test('when a restart is triggered but the service never becomes healthy, escalate with a distinct critical "recovery_failed" alert instead of claiming success', async () => {
  const dbUpdates = { restartCalls: [], recoveryUpdates: [] };
  const restores = baseStubs({ dbUpdates });
  let recordSuccessCalls = 0;
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async () => ({ incident: { id: 43, failure_count: 1, recovery_action: null, recovery_result: null }, isNew: true, isCrashLoop: false }),
    recordSuccess: async () => { recordSuccessCalls++; return { resolved: false, incident: null }; },
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', {
    evaluateRecovery: () => ({ action: 'restart', reason: 'Transient failure on previously-healthy service. One controlled restart permitted.' }),
    isEscalationError: () => false,
  }));
  restores.push(stub('../lib/monitoring/healthProbes', {
    // Always unhealthy — the restart "succeeded" per the API, but the
    // service never actually comes back up.
    probeService: async (service) => ({ serviceId: service.id, healthy: false, checkType: 'http', error: 'fetch failed' }),
  }));
  const alerts = [];
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async (opts) => { alerts.push(opts); return opts; } }));
  // Shrink the poll window via its test-only env var override (see
  // productionWatchdog.js's own header on RESTART_VERIFY_TIMEOUT_MS) so
  // this test proves the real timeout-then-escalate path without taking 90
  // real seconds.
  const prevTimeout = process.env.WATCHDOG_RESTART_VERIFY_TIMEOUT_MS;
  const prevInterval = process.env.WATCHDOG_RESTART_VERIFY_INTERVAL_MS;
  process.env.WATCHDOG_RESTART_VERIFY_TIMEOUT_MS = '30';
  process.env.WATCHDOG_RESTART_VERIFY_INTERVAL_MS = '10';
  try {
    const { handleFailure } = freshWatchdog();
    const service = { id: 'qb-proxy-server', railwayProjectId: 'proj-1', railwayServiceId: 'svc-1' };
    await handleFailure(service, { error: 'fetch failed', checkType: 'http' });
    assert.strictEqual(recordSuccessCalls, 0, 'must never resolve the incident when verification failed');
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].level, 'critical');
    assert.strictEqual(alerts[0].errorType, 'recovery_failed');
    assert.strictEqual(alerts[0].incidentId, 43);
    assert.match(alerts[0].recoveryResult, /Verification FAILED/);
  } finally {
    restores.forEach((r) => r());
    if (prevTimeout === undefined) delete process.env.WATCHDOG_RESTART_VERIFY_TIMEOUT_MS; else process.env.WATCHDOG_RESTART_VERIFY_TIMEOUT_MS = prevTimeout;
    if (prevInterval === undefined) delete process.env.WATCHDOG_RESTART_VERIFY_INTERVAL_MS; else process.env.WATCHDOG_RESTART_VERIFY_INTERVAL_MS = prevInterval;
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});

test('a SECOND failure on the SAME still-open incident never restarts again — bounded to one attempt per incident', async () => {
  const dbUpdates = { restartCalls: [], recoveryUpdates: [] };
  const restores = baseStubs({ dbUpdates });
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    // incident already carries a recovery_action from a prior failure on this same open incident
    recordFailure: async () => ({ incident: { id: 42, failure_count: 2, recovery_action: 'restart', recovery_result: 'Restart triggered via Railway API. Health will be re-checked on the next watchdog cycle.' }, isNew: false, isCrashLoop: false }),
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', {
    evaluateRecovery: () => ({ action: 'restart', reason: 'Transient failure on previously-healthy service. One controlled restart permitted.' }),
    isEscalationError: () => false,
  }));
  try {
    const { handleFailure } = freshWatchdog();
    const service = { id: 'qb-proxy-server', railwayProjectId: 'proj-1', railwayServiceId: 'svc-1' };
    await handleFailure(service, { error: 'fetch failed', checkType: 'http' });
    assert.strictEqual(dbUpdates.restartCalls.length, 0, 'must NOT call restartService a second time for the same open incident');
  } finally {
    restores.forEach((r) => r());
  }
});

test('a circuit-breaker service (reminder-worker) never restarts, regardless of Railway IDs or capability', async () => {
  const dbUpdates = { restartCalls: [], recoveryUpdates: [] };
  const restores = baseStubs({ dbUpdates });
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async () => ({ incident: { id: 7, failure_count: 1, recovery_action: null, recovery_result: null }, isNew: true, isCrashLoop: false }),
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  // Use the REAL recoveryPolicy so the circuit breaker itself is exercised, not a stub.
  try {
    const { handleFailure } = freshWatchdog();
    const service = { id: 'reminder-worker', railwayProjectId: 'proj-1', railwayServiceId: 'svc-reminder' };
    await handleFailure(service, { error: 'heartbeat stale', checkType: 'heartbeat' });
    assert.strictEqual(dbUpdates.restartCalls.length, 0, 'circuit-breaker services must never be auto-restarted');
  } finally {
    restores.forEach((r) => r());
  }
});

test('a restart decision with no Railway IDs configured never calls the API and reports why', async () => {
  const dbUpdates = { restartCalls: [], recoveryUpdates: [] };
  const restores = baseStubs({ dbUpdates });
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async () => ({ incident: { id: 9, failure_count: 1, recovery_action: null, recovery_result: null }, isNew: true, isCrashLoop: false }),
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', {
    evaluateRecovery: () => ({ action: 'restart', reason: 'Transient failure on previously-healthy service. One controlled restart permitted.' }),
    isEscalationError: () => false,
  }));
  try {
    const { handleFailure } = freshWatchdog();
    const service = { id: 'some-other-service' }; // no railwayProjectId/railwayServiceId
    await handleFailure(service, { error: 'fetch failed', checkType: 'http' });
    assert.strictEqual(dbUpdates.restartCalls.length, 0);
    assert.match(dbUpdates.recoveryUpdates[0].outcome, /no Railway project\/service ID configured/);
  } finally {
    restores.forEach((r) => r());
  }
});

test('a restart decision when the token lacks capability never calls the API and reports why', async () => {
  const dbUpdates = { restartCalls: [], recoveryUpdates: [] };
  const restores = baseStubs({ dbUpdates, caps: { canRestart: false, reason: 'RAILWAY_API_TOKEN not set' } });
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async () => ({ incident: { id: 10, failure_count: 1, recovery_action: null, recovery_result: null }, isNew: true, isCrashLoop: false }),
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
    shouldAlert: () => true,
  }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', {
    evaluateRecovery: () => ({ action: 'restart', reason: 'Transient failure on previously-healthy service. One controlled restart permitted.' }),
    isEscalationError: () => false,
  }));
  try {
    const { handleFailure } = freshWatchdog();
    const service = { id: 'qb-proxy-server', railwayProjectId: 'proj-1', railwayServiceId: 'svc-1' };
    await handleFailure(service, { error: 'fetch failed', checkType: 'http' });
    assert.strictEqual(dbUpdates.restartCalls.length, 0);
    assert.match(dbUpdates.recoveryUpdates[0].outcome, /RAILWAY_API_TOKEN not set/);
  } finally {
    restores.forEach((r) => r());
  }
});

test('checkCalendarWorkerHeartbeat: healthy on a recent tick, unhealthy when stale or when the row is missing entirely', async () => {
  const dbPath = require.resolve('../db/client');
  const prev = require.cache[dbPath];
  let rowToReturn;
  delete require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { query: async () => ({ rows: rowToReturn ? [rowToReturn] : [] }) },
  };
  try {
    delete require.cache[require.resolve('../lib/monitoring/healthProbes')];
    const { checkCalendarWorkerHeartbeat } = require('../lib/monitoring/healthProbes');
    const service = { id: 'calendar-outbox-heartbeat', heartbeatTable: 'followup_reminder_runs', heartbeatField: 'last_run_at', staleThresholdMs: 10 * 60 * 1000 };

    rowToReturn = { last_run_at: new Date(Date.now() - 5000).toISOString() };
    const healthy = await checkCalendarWorkerHeartbeat(service);
    assert.strictEqual(healthy.healthy, true);

    rowToReturn = { last_run_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
    const stale = await checkCalendarWorkerHeartbeat(service);
    assert.strictEqual(stale.healthy, false);
    assert.match(stale.error, /Heartbeat stale/);

    rowToReturn = null;
    const missing = await checkCalendarWorkerHeartbeat(service);
    assert.strictEqual(missing.healthy, false);
    assert.match(missing.error, /row missing or never ticked/);
  } finally {
    if (prev) require.cache[dbPath] = prev; else delete require.cache[dbPath];
    delete require.cache[require.resolve('../lib/monitoring/healthProbes')];
  }
});

test('alertDispatcher includes a direct, clickable Railway link when the service has Railway IDs, and a clear N/A otherwise', async () => {
  const restores = [];
  restores.push(stub('../lib/monitoring/serviceInventory', {
    getService: (id) => (id === 'has-ids'
      ? { id, name: 'Has IDs', environment: 'production', railwayProjectId: 'proj-1', railwayServiceId: 'svc-1', railwayEnvironmentId: 'env-1' }
      : { id, name: 'No IDs', environment: 'production' }),
  }));
  restores.push(stub('../lib/monitoring/knownGoodBaseline', { getBaseline: async () => null }));
  try {
    delete require.cache[require.resolve('../lib/monitoring/alertDispatcher')];
    const { dispatchMonitoringAlert: fresh } = require('../lib/monitoring/alertDispatcher');
    const withIds = await fresh({ serviceId: 'has-ids', level: 'warning', errorSummary: 'x', errorType: 'http' });
    assert.strictEqual(withIds.RAILWAY_LINK, 'https://railway.com/project/proj-1/service/svc-1?environmentId=env-1');
    const withoutIds = await fresh({ serviceId: 'no-ids', level: 'warning', errorSummary: 'x', errorType: 'http' });
    assert.match(withoutIds.RAILWAY_LINK, /N\/A/);
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../lib/monitoring/alertDispatcher')];
  }
});
