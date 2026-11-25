/* eslint-disable no-undef */
'use strict';

/**
 * qbApiUsageTracker.test.js — November 2026 "QuickBooks API quota
 * management" CRM reliability request. Pure, DB-stubbed unit coverage:
 * month-key computation, recordApiCall's fail-open behavior, threshold
 * crossing/dedup logic, and getUsageSnapshot's "never fabricate a zero on
 * failure" guarantee. Real-Postgres atomic-increment/claim coverage lives
 * in test/integration/qbApiUsageTracker.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const tracker = require('../lib/qbApiUsageTracker');

function stubQuery(impl) {
  tracker._setDeps({ query: impl });
}

test('currentMonthKey formats as YYYY-MM, UTC', () => {
  assert.strictEqual(tracker.currentMonthKey(new Date('2026-11-25T12:00:00Z')), '2026-11');
  assert.strictEqual(tracker.currentMonthKey(new Date('2026-01-01T00:00:00Z')), '2026-01');
});

test('recordApiCall: never throws when the DB query fails (fail-open)', async () => {
  stubQuery(async () => { throw new Error('connection refused'); });
  await assert.doesNotReject(() => tracker.recordApiCall());
  tracker._resetDeps();
});

test('recordApiCall: issues an atomic INSERT ... ON CONFLICT DO UPDATE incrementing call_count', async () => {
  const calls = [];
  stubQuery(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ call_count: 5, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
  });
  await tracker.recordApiCall(new Date('2026-11-25T12:00:00Z'));
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO qb_api_usage_monthly/);
  assert.match(calls[0].sql, /ON CONFLICT \(month_key\) DO UPDATE/);
  assert.match(calls[0].sql, /call_count = qb_api_usage_monthly\.call_count \+ 1/);
  assert.strictEqual(calls[0].params[0], '2026-11');
  tracker._resetDeps();
});

test('recordApiCall: below every threshold never attempts to claim or alert', async () => {
  let claimAttempted = false;
  stubQuery(async (sql) => {
    if (/UPDATE qb_api_usage_monthly SET threshold/.test(sql)) claimAttempted = true;
    return { rows: [{ call_count: 1000, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
  });
  let alertSent = false;
  tracker._setDeps({ sendThresholdAlert: async () => { alertSent = true; } });
  await tracker.recordApiCall();
  assert.strictEqual(claimAttempted, false);
  assert.strictEqual(alertSent, false);
  tracker._resetDeps();
});

test('recordApiCall: crossing 70% claims the threshold and fires exactly one alert', async () => {
  let claimCalls = 0;
  const alerts = [];
  stubQuery(async (sql) => {
    if (/INSERT INTO qb_api_usage_monthly/.test(sql)) {
      return { rows: [{ call_count: 350000, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
    }
    if (/threshold_70_alerted_at = now\(\)/.test(sql)) {
      claimCalls++;
      return { rows: [{ threshold_70_alerted_at: new Date() }] };
    }
    return { rows: [] };
  });
  tracker._setDeps({ sendThresholdAlert: async (monthKey, count, pct, label) => { alerts.push({ monthKey, count, pct, label }); } });
  await tracker.recordApiCall(new Date('2026-11-25T00:00:00Z'));
  assert.strictEqual(claimCalls, 1);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].label, '70%');
  assert.strictEqual(alerts[0].count, 350000);
  tracker._resetDeps();
});

test('recordApiCall: already-alerted threshold is never re-claimed or re-sent', async () => {
  let alertSent = false;
  stubQuery(async (sql) => {
    if (/INSERT INTO qb_api_usage_monthly/.test(sql)) {
      return { rows: [{ call_count: 400000, threshold_70_alerted_at: new Date(), threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
    }
    // Below 85% (400000 < 425000), so no claim attempt for 85% either —
    // only 70% is already-alerted and correctly skipped.
    return { rows: [] };
  });
  tracker._setDeps({ sendThresholdAlert: async () => { alertSent = true; } });
  await tracker.recordApiCall();
  assert.strictEqual(alertSent, false);
  tracker._resetDeps();
});

test('recordApiCall: a lost claim race (another process already claimed it) never double-sends', async () => {
  let alertSent = false;
  stubQuery(async (sql) => {
    if (/INSERT INTO qb_api_usage_monthly/.test(sql)) {
      return { rows: [{ call_count: 350000, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
    }
    if (/threshold_70_alerted_at = now\(\)/.test(sql)) {
      return { rows: [] }; // lost the race — another process already set it
    }
    return { rows: [] };
  });
  tracker._setDeps({ sendThresholdAlert: async () => { alertSent = true; } });
  await tracker.recordApiCall();
  assert.strictEqual(alertSent, false);
  tracker._resetDeps();
});

test('recordApiCall: a threshold alert send failure is caught and never propagates', async () => {
  stubQuery(async (sql) => {
    if (/INSERT INTO qb_api_usage_monthly/.test(sql)) {
      return { rows: [{ call_count: 350000, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
    }
    return { rows: [{ threshold_70_alerted_at: new Date() }] };
  });
  tracker._setDeps({ sendThresholdAlert: async () => { throw new Error('smtp down'); } });
  await assert.doesNotReject(() => tracker.recordApiCall());
  tracker._resetDeps();
});

test('getUsageSnapshot: reports available:false on a query failure, never a fabricated zero', async () => {
  stubQuery(async () => { throw new Error('db unreachable'); });
  const snap = await tracker.getUsageSnapshot();
  assert.strictEqual(snap.available, false);
  assert.ok(snap.error);
  tracker._resetDeps();
});

test('getUsageSnapshot: reports real figures, clearly labeled as locally measured', async () => {
  stubQuery(async () => ({
    rows: [{
      call_count: '250000', first_call_at: '2026-11-01T00:00:00Z', last_call_at: '2026-11-25T00:00:00Z',
      threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null,
    }],
  }));
  const snap = await tracker.getUsageSnapshot(new Date('2026-11-25T00:00:00Z'));
  assert.strictEqual(snap.available, true);
  assert.strictEqual(snap.month_key, '2026-11');
  assert.strictEqual(snap.locally_measured_calls, 250000);
  assert.strictEqual(snap.monthly_quota, 500000);
  assert.strictEqual(snap.pct_used, 50);
  assert.match(snap.measurement_note, /[Ll]ocally measured/);
  assert.match(snap.measurement_note, /not confirmed against Intuit/);
  tracker._resetDeps();
});

test('getUsageSnapshot: no row yet this month reports zero, not unavailable', async () => {
  stubQuery(async () => ({ rows: [] }));
  const snap = await tracker.getUsageSnapshot();
  assert.strictEqual(snap.available, true);
  assert.strictEqual(snap.locally_measured_calls, 0);
  tracker._resetDeps();
});
