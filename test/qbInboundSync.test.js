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
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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

// ── syncInvoicesPaymentsIncremental: November 2026 "QB API consumption
// root-cause investigation" follow-up ───────────────────────────────────
//
// Official Intuit Developer Portal data (500,766 CorePlus calls/30 days —
// query/invoice 201,180, query/payment 201,175, Customer 98,285, 80%+ of
// ALL calls) confirmed syncAllMappedCustomers above as the dominant cost:
// its per-customer, non-incremental full-refetch loop re-fetches EVERY
// invoice/payment for EVERY mapped customer on EVERY tick. These tests
// cover the replacement: one company-wide, Change-Data-Capture-based
// incremental call covering every mapped customer's changes at once.

function makeCdcResponse(invoices, payments) {
  return { CDCResponse: [{ QueryResponse: [{ Invoice: invoices }, { Payment: payments }] }] };
}

test('syncInvoicesPaymentsIncremental: no cursor yet -> falls back to the SAME full per-customer reconciliation to establish a baseline', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [] };
      if (/SELECT DISTINCT qb_customer_id FROM leads/.test(sql)) return { rows: [{ qb_customer_id: 'C1' }] };
      if (/INSERT INTO sync_cursors/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.mode, 'cdc_fallback_full');
    assert.strictEqual(result.total, 1, 'delegated to the real syncAllMappedCustomers, which reports the full shape');
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncInvoicesPaymentsIncremental: cursor older than the CDC 30-day lookback cap -> falls back to full reconciliation, never attempts CDC', async () => {
  const oldWatermark = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [{ last_cursor: oldWatermark, last_updated_timestamp: oldWatermark }] };
      if (/SELECT DISTINCT qb_customer_id FROM leads/.test(sql)) return { rows: [{ qb_customer_id: 'C1' }] };
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  let cdcAttempted = false;
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes('/cdc')) cdcAttempted = true;
      return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
    },
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.mode, 'cdc_fallback_full');
    assert.strictEqual(cdcAttempted, false, 'CDC cannot bridge a 40-day gap — must never even be attempted');
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncInvoicesPaymentsIncremental: fresh cursor -> calls CDC with a 5-minute overlap buffer, upserts changed records, marks Deleted-status records voided, and advances the cursor to the max LastUpdatedTime seen', async () => {
  const watermark = new Date('2026-11-27T00:00:00.000Z');
  const cursorRows = { last_cursor: watermark.toISOString(), last_updated_timestamp: watermark.toISOString() };
  const voidedInvoiceIds = [];
  const voidedPaymentIds = [];
  const cursorWrites = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [cursorRows] };
      if (/UPDATE qb_invoices_cache SET voided = TRUE.*WHERE qb_invoice_id/.test(sql)) { voidedInvoiceIds.push(params[0]); return { rows: [] }; }
      if (/UPDATE qb_payments_cache SET voided = TRUE.*WHERE qb_payment_id/.test(sql)) { voidedPaymentIds.push(params[0]); return { rows: [] }; }
      if (/INSERT INTO sync_cursors/.test(sql)) { cursorWrites.push(params); return { rows: [] }; }
      if (/SELECT id FROM leads WHERE qb_customer_id/.test(sql)) return { rows: [] }; // autoMapInvoiceToSale: no lead found, harmless
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  const upsertedInvoices = [];
  const upsertedPayments = [];
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', {
    upsertInvoiceCacheFromQb: async (_db, inv) => { upsertedInvoices.push(inv.Id); },
    upsertMapping: async () => {},
  });
  let cdcUrl = null;
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      cdcUrl = url;
      return {
        res: { ok: true, status: 200 }, text: '{}',
        json: makeCdcResponse(
          [
            { Id: 'INV1', CustomerRef: { value: 'C1' }, MetaData: { LastUpdatedTime: '2026-11-27T01:00:00.000Z' } },
            { Id: 'INV2', status: 'Deleted', MetaData: { LastUpdatedTime: '2026-11-27T02:00:00.000Z' } },
          ],
          [
            { Id: 'PAY1', CustomerRef: { value: 'C1' }, Line: [], MetaData: { LastUpdatedTime: '2026-11-27T01:30:00.000Z' } },
          ]
        ),
      };
    },
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'cdc');
    assert.strictEqual(result.invoices_upserted, 1);
    assert.strictEqual(result.invoices_deleted, 1);
    assert.strictEqual(result.payments_upserted, 1);
    assert.deepStrictEqual(upsertedInvoices, ['INV1']);
    assert.deepStrictEqual(voidedInvoiceIds, ['INV2']);
    assert.strictEqual(voidedPaymentIds.length, 0);
    // Overlap buffer: changedSince is 5 minutes BEFORE the stored watermark.
    const changedSinceParam = new URL(cdcUrl).searchParams.get('changedSince');
    assert.strictEqual(changedSinceParam, new Date(watermark.getTime() - 5 * 60 * 1000).toISOString());
    assert.ok(cdcUrl.includes('entities=Invoice%2CPayment') || cdcUrl.includes('entities=Invoice,Payment'));
    // Cursor advanced to the MAX LastUpdatedTime actually seen (the deleted
    // invoice's own timestamp, the latest of the three).
    assert.strictEqual(cursorWrites.length, 1);
    assert.strictEqual(cursorWrites[0][1], '2026-11-27T02:00:00.000Z');
  } finally { restoreDb(); restoreSaleMap(); restoreMgr(); }
});

