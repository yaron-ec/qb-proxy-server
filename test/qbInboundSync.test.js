/* eslint-disable no-undef */
'use strict';

/**
 * qbInboundSync.test.js — lib/qbInboundSync.js#syncAllMappedCustomers, the
 * QB Inbound Reconciliation cron's core loop.
 *
 * October 2026 production incident: Railway logs showed a successful token
 * refresh ("[qb-token] access token refreshed") immediately followed by
 * "[qb-inbound-cron] reconcile ok — total=100 synced=0 failed=100", repeating
 * every 15 minutes. Root cause: this loop issued at least 2 sequential QB API
 * calls per mapped customer with ZERO pacing between them — fine at a
 * handful of customers, but at ~100 mapped customers this bursts well past
 * Intuit's rate limit, and (before this fix) lib/qbTokenManager.js#qbApiRequest
 * had NO retry/backoff for a 429/5xx on an actual data call (only for 401) —
 * so every call after the limit was hit failed immediately, cascading into
 * every subsequent customer in that tick also failing. The per-customer
 * error reason WAS computed here but never reached the server logs (only
 * the aggregate total/synced/failed counts were ever logged) — this file
 * also covers the new structured, sanitized failureSummary that closes that
 * observability gap.
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

function freshQbInboundSync() {
  delete require.cache[require.resolve('../lib/qbInboundSync')];
  return require('../lib/qbInboundSync');
}

// Fake Postgres advisory-lock pool (lib/advisoryLock.js#tryWithAdvisoryLock)
// — syncAllMappedCustomers now takes this cross-process lock instead of an
// in-process `_syncing` boolean (October 2026, round 2: a plain JS boolean
// never protected against two Railway replicas/processes racing the same
// database). A real Postgres session-level lock behaves per CONNECTION, so
// this fake mirrors that: each connect() gets its own "session", and a
// second session trying the same key while the first still holds it is
// denied — exactly like two overlapping ticks (same or different process).
function makeFakePool() {
  const held = new Set();
  return {
    connect: async () => ({
      query: async (sql, params) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          const key = `${params[0]}:${params[1]}`;
          if (held.has(key)) return { rows: [{ locked: false }] };
          held.add(key);
          return { rows: [{ locked: true }] };
        }
        if (/pg_advisory_unlock/.test(sql)) {
          held.delete(`${params[0]}:${params[1]}`);
          return { rows: [] };
        }
        return { rows: [] };
      },
      release() {},
    }),
  };
}

test('syncAllMappedCustomers: paces between customers and reports a sanitized, status-keyed failure summary (never a raw error body)', async () => {
  const customerIds = ['C1', 'C2', 'C3'];
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT DISTINCT qb_customer_id/.test(sql)) return { rows: customerIds.map((id) => ({ qb_customer_id: id })) };
      return { rows: [] }; // every UPDATE/cache write below
    },
    pool: makeFakePool(),
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', {
    upsertInvoiceCacheFromQb: async () => {},
    upsertMapping: async () => {},
  });
  // C1: Invoice query 429s outright. C2 and C3: succeed (empty Invoice/Payment lists).
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes('C1')) return { res: { ok: false, status: 429 }, text: 'rate limited', json: {} };
      return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
    },
  });

  const qbInboundSync = freshQbInboundSync();
  const sleeps = [];
  qbInboundSync._setDeps({ sleep: async (ms) => { sleeps.push(ms); } });

  try {
    const result = await qbInboundSync.syncAllMappedCustomers();
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.synced, 2);
    assert.strictEqual(result.failed, 1);
    assert.deepStrictEqual(result.failureSummary, { status_429: 1 });
    // Paced between EVERY pair of customers, never after the last one.
    assert.deepStrictEqual(sleeps, [200, 200]);
    // The failure summary must never contain the raw error text/body.
    assert.ok(!JSON.stringify(result.failureSummary).includes('rate limited'));
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncAllMappedCustomers: a status-less failure (e.g. a DB write error) is summarized under "other"', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT DISTINCT qb_customer_id/.test(sql)) return { rows: [{ qb_customer_id: 'C1' }] };
      if (/UPDATE leads SET qb_last_sync_at = NOW\(\), qb_last_sync_result = \$1, updated_at/.test(sql)) throw new Error('db write failed');
      return { rows: [] };
    },
    pool: makeFakePool(),
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({ res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } }),
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncAllMappedCustomers();
    assert.strictEqual(result.failed, 1);
    assert.deepStrictEqual(result.failureSummary, { other: 1 });
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncAllMappedCustomers: zero failures -> an empty failureSummary, not a missing field', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT DISTINCT qb_customer_id/.test(sql)) return { rows: [{ qb_customer_id: 'C1' }] };
      return { rows: [] };
    },
    pool: makeFakePool(),
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({ res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } }),
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncAllMappedCustomers();
    assert.strictEqual(result.failed, 0);
    assert.deepStrictEqual(result.failureSummary, {});
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncAllMappedCustomers: single customer -> zero pacing sleeps (nothing to pace between)', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => (/SELECT DISTINCT qb_customer_id/.test(sql) ? { rows: [{ qb_customer_id: 'C1' }] } : { rows: [] }),
    pool: makeFakePool(),
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({ res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } }),
  });

  const qbInboundSync = freshQbInboundSync();
  const sleeps = [];
  qbInboundSync._setDeps({ sleep: async (ms) => sleeps.push(ms) });

  try {
    await qbInboundSync.syncAllMappedCustomers();
    assert.deepStrictEqual(sleeps, []);
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncAllMappedCustomers: stops early the moment the circuit breaker opens, instead of grinding through every remaining customer', async () => {
  const customerIds = ['C1', 'C2', 'C3', 'C4', 'C5'];
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT DISTINCT qb_customer_id/.test(sql)) return { rows: customerIds.map((id) => ({ qb_customer_id: id })) };
      return { rows: [] };
    },
    pool: makeFakePool(),
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  // C1 succeeds; C2's Invoice query reports the breaker is open (a
  // synthetic, no-network skip) — C3/C4/C5 must never even be attempted.
  const attempted = [];
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      attempted.push(url);
      if (url.includes('C2')) return { res: { ok: false, status: 'circuit_open' }, text: 'circuit_open', json: {}, circuitOpen: true };
      return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
    },
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncAllMappedCustomers();
    assert.strictEqual(result.stopped_early, true);
    assert.strictEqual(result.total, 5, 'the candidate list size, even though not all were attempted');
    assert.strictEqual(result.results.length, 2, 'only C1 and C2 were actually processed');
    assert.deepStrictEqual(result.failureSummary, { status_circuit_open: 1 });
    assert.ok(!attempted.some((u) => u.includes('C3') || u.includes('C4') || u.includes('C5')), 'C3/C4/C5 never even attempted');
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncAllMappedCustomers: an overlapping call (same or a different process, sharing the lock) is skipped, never run concurrently', async () => {
  const fakePool = makeFakePool();
  const restoreDb = stub('../db/client', {
    query: async (sql) => (/SELECT DISTINCT qb_customer_id/.test(sql) ? { rows: [{ qb_customer_id: 'C1' }] } : { rows: [] }),
    pool: fakePool,
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({ res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } }),
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {}, pool: () => fakePool });

  try {
    // Simulate a second process/replica already holding the SAME advisory
    // lock key (1005, 'qb-inbound-reconcile') when this tick starts.
    const held = await fakePool.connect();
    const r = await held.query('SELECT pg_try_advisory_lock($1, hashtext($2::text)) AS locked', [1005, 'qb-inbound-reconcile']);
    assert.strictEqual(r.rows[0].locked, true, 'the simulated other holder acquires it first');

    const result = await qbInboundSync.syncAllMappedCustomers();
    assert.deepStrictEqual(result, { skipped: true, reason: 'already_in_progress' });
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});
