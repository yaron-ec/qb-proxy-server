/* eslint-disable no-undef */
'use strict';

/**
 * qbCustomerCache.int.test.js — REAL-Postgres proof of
 * lib/qbCustomerCache.js's TTL/write-back behavior and the fact it never
 * invents a call to QuickBooks once a fresh row exists. Skipped without
 * TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, cache;
if (DB_URL) {
  db = require('../../db/client');
  cache = require('../../lib/qbCustomerCache');
}

test.beforeEach(async () => {
  if (!DB_URL) return;
  await db.query(`DELETE FROM qb_customer_metadata_cache`);
  cache._resetDeps();
  delete process.env.QB_CUSTOMER_CACHE_TTL_MS;
});

test('a real cache miss calls fetchFn once and persists the result', { skip }, async () => {
  let fetchCount = 0;
  const result = await cache.getOrFetchCustomer('cust-1', async () => {
    fetchCount++;
    return { DisplayName: 'Alice', PrimaryEmailAddr: { Address: 'alice@example.com' }, PrimaryPhone: { FreeFormNumber: '555-1234' } };
  });
  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(result.DisplayName, 'Alice');

  const row = await db.query(`SELECT display_name, email, phone FROM qb_customer_metadata_cache WHERE qb_customer_id = $1`, ['cust-1']);
  assert.strictEqual(row.rows[0].display_name, 'Alice');
  assert.strictEqual(row.rows[0].email, 'alice@example.com');
  assert.strictEqual(row.rows[0].phone, '555-1234');
});

test('a second call within the TTL never calls fetchFn again — this is the actual fix for the quota-exhaustion finding', { skip }, async () => {
  let fetchCount = 0;
  const fetchFn = async () => { fetchCount++; return { DisplayName: 'Bob' }; };
  await cache.getOrFetchCustomer('cust-2', fetchFn);
  const second = await cache.getOrFetchCustomer('cust-2', fetchFn);
  assert.strictEqual(fetchCount, 1, 'the second call must be served entirely from the cache, zero additional QuickBooks calls');
  assert.strictEqual(second.DisplayName, 'Bob');
});

test('a call after the TTL has elapsed calls fetchFn again and refreshes the row', { skip }, async () => {
  process.env.QB_CUSTOMER_CACHE_TTL_MS = '50'; // 50ms TTL for a fast, deterministic test
  let fetchCount = 0;
  const fetchFn = async () => { fetchCount++; return { DisplayName: `Call${fetchCount}` }; };
  await cache.getOrFetchCustomer('cust-3', fetchFn);
  await new Promise((r) => setTimeout(r, 120));
  const second = await cache.getOrFetchCustomer('cust-3', fetchFn);
  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(second.DisplayName, 'Call2');
});

test('genuinely concurrent lookups for the SAME uncached customer each still return the real data (no corruption under a race)', { skip }, async () => {
  let fetchCount = 0;
  const fetchFn = async () => { fetchCount++; await new Promise((r) => setTimeout(r, 10)); return { DisplayName: 'Concurrent' }; };
  const results = await Promise.all(Array.from({ length: 5 }, () => cache.getOrFetchCustomer('cust-4', fetchFn)));
  for (const r of results) assert.strictEqual(r.DisplayName, 'Concurrent');
  // Not asserting fetchCount === 1 here: a race where every caller misses
  // the cache simultaneously is expected and acceptable (each one still
  // gets the correct data, and ON CONFLICT DO UPDATE on the write-back
  // makes the final cached row correct regardless of write order) — the
  // real-world win (cross-TICK caching) is already proven by the test
  // above; this test only guards against data corruption under a race.
  const row = await db.query(`SELECT display_name FROM qb_customer_metadata_cache WHERE qb_customer_id = $1`, ['cust-4']);
  assert.strictEqual(row.rows[0].display_name, 'Concurrent');
});

test('getCacheStats reports real counts against the real table', { skip }, async () => {
  await cache.getOrFetchCustomer('a', async () => ({ DisplayName: 'A' }));
  await cache.getOrFetchCustomer('b', async () => ({ DisplayName: 'B' }));
  const stats = await cache.getCacheStats();
  assert.strictEqual(stats.available, true);
  assert.strictEqual(stats.total_cached, 2);
  assert.strictEqual(stats.fresh_within_24h, 2);
});