test('syncInvoicesPaymentsIncremental: a circuit-breaker-open CDC call records the attempt and reports circuit_open, without falling back to a full sync (the cursor is still fresh — this is a transient block, not a lookback gap)', async () => {
  const watermark = new Date().toISOString();
  const attemptWrites = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [{ last_cursor: watermark, last_updated_timestamp: watermark }] };
      if (/INSERT INTO sync_cursors.*last_attempted_at.*last_sync_summary/.test(sql) || /INSERT INTO sync_cursors \(integration, last_attempted_at/.test(sql)) { attemptWrites.push(params); return { rows: [] }; }
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({ res: { ok: false, status: 'circuit_open' }, text: 'circuit_open', json: {}, circuitOpen: true }),
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.circuit_open, true);
    assert.strictEqual(result.mode, 'cdc');
    assert.strictEqual(attemptWrites.length, 1, 'the attempt is still recorded (last_attempted_at), even though no cursor-advancing write happens');
  } finally { restoreDb(); restoreMgr(); }
});

// ── November 2026 final-acceptance follow-up: a PARTIAL fallback or a
// CDC tick with item-level errors must never be reported as a genuine
// successful synchronization — lib/qbRecoveryVerification.js reads
// last_successful_sync_at specifically to decide whether a "QuickBooks
// recovered" email may fire, and a false-positive there would repeat the
// exact breaker-flapping false-recovery bug this engagement already fixed
// once for the circuit breaker itself (see CLAUDE.md's "CRM stabilization
// closure, round 2"). ───────────────────────────────────────────────────

