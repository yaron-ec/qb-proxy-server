/* eslint-disable no-undef */
'use strict';

/**
 * productionWatchdogAlertLevel.test.js — CRM follow-up reliability fix
 * (watchdog alert-level correction, after PR #62).
 *
 * Two confirmed issues with productionWatchdog.js#handleFailure's alert
 * level, fixed together in this pass:
 *
 *  1. website-intake (silence) must NEVER reach this function at all — an
 *     absence of website leads is a marketing/activity metric, not a
 *     system failure (see lib/monitoring/healthProbes.js#checkWebsiteIntakeSilence
 *     and test/monitoringHealthProbes.test.js, which cover the check
 *     itself always reporting healthy:true). This file proves the
 *     watchdog-level consequence: with the real serviceInventory.js entry
 *     and probeService wired in, a stale-silence result never opens an
 *     incident or dispatches an alert.
 *
 *  2. website-intake-rejections (a genuine, sustained burst of REJECTED
 *     deliveries — proof the website IS attempting delivery and being
 *     refused) must ALWAYS alert at 'critical', never left stuck at
 *     'warning' by the crash-loop heuristic (3 failures within a 10-minute
 *     window), which this watchdog's own ~15-minute probe cadence can make
 *     nearly impossible to satisfy even for a real, ongoing failure.
 *     serviceInventory.js's `alwaysCritical: true` on that one entry, and
 *     productionWatchdog.js#handleFailure's `(service.alwaysCritical ||
 *     isCrashLoop) ? 'critical' : 'warning'`, are what this test proves.
 *
 * Every OTHER service's alert-level behavior (isCrashLoop ? 'critical' :
 * 'warning', unchanged) is proven unaffected by a regression guard at the
 * bottom of this file.
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

test('website-intake-rejections: a genuine, sustained rejection burst ALWAYS dispatches a critical alert, even on the very first failure (isCrashLoop:false)', async () => {
  const dispatchCalls = [];
  const restores = [];
  restores.push(stub('../lib/monitoring/healthProbes', {
    probeService: async (service) => {
      if (service.id === 'website-intake-rejections') {
        return { serviceId: service.id, healthy: false, checkType: 'website_intake_rejections', error: '5 website lead deliveries rejected in the last 60m — WEBSITE_LEAD_WEBHOOK_SECRET is likely out of sync.' };
      }
      return { serviceId: service.id, healthy: true, checkType: 'ok', error: null };
    },
  }));
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    // First-ever failure: isCrashLoop is false, failure_count is 1 — the
    // exact shape that would otherwise produce 'warning'.
    recordFailure: async (serviceId) => ({ incident: { id: 'inc-1', failure_count: 1 }, isNew: true, isCrashLoop: false }),
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
  }));
  restores.push(stub('../lib/monitoring/knownGoodBaseline', { verifyAndPromote: async () => {}, getBaseline: async () => null }));
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async (opts) => { dispatchCalls.push(opts); return {}; } }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', { evaluateRecovery: () => ({ action: 'none', reason: 'n/a' }), isEscalationError: () => false }));
  restores.push(stub('../lib/monitoring/railwayApiClient', { checkCapabilities: async () => ({ canRestart: false, reason: 'read-only token' }) }));

  try {
    const { runWatchdog } = freshWatchdog();
    await runWatchdog();
    const call = dispatchCalls.find((c) => c.serviceId === 'website-intake-rejections');
    assert.ok(call, 'an alert must be dispatched for a genuine rejection-burst failure');
    assert.strictEqual(call.level, 'critical', 'a genuine website-to-CRM delivery failure must always reach critical, independent of the crash-loop coincidence');
    assert.strictEqual(call.isCrashLoop, false, 'proves the critical level came from alwaysCritical, not from a crash loop');
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});

test('website-intake (silence): a stale-silence result from the real serviceInventory entry never opens an incident or dispatches an alert', async () => {
  const recordFailureCalls = [];
  const dispatchCalls = [];
  const restores = [];
  restores.push(stub('../lib/monitoring/healthProbes', {
    // Mirrors what checkWebsiteIntakeSilence now actually returns for a
    // stale-silence condition: healthy:true, silenceDetected:true in
    // details, error:null — see lib/monitoring/healthProbes.js.
    probeService: async (service) => {
      if (service.id === 'website-intake') {
        return { serviceId: service.id, healthy: true, checkType: 'website_intake_silence', details: { silenceDetected: true, ageMs: 999999999 }, error: null };
      }
      return { serviceId: service.id, healthy: true, checkType: 'ok', error: null };
    },
  }));
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async (serviceId) => { recordFailureCalls.push(serviceId); return { incident: { id: 'inc-1', failure_count: 1 }, isNew: true, isCrashLoop: false }; },
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
  }));
  restores.push(stub('../lib/monitoring/knownGoodBaseline', { verifyAndPromote: async () => {}, getBaseline: async () => null }));
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async (opts) => { dispatchCalls.push(opts); return {}; } }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', { evaluateRecovery: () => ({ action: 'none', reason: 'n/a' }), isEscalationError: () => false }));
  restores.push(stub('../lib/monitoring/railwayApiClient', { checkCapabilities: async () => ({ canRestart: false, reason: 'read-only token' }) }));

  try {
    const { runWatchdog } = freshWatchdog();
    const summary = await runWatchdog();
    assert.strictEqual(recordFailureCalls.includes('website-intake'), false, 'crashLoop.recordFailure must never be called for website-intake silence — it is healthy:true');
    assert.strictEqual(dispatchCalls.some((c) => c.serviceId === 'website-intake'), false, 'no alert must ever be dispatched for mere silence');
    assert.strictEqual(summary.unhealthy, 0, 'website-intake must never count toward the aggregate unhealthy total for mere silence');
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});

test('regression guard: every OTHER service (no alwaysCritical) keeps the original isCrashLoop-driven level — a non-crash-loop failure is still only "warning"', async () => {
  const dispatchCalls = [];
  const restores = [];
  restores.push(stub('../lib/monitoring/healthProbes', {
    probeService: async (service) => {
      if (service.id === 'handoff-integration') {
        return { serviceId: service.id, healthy: false, checkType: 'handoff_integration', error: 'Handoff not connected' };
      }
      return { serviceId: service.id, healthy: true, checkType: 'ok', error: null };
    },
  }));
  restores.push(stub('../lib/monitoring/crashLoopDetector', {
    recordFailure: async () => ({ incident: { id: 'inc-2', failure_count: 1 }, isNew: true, isCrashLoop: false }),
    recordSuccess: async () => ({ resolved: false, incident: null }),
    markAlertSent: async () => {},
  }));
  restores.push(stub('../lib/monitoring/knownGoodBaseline', { verifyAndPromote: async () => {}, getBaseline: async () => null }));
  restores.push(stub('../lib/monitoring/alertDispatcher', { dispatchMonitoringAlert: async (opts) => { dispatchCalls.push(opts); return {}; } }));
  restores.push(stub('../lib/monitoring/recoveryPolicy', { evaluateRecovery: () => ({ action: 'none', reason: 'n/a' }), isEscalationError: () => false }));
  restores.push(stub('../lib/monitoring/railwayApiClient', { checkCapabilities: async () => ({ canRestart: false, reason: 'read-only token' }) }));

  try {
    const { runWatchdog } = freshWatchdog();
    await runWatchdog();
    const call = dispatchCalls.find((c) => c.serviceId === 'handoff-integration');
    assert.ok(call);
    assert.strictEqual(call.level, 'warning', 'a service with no alwaysCritical flag and no crash loop must stay at warning — unaffected by this fix');
  } finally {
    restores.forEach((r) => r());
    delete require.cache[require.resolve('../productionWatchdog')];
  }
});

test('source-level guard: serviceInventory.js marks exactly website-intake-rejections as alwaysCritical, and website-intake is never marked alwaysCritical', () => {
  delete require.cache[require.resolve('../lib/monitoring/serviceInventory')];
  const { SERVICES } = require('../lib/monitoring/serviceInventory');
  const alwaysCriticalIds = SERVICES.filter((s) => s.alwaysCritical === true).map((s) => s.id);
  assert.deepStrictEqual(alwaysCriticalIds, ['website-intake-rejections']);
  const websiteIntake = SERVICES.find((s) => s.id === 'website-intake');
  assert.notStrictEqual(websiteIntake.alwaysCritical, true);
});
