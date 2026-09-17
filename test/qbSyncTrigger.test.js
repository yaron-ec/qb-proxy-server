/* eslint-disable no-undef */
'use strict';

/**
 * qbSyncTrigger.test.js — webhook-triggered QuickBooks Estimate sync.
 *
 * Production defect: this module read/wrote its own `.qb-tokens.encrypted`
 * FILESYSTEM copy of QB OAuth tokens, independent of the canonical
 * Postgres-backed credential store (lib/qbTokenStore.js) server.js's own
 * mutexed refresh uses. The one-time Base44-exit migration deleted that
 * file, so `getValidTokens()`-equivalent lookup always returned null in
 * production and the webhook-triggered "low-latency" sync silently no-op'd
 * on every single webhook delivery — Estimates only ever appeared via the
 * 15-minute cron (previously also disabled by default — see the server.js
 * fix) or the manual Re-sync button. Fixed to reuse
 * lib/qbInboundSync.js's getValidTokens() — the same canonical token source
 * already used by production inbound reconciliation.
 *
 * Covers: new estimate (import+match), updated estimate, idempotent repeat
 * (no duplicate rows), unmatched customer, no-tokens-configured (graceful
 * skip, not a crash), and the concurrent-invocation guard.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.QB_ENVIRONMENT = 'sandbox';

let tokens = { access_token: 'tok', refresh_token: 'rtok', realm_id: 'realm1', expires_at: new Date(Date.now() + 3600000).toISOString() };
let getValidTokensImpl = async () => tokens;
const qbInboundSyncPath = require.resolve('../lib/qbInboundSync');
delete require.cache[qbInboundSyncPath];
require.cache[qbInboundSyncPath] = {
  id: qbInboundSyncPath, filename: qbInboundSyncPath, loaded: true,
  exports: { getValidTokens: (...a) => getValidTokensImpl(...a) },
};

let store; // { leads: [], estimates: [] }
function resetStore() {
  store = {
    leads: [{ id: 'lead-1', email: 'brian@example.com', first_name: 'Brian', last_name: 'Krantz' }],
    estimates: [],
  };
}
resetStore();

const rdaPath = require.resolve('../lib/railwayDataAccess');
delete require.cache[rdaPath];
require.cache[rdaPath] = {
  id: rdaPath, filename: rdaPath, loaded: true,
  exports: {
    isConfigured: () => true,
    list: async (entity) => {
      if (entity === 'Lead') return store.leads;
      if (entity === 'HandoffEstimate') return store.estimates;
      return [];
    },
    create: async (entity, fields) => {
      const row = { id: `est-${store.estimates.length + 1}`, ...fields };
      store.estimates.push(row);
      return row;
    },
    update: async (entity, id, fields) => {
      const row = store.estimates.find(e => e.id === id);
      Object.assign(row, fields);
      return row;
    },
  },
};

const qbMatchPath = require.resolve('../lib/qbMatch');
delete require.cache[qbMatchPath];
require.cache[qbMatchPath] = {
  id: qbMatchPath, filename: qbMatchPath, loaded: true,
  exports: {
    // Match by email — mirrors the real matcher's intent closely enough for these tests.
    findMatchingLead: (qbCustomer, leads) => leads.find(l => l.email && qbCustomer.PrimaryEmailAddr?.Address && l.email.toLowerCase() === qbCustomer.PrimaryEmailAddr.Address.toLowerCase()) || null,
  },
};

delete require.cache[require.resolve('../lib/qbSyncTrigger')];

function mockFetch(estimatesByCall) {
  let call = 0;
  return async (url) => {
    const u = String(url);
    if (u.includes('/query?query=')) {
      const batch = estimatesByCall[Math.min(call, estimatesByCall.length - 1)] || [];
      call++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ QueryResponse: { Estimate: batch } }) };
    }
    if (u.includes('/customer/')) {
      const idMatch = u.match(/\/customer\/([^?]+)/);
      const custId = idMatch && idMatch[1];
      const cust = MOCK_CUSTOMERS[custId] || {};
      return { ok: true, status: 200, json: async () => ({ Customer: cust }) };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

const MOCK_CUSTOMERS = {
  'cust-brian': { DisplayName: 'Brian Krantz', PrimaryEmailAddr: { Address: 'brian@example.com' } },
  'cust-unknown': { DisplayName: 'Nobody Matched', PrimaryEmailAddr: { Address: 'nobody@example.com' } },
};

test('a new estimate for a matched customer is imported and linked to the lead', async () => {
  resetStore();
  global.fetch = mockFetch([[
    { Id: 'qb-est-1', DocNumber: '1001', CustomerRef: { value: 'cust-brian', name: 'Brian Krantz' }, TotalAmt: 5000, TxnStatus: 'Pending', TxnDate: '2026-08-01', MetaData: { LastUpdatedTime: '2026-08-01T00:00:00Z' } },
  ]]);
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  await runQbEstimateSyncAsync();
  assert.strictEqual(store.estimates.length, 1);
  assert.strictEqual(store.estimates[0].qb_estimate_id, 'qb-est-1');
  assert.strictEqual(store.estimates[0].lead_id, 'lead-1');
  assert.strictEqual(store.estimates[0].match_status, 'matched');
  delete global.fetch;
});

test('a repeat webhook for the SAME estimate updates it in place — never a duplicate row', async () => {
  resetStore();
  global.fetch = mockFetch([[
    { Id: 'qb-est-1', DocNumber: '1001', CustomerRef: { value: 'cust-brian', name: 'Brian Krantz' }, TotalAmt: 5000, TxnStatus: 'Pending', TxnDate: '2026-08-01', MetaData: { LastUpdatedTime: '2026-08-01T00:00:00Z' } },
  ]]);
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  await runQbEstimateSyncAsync();
  await runQbEstimateSyncAsync();
  assert.strictEqual(store.estimates.length, 1, 'idempotent — one row for one qb_estimate_id, no matter how many times the webhook fires');
  delete global.fetch;
});

test('an updated estimate (amount/status change) updates the existing row', async () => {
  resetStore();
  store.estimates.push({ id: 'est-1', qb_estimate_id: 'qb-est-1', estimate_amount: 5000, estimate_status: 'Pending' });
  global.fetch = mockFetch([[
    { Id: 'qb-est-1', DocNumber: '1001', CustomerRef: { value: 'cust-brian', name: 'Brian Krantz' }, TotalAmt: 6500, TxnStatus: 'Accepted', TxnDate: '2026-08-01', MetaData: { LastUpdatedTime: '2026-08-02T00:00:00Z' } },
  ]]);
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  await runQbEstimateSyncAsync();
  assert.strictEqual(store.estimates.length, 1);
  assert.strictEqual(store.estimates[0].estimate_amount, 6500);
  assert.strictEqual(store.estimates[0].estimate_status, 'Accepted');
  delete global.fetch;
});

test('an estimate for a customer with no matching Lead is stored unmatched, not dropped', async () => {
  resetStore();
  global.fetch = mockFetch([[
    { Id: 'qb-est-2', DocNumber: '1002', CustomerRef: { value: 'cust-unknown', name: 'Nobody Matched' }, TotalAmt: 900, TxnStatus: 'Pending', TxnDate: '2026-08-01', MetaData: { LastUpdatedTime: '2026-08-01T00:00:00Z' } },
  ]]);
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  await runQbEstimateSyncAsync();
  assert.strictEqual(store.estimates.length, 1);
  assert.strictEqual(store.estimates[0].match_status, 'unmatched');
  assert.strictEqual(store.estimates[0].lead_id, undefined);
  delete global.fetch;
});

test('no QB tokens configured (reconnect required) — skips gracefully, does not throw', async () => {
  resetStore();
  getValidTokensImpl = async () => null;
  global.fetch = mockFetch([[]]);
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  await assert.doesNotReject(runQbEstimateSyncAsync());
  assert.strictEqual(store.estimates.length, 0);
  delete global.fetch;
  getValidTokensImpl = async () => tokens;
});

test('reconnectRequired: a revoked/expired refresh token surfaces as a caught, logged failure — never an unhandled crash', async () => {
  resetStore();
  getValidTokensImpl = async () => { throw new Error('Token refresh failed: invalid_grant'); };
  global.fetch = mockFetch([[]]);
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  await assert.doesNotReject(runQbEstimateSyncAsync());
  assert.strictEqual(store.estimates.length, 0);
  delete global.fetch;
  getValidTokensImpl = async () => tokens;
});

test('a transient QB API error (5xx) for one estimate does not abort the batch — other estimates still sync', async () => {
  resetStore();
  let queryCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/query?query=')) {
      queryCalls++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ QueryResponse: { Estimate: [
        { Id: 'qb-est-err', DocNumber: '2001', CustomerRef: { value: 'cust-error', name: 'Error Co' }, TotalAmt: 100, TxnStatus: 'Pending', TxnDate: '2026-08-01', MetaData: { LastUpdatedTime: '2026-08-01T00:00:00Z' } },
        { Id: 'qb-est-ok', DocNumber: '2002', CustomerRef: { value: 'cust-brian', name: 'Brian Krantz' }, TotalAmt: 200, TxnStatus: 'Pending', TxnDate: '2026-08-01', MetaData: { LastUpdatedTime: '2026-08-01T00:00:00Z' } },
      ] } }) };
    }
    if (u.includes('/customer/cust-error')) return { ok: false, status: 503, json: async () => { throw new Error('bad json'); } };
    if (u.includes('/customer/')) return { ok: true, status: 200, json: async () => (MOCK_CUSTOMERS['cust-brian'] ? { Customer: MOCK_CUSTOMERS['cust-brian'] } : { Customer: {} }) };
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  await assert.doesNotReject(runQbEstimateSyncAsync());
  // The customer fetch for cust-error is best-effort (caught) — the estimate
  // itself still gets stored (unmatched, since fullCustomer came back empty).
  assert.strictEqual(store.estimates.length, 2);
  assert.ok(store.estimates.some(e => e.qb_estimate_id === 'qb-est-ok' && e.match_status === 'matched'));
  delete global.fetch;
});

test('concurrent invocations are serialized — a sync already in progress is skipped, not run twice in parallel', async () => {
  resetStore();
  let resolveFetch;
  const gate = new Promise(r => { resolveFetch = r; });
  global.fetch = async (url) => {
    if (String(url).includes('/query?query=')) {
      await gate;
      return { ok: true, status: 200, text: async () => JSON.stringify({ QueryResponse: { Estimate: [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ Customer: {} }) };
  };
  const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
  const first = runQbEstimateSyncAsync();
  const second = runQbEstimateSyncAsync(); // should return immediately (already syncing)
  await second;
  resolveFetch();
  await first;
  delete global.fetch;
});
