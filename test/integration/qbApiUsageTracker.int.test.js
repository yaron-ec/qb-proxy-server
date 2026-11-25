/* eslint-disable no-undef */
'use strict';

/**
 * qbApiUsageTracker.int.test.js — REAL-Postgres proof of
 * lib/qbApiUsageTracker.js's atomic increment and threshold-claim logic.
 * Correctness hinges entirely on concurrent `INSERT ... ON CONFLICT DO
 * UPDATE` / conditional `UPDATE ... WHERE col IS NULL` statements being
 * race-safe across simultaneous callers — exactly what a stubbed query
 * can't prove. Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, tracker;
if (DB_URL) {
  db = require('../../db/client');
  tracker = require('../../lib/qbApiUsageTracker');
}

test.beforeEach(async () => {
  if (!DB_URL) return;
  await db.query(`DELETE FROM qb_api_usage_monthly`);
  tracker._resetDeps();
});

test('recordApiCall: a fresh month starts at 1 on the first call', { skip }, async () => {
  await tracker.recordApiCall(new Date('2026-11-25T00:00:00Z'));
  const snap = await tracker.getUsageSnapshot(new Date('2026-11-25T00:00:00Z'));
  assert.strictEqual(snap.locally_measured_calls, 1);
});

test('recordApiCall: genuinely concurrent calls in the same month never lose an increment', { skip }, async () => {
  const now = new Date('2026-11-25T00:00:00Z');
  await Promise.all(Array.from({ length: 25 }, () => tracker.recordApiCall(now)));
  const snap = await tracker.getUsageSnapshot(now);
  assert.strictEqual(snap.locally_measured_calls, 25);
});

test('recordApiCall: different calendar months accumulate into separate rows', { skip }, async () => {
  await tracker.recordApiCall(new Date('2026-11-25T00:00:00Z'));
  await tracker.recordApiCall(new Date('2026-11-26T00:00:00Z'));
  await tracker.recordApiCall(new Date('2026-12-01T00:00:00Z'));
  const nov = await tracker.getUsageSnapshot(new Date('2026-11-25T00:00:00Z'));
  const dec = await tracker.getUsageSnapshot(new Date('2026-12-01T00:00:00Z'));
  assert.strictEqual(nov.locally_measured_calls, 2);
  assert.strictEqual(dec.locally_measured_calls, 1);
});

test('threshold alert: fires exactly once even under genuinely concurrent crossing calls', { skip }, async () => {
  const now = new Date('2026-11-25T00:00:00Z');
  // Seed the counter just under 70% so the next concurrent batch crosses it.
  await db.query(
    `INSERT INTO qb_api_usage_monthly (month_key, call_count, first_call_at, last_call_at) VALUES ($1, $2, now(), now())`,
    [tracker.currentMonthKey(now), Math.floor(tracker.MONTHLY_QUOTA * 0.70) - 5]
  );
  let alertCount = 0;
  tracker._setDeps({ sendThresholdAlert: async () => { alertCount++; } });
  await Promise.all(Array.from({ length: 10 }, () => tracker.recordApiCall(now)));
  assert.strictEqual(alertCount, 1, 'exactly one threshold alert must fire, even though several concurrent callers crossed 70% in the same instant');
  tracker._resetDeps();
});

test('threshold alert: 70%, 85%, and 95% each fire independently, once, as the count climbs', { skip }, async () => {
  const now = new Date('2026-11-25T00:00:00Z');
  const fired = [];
  tracker._setDeps({ sendThresholdAlert: async (monthKey, count, pct, label) => { fired.push(label); } });

  await db.query(
    `INSERT INTO qb_api_usage_monthly (month_key, call_count, first_call_at, last_call_at) VALUES ($1, $2, now(), now())`,
    [tracker.currentMonthKey(now), Math.floor(tracker.MONTHLY_QUOTA * 0.70) - 1]
  );
  await tracker.recordApiCall(now); // crosses 70%
  assert.deepStrictEqual(fired, ['70%']);

  await db.query(
    `UPDATE qb_api_usage_monthly SET call_count = $2 WHERE month_key = $1`,
    [tracker.currentMonthKey(now), Math.floor(tracker.MONTHLY_QUOTA * 0.85) - 1]
  );
  await tracker.recordApiCall(now); // crosses 85%
  assert.deepStrictEqual(fired, ['70%', '85%']);

  await db.query(
    `UPDATE qb_api_usage_monthly SET call_count = $2 WHERE month_key = $1`,
    [tracker.currentMonthKey(now), Math.floor(tracker.MONTHLY_QUOTA * 0.95) - 1]
  );
  await tracker.recordApiCall(now); // crosses 95%
  assert.deepStrictEqual(fired, ['70%', '85%', '95%']);

  tracker._resetDeps();
});
