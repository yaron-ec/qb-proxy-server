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
const { withAdvisoryLock, tryWithAdvisoryLock } = require('../lib/advisoryLock');

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

// ── tryWithAdvisoryLock — the non-blocking variant (October 2026, round 2:
// cross-process/replica-safe cron re-entrancy — see lib/qbInboundSync.js
// and server.js's runQbEstimateSync, which replaced a plain in-process
// `_syncing`/`_estimateSyncRunning` boolean with this). ────────────────────
function fakeSessionPool() {
  // pg_try_advisory_lock is held per CONNECTION (session), not per process
  // — this fake mirrors that: a "held" set simulates the server-side lock
  // state shared across however many connect() calls come in.
  const held = new Set();
  const calls = [];
  return {
    held, calls,
    connect: async () => ({
      query: async (sql, params) => {
        calls.push({ sql, params });
        const key = `${params[0]}:${params[1]}`;
        if (/pg_try_advisory_lock/.test(sql)) {
          if (held.has(key)) return { rows: [{ locked: false }] };
          held.add(key);
          return { rows: [{ locked: true }] };
        }
        if (/pg_advisory_unlock/.test(sql)) { held.delete(key); return { rows: [] }; }
        return { rows: [] };
      },
      release: () => {},
    }),
  };
}

test('tryWithAdvisoryLock: acquires, runs fn, releases, and returns { skipped: false, result }', async () => {
  const pool = fakeSessionPool();
  const r = await tryWithAdvisoryLock(pool, 1005, 'qb-estimate-sync', async () => 'done');
  assert.deepStrictEqual(r, { skipped: false, result: 'done' });
  assert.strictEqual(pool.held.size, 0, 'released after fn completes');
});

test('tryWithAdvisoryLock: a second concurrent attempt on the SAME key is skipped immediately, never waits', async () => {
  const pool = fakeSessionPool();
  let releaseFirst;
  const first = tryWithAdvisoryLock(pool, 1005, 'qb-inbound-reconcile', () => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((r) => setTimeout(r, 5)); // let the first call actually acquire
  const second = await tryWithAdvisoryLock(pool, 1005, 'qb-inbound-reconcile', async () => 'should not run');
  assert.deepStrictEqual(second, { skipped: true });
  releaseFirst('first done');
  const firstResult = await first;
  assert.deepStrictEqual(firstResult, { skipped: false, result: 'first done' });
});

test('tryWithAdvisoryLock: different keys never block each other', async () => {
  const pool = fakeSessionPool();
  const [a, b] = await Promise.all([
    tryWithAdvisoryLock(pool, 1005, 'qb-estimate-sync', async () => 'a'),
    tryWithAdvisoryLock(pool, 1005, 'qb-inbound-reconcile', async () => 'b'),
  ]);
  assert.deepStrictEqual(a, { skipped: false, result: 'a' });
  assert.deepStrictEqual(b, { skipped: false, result: 'b' });
});

test('tryWithAdvisoryLock: the lock is released even when fn() throws, so a later attempt can still acquire it', async () => {
  const pool = fakeSessionPool();
  await assert.rejects(tryWithAdvisoryLock(pool, 1005, 'qb-estimate-sync', async () => { throw new Error('boom'); }), /boom/);
  const r = await tryWithAdvisoryLock(pool, 1005, 'qb-estimate-sync', async () => 'ok after throw');
  assert.deepStrictEqual(r, { skipped: false, result: 'ok after throw' });
});

// ── Unlock-failure hardening (merge-precondition review: "the Postgres
// advisory lock is correctly acquired and released, including on errors")
// — if the UNLOCK query itself fails, the session-level lock stays held on
// that exact connection (Postgres only releases it on a successful unlock
// or the session ending). Returning that connection to the pool as healthy
// would let some LATER, unrelated caller silently inherit an already-held
// lock. Both lock helpers must discard (not recycle) a connection whose
// unlock failed. ────────────────────────────────────────────────────────
function fakePoolWithFailingUnlock() {
  const released = [];
  const client = {
    query: async (sql) => {
      if (/unlock/.test(sql)) throw new Error('connection reset during unlock');
      return { rows: [{ locked: true }] };
    },
    release: (err) => released.push(err),
  };
  return { pool: { connect: async () => client }, released };
}

test('withAdvisoryLock: an unlock failure discards the connection (release called with a truthy arg), never recycled as healthy', async () => {
  const { pool, released } = fakePoolWithFailingUnlock();
  const result = await withAdvisoryLock(pool, 1004, 'k', async () => 'done');
  assert.strictEqual(result, 'done', 'fn\'s result is still returned despite the unlock failure');
  assert.strictEqual(released.length, 1);
  assert.ok(released[0], 'release must be called with a truthy value so pg-pool destroys this connection');
});

test('tryWithAdvisoryLock: an unlock failure discards the connection the same way', async () => {
  const { pool, released } = fakePoolWithFailingUnlock();
  const r = await tryWithAdvisoryLock(pool, 1005, 'qb-estimate-sync', async () => 'done');
  assert.deepStrictEqual(r, { skipped: false, result: 'done' });
  assert.strictEqual(released.length, 1);
  assert.ok(released[0]);
});

test('a SUCCESSFUL unlock releases the connection as healthy (falsy arg) — the common case is never penalized', async () => {
  const released = [];
  const client = { query: async () => ({ rows: [{ locked: true }] }), release: (err) => released.push(err) };
  const pool = { connect: async () => client };
  await withAdvisoryLock(pool, 1004, 'k', async () => 'done');
  assert.strictEqual(released.length, 1);
  assert.ok(!released[0], 'a healthy connection must be released with no error so the pool keeps reusing it');
});
