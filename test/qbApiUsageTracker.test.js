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

// ── November 2026 "QB API consumption root-cause investigation" follow-up
// — per-entity/per-subsystem breakdown, projected end-of-month, and
// automatic non-essential-sync throttling. ──────────────────────────────

test('getUsageSnapshot: projects end-of-month linearly from calls-so-far / days-elapsed, labeled with its own basis', async () => {
  stubQuery(async () => ({
    rows: [{ call_count: '100000', first_call_at: null, last_call_at: null, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }],
  }));
  // Nov 2026 has 30 days; "now" is day 10 -> 100000/10*30 = 300000.
  const snap = await tracker.getUsageSnapshot(new Date('2026-11-10T12:00:00Z'));
  assert.strictEqual(snap.projection_basis_days, 10);
  assert.strictEqual(snap.days_in_month, 30);
  assert.strictEqual(snap.projected_end_of_month_calls, 300000);
  assert.strictEqual(snap.projected_pct_of_quota, 60);
  tracker._resetDeps();
});

test('classifyQbCallUrl: a /query?query=SELECT...FROM Invoice call classifies as entity=Invoice, subsystem=query', () => {
  const url = 'https://quickbooks.api.intuit.com/v3/company/R1/query?query=' + encodeURIComponent("SELECT * FROM Invoice WHERE CustomerRef = 'C1'");
  assert.deepStrictEqual(tracker.classifyQbCallUrl(url), { entity: 'Invoice', subsystem: 'query' });
});

test('classifyQbCallUrl: a /query?query=...FROM Payment call classifies as entity=Payment, subsystem=query', () => {
  const url = 'https://quickbooks.api.intuit.com/v3/company/R1/query?query=' + encodeURIComponent('SELECT * FROM Payment WHERE Id = 1');
  assert.deepStrictEqual(tracker.classifyQbCallUrl(url), { entity: 'Payment', subsystem: 'query' });
});

test('classifyQbCallUrl: a /cdc?entities=Invoice,Payment call classifies as entity="Invoice+Payment", subsystem=cdc', () => {
  const url = 'https://quickbooks.api.intuit.com/v3/company/R1/cdc?entities=Invoice%2CPayment&changedSince=2026-11-27T00%3A00%3A00.000Z';
  assert.deepStrictEqual(tracker.classifyQbCallUrl(url), { entity: 'Invoice+Payment', subsystem: 'cdc' });
});

test('classifyQbCallUrl: a direct /customer/<id> GET classifies as entity=Customer, subsystem=direct_get', () => {
  const url = 'https://quickbooks.api.intuit.com/v3/company/R1/customer/42?minorversion=65';
  assert.deepStrictEqual(tracker.classifyQbCallUrl(url), { entity: 'Customer', subsystem: 'direct_get' });
});

test('classifyQbCallUrl: an unrecognized shape never throws and reports unknown/unknown rather than being silently dropped', () => {
  assert.deepStrictEqual(tracker.classifyQbCallUrl('not a url at all'), { entity: 'unknown', subsystem: 'unknown' });
  assert.deepStrictEqual(tracker.classifyQbCallUrl('https://quickbooks.api.intuit.com/v3/company/R1/companyinfo/R1'), { entity: 'CompanyInfo', subsystem: 'direct_get' });
});

