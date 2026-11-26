/* eslint-disable no-undef */
'use strict';

/**
 * crashLoopDetectorAlertCooldown.test.js — the November 2026 "repeated
 * hourly QuickBooks quota-exhaustion emails" notification-storm fix.
 *
 * Pure unit coverage for lib/monitoring/crashLoopDetector.js#shouldAlert,
 * the ONE shared decision function productionWatchdog.js#handleFailure and
 * routes/cronJobs.js's /diagnose-watchdog route both now delegate to
 * (replacing two independently-drifted copies of the old count-based
 * "every 5th failure" rule). shouldAlert() itself touches no database — it
 * operates purely on the already-fetched incident row — so this file needs
 * no DB stubbing, mirroring test/qbRateLimitBreaker.test.js's own "pure
 * logic, real-Postgres state-machine proof lives in the integration suite
 * instead" convention.
 */
const test = require('node:test');
const assert = require('node:assert');
const crashLoop = require('../lib/monitoring/crashLoopDetector');

function incident(overrides = {}) {
  return {
    id: 1,
    failure_count: 1,
    alert_count: 0,
    alert_sent_at: null,
    last_alerted_error_type: null,
    ...overrides,
  };
}

test('shouldAlert: no incident never alerts', () => {
  assert.strictEqual(crashLoop.shouldAlert(null, { isNew: true }), false);
});

test('shouldAlert: a brand-new incident always alerts, regardless of cooldown state', () => {
  const inc = incident({ alert_sent_at: new Date().toISOString(), last_alerted_error_type: 'quota_exhausted' });
  assert.strictEqual(crashLoop.shouldAlert(inc, { isNew: true, newErrorType: 'quota_exhausted' }), true);
});

test('shouldAlert: a crash-loop transition always alerts, regardless of cooldown state', () => {
  const inc = incident({ alert_sent_at: new Date().toISOString(), last_alerted_error_type: 'quota_exhausted' });
  assert.strictEqual(crashLoop.shouldAlert(inc, { isCrashLoop: true, newErrorType: 'quota_exhausted' }), true);
});

test('shouldAlert: THE REPORTED BUG — a persistent, unchanged incident does NOT re-alert on every subsequent tick (only the cooldown gates it)', () => {
  const inc = incident({ alert_sent_at: new Date().toISOString(), last_alerted_error_type: 'quota_exhausted', failure_count: 5 });
  // failure_count === 5 is exactly the shape that used to force a re-alert
  // under the old `incident.failure_count % 5 === 0` rule — it must NOT
  // alert here now, since the alert was sent moments ago and the failure
  // category is unchanged.
  assert.strictEqual(crashLoop.shouldAlert(inc, { isNew: false, isCrashLoop: false, newErrorType: 'quota_exhausted' }), false);
});

test('shouldAlert: a persistent, unchanged incident DOES re-alert once the 24h cooldown has fully elapsed', () => {
  const justOver = new Date(Date.now() - (crashLoop.ALERT_COOLDOWN_MS + 1000)).toISOString();
  const inc = incident({ alert_sent_at: justOver, last_alerted_error_type: 'quota_exhausted' });
  assert.strictEqual(crashLoop.shouldAlert(inc, { isNew: false, isCrashLoop: false, newErrorType: 'quota_exhausted' }), true);
});

test('shouldAlert: a persistent, unchanged incident does NOT re-alert at 23h59m — the boundary is strict', () => {
  const justUnder = new Date(Date.now() - (crashLoop.ALERT_COOLDOWN_MS - 60 * 1000)).toISOString();
  const inc = incident({ alert_sent_at: justUnder, last_alerted_error_type: 'quota_exhausted' });
  assert.strictEqual(crashLoop.shouldAlert(inc, { isNew: false, isCrashLoop: false, newErrorType: 'quota_exhausted' }), false);
});

test('shouldAlert: a genuinely DIFFERENT failure category alerts immediately, even seconds after the last alert', () => {
  const inc = incident({ alert_sent_at: new Date().toISOString(), last_alerted_error_type: 'quota_exhausted' });
  assert.strictEqual(crashLoop.shouldAlert(inc, { isNew: false, isCrashLoop: false, newErrorType: 'reconnect_required' }), true);
});

test('shouldAlert: a changing/unstable value embedded in a stable category key never looks "different" tick to tick — simulated by passing the SAME category repeatedly while a hypothetical reopen counter climbs elsewhere', () => {
  // The category itself ('quota_exhausted') stays fixed even though, in
  // production, breakerState.opens_count climbs on every reopen — this
  // test exists specifically to pin that `newErrorType` must be a STABLE
  // slug, never a value that embeds the counter, or this guard is defeated.
  const inc = incident({ alert_sent_at: new Date().toISOString(), last_alerted_error_type: 'quota_exhausted' });
  for (let opensCount = 1; opensCount <= 50; opensCount++) {
    assert.strictEqual(
      crashLoop.shouldAlert(inc, { isNew: false, isCrashLoop: false, newErrorType: 'quota_exhausted' }),
      false,
      `opensCount=${opensCount} must not defeat the cooldown`
    );
  }
});

test('shouldAlert: never alerted yet (alert_sent_at null) but not new/crash-loop — defensive true (should not normally occur, since isNew covers the first alert)', () => {
  const inc = incident({ alert_sent_at: null, last_alerted_error_type: null });
  assert.strictEqual(crashLoop.shouldAlert(inc, { isNew: false, isCrashLoop: false, newErrorType: 'quota_exhausted' }), true);
});

test('shouldAlert: no newErrorType provided (a caller that omits it) falls through to the time-based cooldown, never force-alerts', () => {
  const inc = incident({ alert_sent_at: new Date().toISOString(), last_alerted_error_type: 'quota_exhausted' });
  assert.strictEqual(crashLoop.shouldAlert(inc, { isNew: false, isCrashLoop: false }), false);
});

test('markAlertSent: issues the expected SQL/params, including COALESCE so a null errorType never erases a previously-recorded category', async () => {
  const calls = [];
  const dbPath = require.resolve('../db/client');
  const prev = require.cache[dbPath];
  delete require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } },
  };
  try {
    delete require.cache[require.resolve('../lib/monitoring/crashLoopDetector')];
    const fresh = require('../lib/monitoring/crashLoopDetector');
    await fresh.markAlertSent(42, 'quota_exhausted');
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].sql, /alert_sent_at = NOW\(\)/);
    assert.match(calls[0].sql, /alert_count = alert_count \+ 1/);
    assert.match(calls[0].sql, /COALESCE\(\$2, last_alerted_error_type\)/);
    assert.deepStrictEqual(calls[0].params, [42, 'quota_exhausted']);

    calls.length = 0;
    await fresh.markAlertSent(42); // omitted errorType — must pass null, never erase via COALESCE
    assert.deepStrictEqual(calls[0].params, [42, null]);
  } finally {
    if (prev) require.cache[dbPath] = prev; else delete require.cache[dbPath];
    delete require.cache[require.resolve('../lib/monitoring/crashLoopDetector')];
  }
});