test('syncInvoicesPaymentsIncremental: a PARTIAL fallback (some customers failed) never advances last_successful_sync_at or the watermark — only last_attempted_at', async () => {
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      sqlCalls.push(sql);
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [] };
      if (/SELECT DISTINCT qb_customer_id FROM leads/.test(sql)) return { rows: [{ qb_customer_id: 'C1' }, { qb_customer_id: 'C2' }] };
      if (/INSERT INTO sync_cursors/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      // C1 succeeds, C2 fails (a genuine, non-breaker error) — the full
      // sync's own outcome is 'partial', never a clean success.
      if (url.includes('C2')) return { res: { ok: false, status: 500 }, text: 'server error', json: {} };
      return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
    },
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.mode, 'cdc_fallback_full');
    assert.strictEqual(result.outcome, 'partial');
    const cursorInserts = sqlCalls.filter((s) => /INSERT INTO sync_cursors/.test(s));
    assert.strictEqual(cursorInserts.length, 1);
    assert.ok(!/last_successful_sync_at/.test(cursorInserts[0]), 'a partial fallback must never touch last_successful_sync_at');
    assert.ok(!/last_cursor/.test(cursorInserts[0]), 'a partial fallback must never advance the watermark either — some customers were never (re)fetched this attempt');
    assert.ok(/last_attempted_at/.test(cursorInserts[0]), 'the attempt itself is still recorded');
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncInvoicesPaymentsIncremental: a CLEAN fallback (every customer succeeds) DOES advance last_successful_sync_at and the watermark', async () => {
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      sqlCalls.push(sql);
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [] };
      if (/SELECT DISTINCT qb_customer_id FROM leads/.test(sql)) return { rows: [{ qb_customer_id: 'C1' }] };
      if (/INSERT INTO sync_cursors/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.mode, 'cdc_fallback_full');
    assert.strictEqual(result.outcome, 'success');
    const cursorInserts = sqlCalls.filter((s) => /INSERT INTO sync_cursors/.test(s));
    assert.strictEqual(cursorInserts.length, 1);
    assert.ok(/last_successful_sync_at/.test(cursorInserts[0]), 'a genuinely clean fallback must advance last_successful_sync_at');
    assert.ok(/last_cursor/.test(cursorInserts[0]), 'and the watermark — the full fetch really did bring every mapped customer current as of now');
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncInvoicesPaymentsIncremental: a CDC tick with an item-level error advances the watermark but never last_successful_sync_at', async () => {
  const watermark = new Date('2026-11-27T00:00:00.000Z');
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [{ last_cursor: watermark.toISOString(), last_updated_timestamp: watermark.toISOString() }] };
      if (/INSERT INTO sync_cursors/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  // Forces upsertInvoiceCacheFromQb to throw for INV1 only — INV2 succeeds,
  // so the tick's outcome is genuinely MIXED ('partial'), never a real
  // breaker/network issue (CDC mode's per-item loop makes zero further
  // QuickBooks calls at all).
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', {
    upsertInvoiceCacheFromQb: async (_db, inv) => { if (inv.Id === 'INV1') throw new Error('constraint violation'); },
    upsertMapping: async () => {},
  });
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({
      res: { ok: true, status: 200 }, text: '{}',
      json: makeCdcResponse([
        { Id: 'INV1', CustomerRef: { value: 'C1' }, MetaData: { LastUpdatedTime: '2026-11-27T01:00:00.000Z' } },
        { Id: 'INV2', CustomerRef: { value: 'C1' }, MetaData: { LastUpdatedTime: '2026-11-27T01:30:00.000Z' } },
      ], []),
    }),
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.mode, 'cdc');
    assert.strictEqual(result.outcome, 'partial');
    assert.strictEqual(result.errors.length, 1);
    const cursorInserts = sqlCalls.filter((c) => /INSERT INTO sync_cursors/.test(c.sql));
    assert.strictEqual(cursorInserts.length, 1);
    assert.ok(!/last_successful_sync_at/.test(cursorInserts[0].sql), 'an item-level error must never be reported as a genuine successful sync');
    assert.ok(/last_cursor/.test(cursorInserts[0].sql), 'the watermark still advances — forward progress is safe, every write here is idempotent on retry');
    assert.strictEqual(cursorInserts[0].params[1], '2026-11-27T01:30:00.000Z', 'advances to the max LastUpdatedTime actually seen (INV2, the later of the two), even though INV1 errored');
    const failedRecordInserts = sqlCalls.filter((c) => /INSERT INTO qb_cdc_failed_records/.test(c.sql));
    assert.strictEqual(failedRecordInserts.length, 1, 'the failed item (INV1) must be durably recorded so it can be retried later — the watermark advancing past it means CDC itself will never return it again');
    assert.strictEqual(failedRecordInserts[0].params[0], 'invoice');
    assert.strictEqual(failedRecordInserts[0].params[1], 'INV1');
  } finally { restoreDb(); restoreSaleMap(); restoreMgr(); }
});

