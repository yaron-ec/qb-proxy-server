/* eslint-disable no-undef */
'use strict';

/**
 * qbCustomerCache.test.js — November 2026 "QuickBooks API quota
 * management" CRM reliability request. Pure, DB-stubbed unit coverage.
 * Real-Postgres TTL/write-back coverage lives in
 * test/integration/qbCustomerCache.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const cache = require('../lib/qbCustomerCache');

function stubQuery(impl) {
  cache._setDeps({ query: impl });
}

test('a fresh cache hit never calls fetchFn', async () => {
  stubQuery(async () => ({
    rows: [{ raw_customer: { DisplayName: 'Jane Doe' }, fetched_at: new Date().toISOString() }],
  }));
  let fetchCalled = false;
  const result = await cache.getOrFetchCustomer('123', async () => { fetchCalled = true; return { DisplayName: 'SHOULD NOT BE USED' }; });
  assert.strictEqual(fetchCalled, false);
  assert.strictEqual(result.DisplayName, 'Jane Doe');
  cache._resetDeps();
});

test('an expired cache row (older than the TTL) falls through to fetchFn and writes back', async () => {
  const writes = [];
  const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h old, default TTL is 24h
  stubQuery(async (sql, params) => {
    if (/SELECT raw_customer/.test(sql)) {
      return { rows: [{ raw_customer: { DisplayName: 'Old Name' }, fetched_at: staleDate }] };
    }
    if (/INSERT INTO qb_customer_metadata_cache/.test(sql)) {
      writes.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  });
  let fetchCalled = false;
  const result = await cache.getOrFetchCustomer('123', async () => {
    fetchCalled = true;
    return { DisplayName: 'Fresh Name', PrimaryEmailAddr: { Address: 'a@b.com' } };
  });
  assert.strictEqual(fetchCalled, true);
  assert.strictEqual(result.DisplayName, 'Fresh Name');
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0][1], 'Fresh Name');
  cache._resetDeps();
});

test('no cache row at all (first-ever lookup) falls through to fetchFn', async () => {
  stubQuery(async (sql) => {
    if (/SELECT raw_customer/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  let fetchCalled = false;
  const result = await cache.getOrFetchCustomer('999', async () => { fetchCalled = true; return { DisplayName: 'New Customer' }; });
  assert.strictEqual(fetchCalled, true);
  assert.strictEqual(result.DisplayName, 'New Customer');
  cache._resetDeps();
});

test('a cache read failure degrades to "always call fetchFn" — never hides a real customer behind a broken cache', async () => {
  stubQuery(async (sql) => {
    if (/SELECT raw_customer/.test(sql)) throw new Error('connection refused');
    return { rows: [] };
  });
  const result = await cache.getOrFetchCustomer('1', async () => ({ DisplayName: 'Real Customer' }));
  assert.strictEqual(result.DisplayName, 'Real Customer');
  cache._resetDeps();
});

test('a cache write failure never prevents returning the fresh result', async () => {
  stubQuery(async (sql) => {
    if (/SELECT raw_customer/.test(sql)) return { rows: [] };
    if (/INSERT INTO qb_customer_metadata_cache/.test(sql)) throw new Error('disk full');
    return { rows: [] };
  });
  const result = await cache.getOrFetchCustomer('1', async () => ({ DisplayName: 'Still Returned' }));
  assert.strictEqual(result.DisplayName, 'Still Returned');
  cache._resetDeps();
});

test('a genuine not-found (fetchFn returns null) is never cached and is returned as-is', async () => {
  stubQuery(async (sql) => {
    if (/SELECT raw_customer/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  let writeAttempted = false;
  cache._setDeps({
    query: async (sql) => {
      if (/SELECT raw_customer/.test(sql)) return { rows: [] };
      if (/INSERT INTO qb_customer_metadata_cache/.test(sql)) writeAttempted = true;
      return { rows: [] };
    },
  });
  const result = await cache.getOrFetchCustomer('1', async () => null);
  assert.strictEqual(result, null);
  assert.strictEqual(writeAttempted, false);
  cache._resetDeps();
});

test('getTtlMs: defaults to 24 hours, overridable via QB_CUSTOMER_CACHE_TTL_MS', () => {
  const prev = process.env.QB_CUSTOMER_CACHE_TTL_MS;
  delete process.env.QB_CUSTOMER_CACHE_TTL_MS;
  assert.strictEqual(cache.getTtlMs(), 24 * 60 * 60 * 1000);
  process.env.QB_CUSTOMER_CACHE_TTL_MS = '1000';
  assert.strictEqual(cache.getTtlMs(), 1000);
  if (prev === undefined) delete process.env.QB_CUSTOMER_CACHE_TTL_MS;
  else process.env.QB_CUSTOMER_CACHE_TTL_MS = prev;
});

test('getCacheStats: reports available:false on a query failure', async () => {
  stubQuery(async () => { throw new Error('db down'); });
  const stats = await cache.getCacheStats();
  assert.strictEqual(stats.available, false);
  cache._resetDeps();
});

test('getCacheStats: reports real counts', async () => {
  stubQuery(async () => ({ rows: [{ total: '42', fresh_24h: '40' }] }));
  const stats = await cache.getCacheStats();
  assert.strictEqual(stats.available, true);
  assert.strictEqual(stats.total_cached, 42);
  assert.strictEqual(stats.fresh_within_24h, 40);
  cache._resetDeps();
});
