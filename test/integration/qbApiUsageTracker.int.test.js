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
  await db.query(`DELETE FROM qb_api_usage_by_entity_daily`);
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

// ── November 2026 "QB API consumption root-cause investigation" follow-up
// — the per-entity/per-subsystem daily breakdown table, proven against a
// real atomic INSERT ... ON CONFLICT DO UPDATE increment. ─────────────────

test('recordApiCall: with a url, increments the real qb_api_usage_by_entity_daily row atomically under concurrency', { skip }, async () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const url = 'https://quickbooks.api.intuit.com/v3/company/R1/cdc?entities=Invoice%2CPayment&changedSince=2026-01-01T00%3A00%3A00.000Z';
  await Promise.all(Array.from({ length: 20 }, () => tracker.recordApiCall(now, url)));
  const { rows } = await db.query(`SELECT call_count FROM qb_api_usage_by_entity_daily WHERE call_date = $1 AND entity = $2 AND subsystem = $3`, ['2026-11-25', 'Invoice+Payment', 'cdc']);
  assert.strictEqual(Number(rows[0].call_count), 20, 'no increment lost under genuine concurrency');
});

test('recordApiCall: different entities/subsystems on the same day accumulate into separate rows', { skip }, async () => {
  const now = new Date('2026-11-25T12:00:00Z');
  await tracker.recordApiCall(now, 'https://quickbooks.api.intuit.com/v3/company/R1/cdc?entities=Invoice%2CPayment&changedSince=x');
  await tracker.recordApiCall(now, 'https://quickbooks.api.intuit.com/v3/company/R1/customer/42?minorversion=65');
  await tracker.recordApiCall(now, 'https://quickbooks.api.intuit.com/v3/company/R1/customer/42?minorversion=65');
  const breakdown = await tracker.getUsageBreakdown(now);
  assert.strictEqual(breakdown.available, true);
  const byEntity = Object.fromEntries(breakdown.this_month_by_entity.map((r) => [`${r.entity}:${r.subsystem}`, r.call_count]));
  assert.strictEqual(byEntity['Invoice+Payment:cdc'], 1);
  assert.strictEqual(byEntity['Customer:direct_get'], 2);
  assert.strictEqual(breakdown.total_this_month_classified, 3);
});

test('getUsageBreakdown: today_by_entity only reflects the current calendar day, not the whole month', { skip }, async () => {
  await db.query(
    `INSERT INTO qb_api_usage_by_entity_daily (call_date, entity, subsystem, call_count) VALUES ('2026-11-01', 'Invoice', 'query', 500)`
  );
  await tracker.recordApiCall(new Date('2026-11-25T12:00:00Z'), 'https://quickbooks.api.intuit.com/v3/company/R1/customer/1?minorversion=65');
  const breakdown = await tracker.getUsageBreakdown(new Date('2026-11-25T12:00:00Z'));
  assert.strictEqual(breakdown.total_this_month_classified, 501, 'this-month total includes both days');
  assert.strictEqual(breakdown.today_by_entity.length, 1, 'today only includes the one call actually made today');
  assert.strictEqual(breakdown.today_by_entity[0].entity, 'Customer');
});
