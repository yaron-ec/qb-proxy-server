/* eslint-disable no-undef */
'use strict';

/**
 * productionWatchdogSummary.test.js — CRM reliability fix pass.
 *
 * productionWatchdog.js's own scan log previously reported ONLY aggregate
 * counts (e.g. `"unhealthy":4`), with no way to tell WHICH of the 11
 * monitored services those were without a separate Postgres query against
 * monitoring_health_checks. Fixed: the scan summary now includes
 * `unhealthyServices` — each unhealthy service's id, check type, and error
 * reason — directly in the one log line.
 *
 * Stubs every dependency (db, probeService, crashLoopDetector,
 * knownGoodBaseline, alertDispatcher, recoveryPolicy, railwayApiClient) so
 * this exercises only runWatchdog()'s own summary-building logic, not the
 * real health/alert/recovery pipeline (each of which has its own dedicated
 * test coverage elsewhere).
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

test('runWatchdog(): the scan summary names every unhealthy service with its reason, not just a bare count', async () => {
  const restores = [];
  restores.push(stub('../lib/monitoring/healthProbes', {
    probeService: async (service) => {
      if (service.id === 'handoff-integration') return { serviceId: service.id, healthy: false, checkType: 'handoff_integration', error: 'Handoff not connected (no stored credential)' };
      if (service.id === 'qb-proxy-server') return { serviceId: service.id, healthy: false, checkType: 'http', error: 'fetch failed' };
      return { serviceId: service.id, healthy: true, checkType: 'ok', error: null };
    },
  }));
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async (serviceId) => ({ incident: { id: 'inc-1', failure_count: 1 }, isNew: true, isCrashLoop: false }),
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
  }));
  restores.push(stub('../lib/monitoring/knownGoodBaseline', { verifyAndPromote: async () => {}, getBaseline: async () => null }));
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async () => ({}) }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', { evaluateRecovery: () => ({ action: 'none', reason: 'n/a' }), isEscalationError: () => false }));
  restores.push(stub('../lib/monitoring/railwayApiClient', { checkCapabilities: async () => ({ canRestart: false, reason: 'read-only token' }) }));

  delete require.cache[require.resolve('../productionWatchdog')];
  const { runWatchdog } = require('../productionWatchdog');
  try {
    const summary = await runWatchdog();
    assert.strictEqual(summary.total, 11);
    assert.strictEqual(summary.unhealthy, 2);
    assert.ok(Array.isArray(summary.unhealthyServices), 'unhealthyServices must be present and an array — this is exactly the missing breakdown');
    assert.strictEqual(summary.unhealthyServices.length, 2);
    const byId = Object.fromEntries(summary.unhealthyServices.map((s) => [s.serviceId, s]));
    assert.ok(byId['handoff-integration']);
    assert.match(byId['handoff-integration'].error, /Handoff not connected/);
    assert.ok(byId['qb-proxy-server']);
    assert.match(byId['qb-proxy-server'].error, /fetch failed/);
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});