test('recordApiCall: with a url, also writes the per-entity daily breakdown row via an atomic INSERT ... ON CONFLICT increment', async () => {
  const calls = [];
  stubQuery(async (sql, params) => {
    calls.push({ sql, params });
    if (/INSERT INTO qb_api_usage_monthly/.test(sql)) return { rows: [{ call_count: 1, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
    return { rows: [] };
  });
  const url = 'https://quickbooks.api.intuit.com/v3/company/R1/cdc?entities=Invoice%2CPayment&changedSince=2026-01-01T00%3A00%3A00.000Z';
  await tracker.recordApiCall(new Date('2026-11-25T12:00:00Z'), url);
  const entityWrite = calls.find((c) => /INSERT INTO qb_api_usage_by_entity_daily/.test(c.sql));
  assert.ok(entityWrite, 'the entity-breakdown row must be written when a url is supplied');
  assert.match(entityWrite.sql, /ON CONFLICT \(call_date, entity, subsystem\) DO UPDATE/);
  assert.deepStrictEqual(entityWrite.params, ['2026-11-25', 'Invoice+Payment', 'cdc']);
  tracker._resetDeps();
});

test('recordApiCall: with no url, never attempts the entity-breakdown write — the original monthly-only behavior is unchanged', async () => {
  const calls = [];
  stubQuery(async (sql, params) => {
    calls.push(sql);
    return { rows: [{ call_count: 1, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
  });
  await tracker.recordApiCall(new Date('2026-11-25T12:00:00Z'));
  assert.ok(!calls.some((sql) => /qb_api_usage_by_entity_daily/.test(sql)));
  tracker._resetDeps();
});

test('recordApiCall: an entity-breakdown write failure is caught and never propagates (fail-open, matches the monthly-counter path)', async () => {
  stubQuery(async (sql) => {
    if (/INSERT INTO qb_api_usage_monthly/.test(sql)) return { rows: [{ call_count: 1, threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] };
    throw new Error('entity table unreachable');
  });
  await assert.doesNotReject(() => tracker.recordApiCall(new Date(), 'https://quickbooks.api.intuit.com/v3/company/R1/customer/1'));
  tracker._resetDeps();
});

test('getUsageBreakdown: reports this-month and today-only breakdowns, sorted by call_count descending', async () => {
  stubQuery(async (sql, params) => {
    if (/FROM qb_api_usage_by_entity_daily WHERE call_date >= /.test(sql)) {
      return { rows: [{ entity: 'Invoice', subsystem: 'cdc', call_count: '50' }, { entity: 'Customer', subsystem: 'direct_get', call_count: '10' }] };
    }
    if (/FROM qb_api_usage_by_entity_daily\s+WHERE call_date = /.test(sql)) {
      return { rows: [{ entity: 'Invoice', subsystem: 'cdc', call_count: '5' }] };
    }
    return { rows: [] };
  });
  const result = await tracker.getUsageBreakdown(new Date('2026-11-25T00:00:00Z'));
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.month_key, '2026-11');
  assert.deepStrictEqual(result.this_month_by_entity, [{ entity: 'Invoice', subsystem: 'cdc', call_count: 50 }, { entity: 'Customer', subsystem: 'direct_get', call_count: 10 }]);
  assert.deepStrictEqual(result.today_by_entity, [{ entity: 'Invoice', subsystem: 'cdc', call_count: 5 }]);
  assert.strictEqual(result.total_this_month_classified, 60);
  tracker._resetDeps();
});

test('getUsageBreakdown: reports available:false on a query failure, never a fabricated empty breakdown', async () => {
  stubQuery(async () => { throw new Error('db down'); });
  const result = await tracker.getUsageBreakdown();
  assert.strictEqual(result.available, false);
  tracker._resetDeps();
});

test('isNonEssentialSyncAllowed: true (allowed) below the 90% non-essential threshold', async () => {
  stubQuery(async () => ({ rows: [{ call_count: '400000', threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] }));
  assert.strictEqual(await tracker.isNonEssentialSyncAllowed(new Date('2026-11-25T00:00:00Z')), true);
  tracker._resetDeps();
});

test('isNonEssentialSyncAllowed: false (throttled) at/above the 90% non-essential threshold', async () => {
  stubQuery(async () => ({ rows: [{ call_count: '460000', threshold_70_alerted_at: null, threshold_85_alerted_at: null, threshold_95_alerted_at: null }] }));
  assert.strictEqual(await tracker.isNonEssentialSyncAllowed(new Date('2026-11-25T00:00:00Z')), false);
  tracker._resetDeps();
});

test('isNonEssentialSyncAllowed: fails OPEN (allowed=true) on a tracking query failure — a monitoring bug must never block a real sync', async () => {
  stubQuery(async () => { throw new Error('db down'); });
  assert.strictEqual(await tracker.isNonEssentialSyncAllowed(), true);
  tracker._resetDeps();
});
