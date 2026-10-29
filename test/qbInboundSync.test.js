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

test('syncAllMappedCustomers: paces between customers and reports a sanitized, status-keyed failure summary (never a raw error body)', async () => {
  const customerIds = ['C1', 'C2', 'C3'];
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT DISTINCT qb_customer_id/.test(sql)) return { rows: customerIds.map((id) => ({ qb_customer_id: id })) };
      return { rows: [] }; // every UPDATE/cache write below
    },
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
