/* eslint-disable no-undef */
'use strict';

/**
 * advisoryLock.test.js — lib/advisoryLock.js#withAdvisoryLock, the generic
 * Postgres advisory-lock helper extracted during the October 2026
 * QuickBooks reliability audit (used by server.js's legacy QB proxy write
 * routes to prevent duplicate-creation races).
 */
const test = require('node:test');
const assert = require('node:assert');
const { withAdvisoryLock } = require('../lib/advisoryLock');

function fakePool() {
  const calls = [];
  const client = {
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
    release: () => {},
  };
  return { pool: { connect: async () => client }, calls };
}

test('acquires the lock with namespace+hashtext(key), runs fn, releases, and returns fn\'s result', async () => {
  const { pool, calls } = fakePool();
  const result = await withAdvisoryLock(pool, 1004, 'customer:Jane Doe', async () => 'done');
  assert.strictEqual(result, 'done');
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].sql, /pg_advisory_lock/);
  assert.deepStrictEqual(calls[0].params, [1004, 'customer:Jane Doe']);
  assert.match(calls[1].sql, /pg_advisory_unlock/);
  assert.deepStrictEqual(calls[1].params, [1004, 'customer:Jane Doe']);
});

test('releases the lock even when fn() throws, and the lock release failure is swallowed', async () => {
  const { pool, calls } = fakePool();
  await assert.rejects(
    withAdvisoryLock(pool, 1004, 'estimate:C1:EST-1', async () => { throw new Error('qb boom'); }),
    /qb boom/
  );
  assert.strictEqual(calls.length, 2, 'unlock must still run after a throw');
  assert.match(calls[1].sql, /pg_advisory_unlock/);
});

test('releases the client back to the pool even if unlock itself fails', async () => {
  const client = {
    query: async (sql) => {
      if (/unlock/.test(sql)) throw new Error('unlock failed');
      return { rows: [] };
    },
    release: () => { client.released = true; },
  };
  const pool = { connect: async () => client };
  const result = await withAdvisoryLock(pool, 1004, 'k', async () => 42);
  assert.strictEqual(result, 42);
  assert.strictEqual(client.released, true);
});

test('two different keys produce two independent lock/unlock call pairs (no cross-key coupling)', async () => {
  const { pool, calls } = fakePool();
  await withAdvisoryLock(pool, 1004, 'customer:A', async () => {});
  await withAdvisoryLock(pool, 1004, 'customer:B', async () => {});
  assert.deepStrictEqual(calls.map((c) => c.params[1]), ['customer:A', 'customer:A', 'customer:B', 'customer:B']);
});