test('recordCdcItemFailure: inserts the raw payload keyed by (entity_type, qb_id), never throws even on a DB error', async () => {
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => { sqlCalls.push({ sql, params }); return { rows: [] }; },
  });
  const qbInboundSync = freshQbInboundSync();
  try {
    await qbInboundSync.recordCdcItemFailure('invoice', 'INV1', { Id: 'INV1', TotalAmt: 100 }, 'constraint violation');
    assert.strictEqual(sqlCalls.length, 1);
    assert.match(sqlCalls[0].sql, /INSERT INTO qb_cdc_failed_records/);
    assert.match(sqlCalls[0].sql, /ON CONFLICT \(entity_type, qb_id\) DO UPDATE/);
    assert.deepStrictEqual(JSON.parse(sqlCalls[0].params[2]), { Id: 'INV1', TotalAmt: 100 });
  } finally { restoreDb(); }

  const restoreThrowingDb = stub('../db/client', {
    query: async () => { throw new Error('connection reset'); },
  });
  const qbInboundSync2 = freshQbInboundSync();
  try {
    await qbInboundSync2.recordCdcItemFailure('payment', 'PMT1', { Id: 'PMT1' }, 'boom'); // must not throw
  } finally { restoreThrowingDb(); }
});

test('retryFailedCdcRecords: reprocesses a stored payload with ZERO QuickBooks API calls and marks it resolved on success', async () => {
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });
      if (/SELECT id, entity_type, qb_id, raw_payload FROM qb_cdc_failed_records/.test(sql)) {
        return { rows: [{ id: 'row-1', entity_type: 'invoice', qb_id: 'INV1', raw_payload: { Id: 'INV1', CustomerRef: { value: 'C1' } } }] };
      }
      return { rows: [] };
    },
  });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', {
    upsertInvoiceCacheFromQb: async () => {},
    upsertMapping: async () => {},
  });
  // No lib/qbTokenManager stub at all — proves the retry path never calls
  // qbApiRequest (would throw "Cannot find module" or hit a real network
  // call otherwise, since the real module isn't stubbed here).
  const qbInboundSync = freshQbInboundSync();
  try {
    const result = await qbInboundSync.retryFailedCdcRecords();
    assert.strictEqual(result.attempted, 1);
    assert.strictEqual(result.resolved, 1);
    assert.strictEqual(result.stillFailing, 0);
    const resolveCall = sqlCalls.find((c) => /UPDATE qb_cdc_failed_records SET resolved_at = NOW\(\)/.test(c.sql));
    assert.ok(resolveCall, 'a successful reprocess must mark the row resolved');
    assert.strictEqual(resolveCall.params[0], 'row-1');
  } finally { restoreDb(); restoreSaleMap(); }
});

test('retryFailedCdcRecords: a record that still fails increments attempts/last_error rather than being silently dropped', async () => {
  const sqlCalls2 = [];
  const restoreThrowingSaleMap = stub('../lib/qbInvoiceSaleMap', {
    upsertInvoiceCacheFromQb: async () => { throw new Error('still broken'); },
    upsertMapping: async () => {},
  });
  const restoreDb2 = stub('../db/client', {
    query: async (sql, params) => {
      sqlCalls2.push({ sql, params });
      if (/SELECT id, entity_type, qb_id, raw_payload FROM qb_cdc_failed_records/.test(sql)) {
        return { rows: [{ id: 'row-3', entity_type: 'invoice', qb_id: 'INV2', raw_payload: { Id: 'INV2', CustomerRef: { value: 'C1' } } }] };
      }
      return { rows: [] };
    },
  });
  const qbInboundSync2 = freshQbInboundSync();
  try {
    const result2 = await qbInboundSync2.retryFailedCdcRecords();
    assert.strictEqual(result2.stillFailing, 1);
    assert.strictEqual(result2.resolved, 0);
    const retryUpdate = sqlCalls2.find((c) => /UPDATE qb_cdc_failed_records SET attempts = attempts \+ 1/.test(c.sql));
    assert.ok(retryUpdate, 'a still-failing record must have its attempts/last_error updated, never silently dropped');
    assert.strictEqual(retryUpdate.params[0], 'row-3');
  } finally { restoreDb2(); restoreThrowingSaleMap(); }
});

