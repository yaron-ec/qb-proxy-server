/* eslint-disable no-undef */
'use strict';

/**
 * qbSyncStatus.test.js — lib/qbSyncStatus.js, the read model behind the
 * Integrations page's "sync status" display (October 2026 reliability
 * pass). Proves: real sync_cursors rows are read correctly for both
 * cursors, every section independently reports `available: false` on its
 * own query failure (never a 0 pretending to be verified), and the overall
 * shape never throws even when every query fails.
 */
const test = require('node:test');
const assert = require('node:assert');

// ── Stub db/client BEFORE requiring the module under test (top-level
// require), same convention as test/systemHealthChecks.test.js. ───────────
let queryImpl = async () => { throw new Error('unexpected query in test'); };
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (...a) => queryImpl(...a) },
};

delete require.cache[require.resolve('../lib/qbSyncStatus')];
const { getQbSyncStatus } = require('../lib/qbSyncStatus');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

test('reads both cursors, counts, and breaker state when everything succeeds', async () => {
  queryImpl = async (sql, params) => {
    if (/FROM sync_cursors WHERE integration = \$1/.test(sql) && params[0] === 'quickbooks_estimates') {
      return { rows: [{ last_successful_sync_at: '2026-10-30T08:00:00Z', last_attempted_at: '2026-10-30T08:15:00Z', last_sync_summary: { outcome: 'partial', last_error: 'DocNumber ABC: QB 429' } }] };
    }
    if (/FROM sync_cursors WHERE integration = \$1/.test(sql) && params[0] === 'quickbooks_inbound_reconcile') {
      return { rows: [] }; // never run
    }
    if (/FROM handoff_estimates WHERE sync_source/.test(sql)) return { rows: [{ total: 42, matched: 30, unmatched: 12 }] };
    if (/FROM qb_invoices_cache/.test(sql)) return { rows: [{ total: 17 }] };
    if (/FROM leads WHERE qb_customer_id/.test(sql)) return { rows: [{ total: 9 }] };
    throw new Error('unexpected query: ' + sql);
  };
  const unstubBreaker = stub('../lib/qbRateLimitBreaker', { getState: async () => ({ state: 'closed' }) });
  try {
    const status = await getQbSyncStatus();
    assert.strictEqual(status.estimate_sync.available, true);
    assert.strictEqual(status.estimate_sync.ever_run, true);
    assert.strictEqual(status.estimate_sync.last_successful_sync_at, '2026-10-30T08:00:00Z');
    assert.strictEqual(status.estimate_sync.summary.outcome, 'partial');
    assert.strictEqual(status.inbound_reconcile.available, true);
    assert.strictEqual(status.inbound_reconcile.ever_run, false);
    assert.strictEqual(status.estimates_synced.available, true);
    assert.strictEqual(status.estimates_synced.total, 42);
    assert.strictEqual(status.invoices_synced.total, 17);
    assert.strictEqual(status.customers_synced.total, 9);
    assert.deepStrictEqual(status.circuit_breaker, { state: 'closed' });
    assert.ok(status.generated_at);
  } finally { unstubBreaker(); }
});

test('a failing cursor query reports available:false for that section only, never a fabricated 0', async () => {
  queryImpl = async (sql, params) => {
    if (/FROM sync_cursors WHERE integration = \$1/.test(sql) && params[0] === 'quickbooks_estimates') {
      throw new Error('relation "sync_cursors" does not exist');
    }
    if (/FROM sync_cursors WHERE integration = \$1/.test(sql)) return { rows: [] };
    if (/FROM handoff_estimates WHERE sync_source/.test(sql)) return { rows: [{ total: 5, matched: 5, unmatched: 0 }] };
    if (/FROM qb_invoices_cache/.test(sql)) return { rows: [{ total: 2 }] };
    if (/FROM leads WHERE qb_customer_id/.test(sql)) return { rows: [{ total: 1 }] };
    throw new Error('unexpected query: ' + sql);
  };
  const unstubBreaker = stub('../lib/qbRateLimitBreaker', { getState: async () => ({ state: 'closed' }) });
  try {
    const status = await getQbSyncStatus();
    assert.strictEqual(status.estimate_sync.available, false);
    assert.strictEqual(status.inbound_reconcile.available, true);
    assert.strictEqual(status.estimates_synced.total, 5, 'other sections are unaffected by one failing query');
  } finally { unstubBreaker(); }
});

test('a failing count query reports available:false for that count only', async () => {
  queryImpl = async (sql) => {
    if (/FROM sync_cursors/.test(sql)) return { rows: [] };
    if (/FROM handoff_estimates WHERE sync_source/.test(sql)) throw new Error('boom');
    if (/FROM qb_invoices_cache/.test(sql)) return { rows: [{ total: 3 }] };
    if (/FROM leads WHERE qb_customer_id/.test(sql)) return { rows: [{ total: 1 }] };
    throw new Error('unexpected query: ' + sql);
  };
  const unstubBreaker = stub('../lib/qbRateLimitBreaker', { getState: async () => ({ state: 'closed' }) });
  try {
    const status = await getQbSyncStatus();
    assert.strictEqual(status.estimates_synced.available, false);
    assert.strictEqual(status.invoices_synced.available, true);
    assert.strictEqual(status.invoices_synced.total, 3);
  } finally { unstubBreaker(); }
});

test('a breaker read failure never throws the whole status call', async () => {
  queryImpl = async (sql) => {
    if (/FROM sync_cursors/.test(sql)) return { rows: [] };
    if (/FROM handoff_estimates WHERE sync_source/.test(sql)) return { rows: [{ total: 0, matched: 0, unmatched: 0 }] };
    if (/FROM qb_invoices_cache/.test(sql)) return { rows: [{ total: 0 }] };
    if (/FROM leads WHERE qb_customer_id/.test(sql)) return { rows: [{ total: 0 }] };
    throw new Error('unexpected query: ' + sql);
  };
  const unstubBreaker = stub('../lib/qbRateLimitBreaker', { getState: async () => { throw new Error('db down'); } });
  try {
    const status = await getQbSyncStatus();
    assert.strictEqual(status.circuit_breaker, null);
  } finally { unstubBreaker(); }
});