test('syncInvoicesPaymentsIncremental: calls retryFailedCdcRecords on every tick, even when no QB tokens are available', async () => {
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  const restoreMgr = stub('../lib/qbTokenManager', { getValidTokens: async () => null });
  const qbInboundSync = freshQbInboundSync();
  try {
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.reason, 'no_qb_tokens');
    assert.ok(result.cdc_retry, 'the retry pass must run every tick, independent of QB connection state');
    const retrySelect = sqlCalls.find((c) => /SELECT id, entity_type, qb_id, raw_payload FROM qb_cdc_failed_records/.test(c.sql));
    assert.ok(retrySelect, 'retryFailedCdcRecords must be called even when there are no valid QB tokens, since it makes zero QuickBooks API calls');
  } finally { restoreDb(); restoreMgr(); }
});

test('syncInvoicesPaymentsIncremental: a CDC response at/above the 1000-object truncation threshold falls back to full reconciliation rather than trusting a possibly-incomplete response', async () => {
  const watermark = new Date('2026-11-27T00:00:00.000Z');
  const bigInvoiceList = Array.from({ length: 1000 }, (_, i) => ({ Id: `INV${i}`, CustomerRef: { value: 'C1' }, MetaData: { LastUpdatedTime: '2026-11-27T01:00:00.000Z' } }));
  let fullSyncCustomerQueried = false;
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT last_cursor, last_updated_timestamp FROM sync_cursors/.test(sql)) return { rows: [{ last_cursor: watermark.toISOString(), last_updated_timestamp: watermark.toISOString() }] };
      if (/SELECT DISTINCT qb_customer_id FROM leads/.test(sql)) { fullSyncCustomerQueried = true; return { rows: [{ qb_customer_id: 'C1' }] }; }
      if (/INSERT INTO sync_cursors/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    pool: makeFakePool(),
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  const restoreTokenStore = stub('../lib/qbTokenStore', { markUsed: async () => {} });
  const restoreSaleMap = stub('../lib/qbInvoiceSaleMap', { upsertInvoiceCacheFromQb: async () => {}, upsertMapping: async () => {} });
  let cdcCalled = false;
  const restoreMgr = stub('../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes('/cdc')) { cdcCalled = true; return { res: { ok: true, status: 200 }, text: '{}', json: makeCdcResponse(bigInvoiceList, []) }; }
      // The fallback full reconciliation's own per-customer query — never a second CDC call.
      return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
    },
  });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {} });

  try {
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(cdcCalled, true, 'the CDC call itself still happens once, to discover the truncation risk');
    assert.strictEqual(result.mode, 'cdc_fallback_full', 'a suspected-truncated response falls back to the full per-customer reconciliation instead of trusting it');
    assert.strictEqual(fullSyncCustomerQueried, true);
  } finally { restoreDb(); restoreTokenStore(); restoreSaleMap(); restoreMgr(); }
});

test('syncInvoicesPaymentsIncremental: an overlapping call is skipped, never run concurrently (same advisory-lock pattern as syncAllMappedCustomers)', async () => {
  const fakePool = makeFakePool();
  const restoreDb = stub('../db/client', {
    query: async () => ({ rows: [] }),
    pool: fakePool,
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
  });
  const restoreMgr = stub('../lib/qbTokenManager', { getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }) });

  const qbInboundSync = freshQbInboundSync();
  qbInboundSync._setDeps({ sleep: async () => {}, pool: () => fakePool });

  try {
    const held = await fakePool.connect();
    await held.query('SELECT pg_try_advisory_lock($1, hashtext($2::text)) AS locked', [1005, 'qb-cdc-incremental']);
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.deepStrictEqual(result, { skipped: true, reason: 'already_in_progress' });
  } finally { restoreDb(); restoreMgr(); }
});

test('syncAllMappedCustomers: an overlapping call (same or a different process, sharing the lock) is skipped, never run concurrently', async () => {
  const fakePool = makeFakePool();
  const restoreDb = stub('../db/client', {
    query: async (sql) => (/SELECT DISTINCT qb_customer_id/.test(sql) ? { rows: [{ qb_customer_id: 'C1' }] } : { rows: [] }),
    pool: fakePool,
    guardClient: (c) => { c._guardErrored = c._guardErrored || (() => false); return c; },
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
