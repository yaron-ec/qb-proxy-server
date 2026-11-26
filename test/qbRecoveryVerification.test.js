/* eslint-disable no-undef */
'use strict';

/**
 * qbRecoveryVerification.test.js — pure, DB-stubbed unit coverage for the
 * November 2026 CRM final-acceptance requirement: a QuickBooks "recovered"
 * notification must only ever fire once dependent synchronization has
 * genuinely caught up, never merely because auth succeeded or the circuit
 * breaker closed. End-to-end wiring into productionWatchdog.js is covered
 * in test/productionWatchdogQbRecoveryVerification.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../lib/qbRecoveryVerification');

function stubDeps({ query, breakerState, syncStatus, syncStatusError }) {
  mod._setDeps({
    query: query || (async () => ({ rows: [] })),
    getBreakerState: async () => breakerState,
    getQbSyncStatus: syncStatusError
      ? async () => { throw syncStatusError; }
      : async () => syncStatus,
  });
}

test.afterEach(() => mod._resetDeps());

test('isQbSyncCaughtUp: breaker not closed -> never caught up', async () => {
  stubDeps({ breakerState: { state: 'open' }, syncStatus: {} });
  const r = await mod.isQbSyncCaughtUp();
  assert.strictEqual(r.caughtUp, false);
  assert.strictEqual(r.reason, 'breaker_not_closed');
});

test('isQbSyncCaughtUp: breaker closed but a cursor has not yet run a successful sync since recovery -> not caught up', async () => {
  stubDeps({
    breakerState: { state: 'closed', last_transition_at: '2026-11-25T20:00:00Z' },
    syncStatus: {
      estimate_sync: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T19:00:00Z' }, // BEFORE recovery
      inbound_reconcile: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:10:00Z' },
    },
  });
  const r = await mod.isQbSyncCaughtUp();
  assert.strictEqual(r.caughtUp, false);
  assert.strictEqual(r.reason, 'estimate_sync_not_yet_resynced_since_recovery');
});

test('isQbSyncCaughtUp: both cursors show a real success at or after recovery -> caught up', async () => {
  stubDeps({
    breakerState: { state: 'closed', last_transition_at: '2026-11-25T20:00:00Z' },
    syncStatus: {
      estimate_sync: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:05:00Z' },
      inbound_reconcile: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:00:00Z' },
    },
  });
  const r = await mod.isQbSyncCaughtUp();
  assert.strictEqual(r.caughtUp, true);
});

test('isQbSyncCaughtUp: a cursor that has literally never run yet is not evidence of a failed catch-up', async () => {
  stubDeps({
    breakerState: { state: 'closed', last_transition_at: '2026-11-25T20:00:00Z' },
    syncStatus: {
      estimate_sync: { available: true, ever_run: false },
      inbound_reconcile: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:10:00Z' },
    },
  });
  const r = await mod.isQbSyncCaughtUp();
  assert.strictEqual(r.caughtUp, true);
});

test('isQbSyncCaughtUp: an unavailable cursor -> not caught up, distinct reason', async () => {
  stubDeps({
    breakerState: { state: 'closed', last_transition_at: '2026-11-25T20:00:00Z' },
    syncStatus: {
      estimate_sync: { available: false },
      inbound_reconcile: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:10:00Z' },
    },
  });
  const r = await mod.isQbSyncCaughtUp();
  assert.strictEqual(r.caughtUp, false);
  assert.strictEqual(r.reason, 'estimate_sync_unavailable');
});

test('isQbSyncCaughtUp: a getQbSyncStatus failure never throws, reports unavailable', async () => {
  stubDeps({ breakerState: { state: 'closed' }, syncStatusError: new Error('db down') });
  const r = await mod.isQbSyncCaughtUp();
  assert.strictEqual(r.caughtUp, false);
  assert.strictEqual(r.reason, 'sync_status_unavailable');
});

test('maybeNotifyVerifiedRecovery: nothing pending -> never calls sendFn', async () => {
  stubDeps({ query: async () => ({ rows: [] }), breakerState: { state: 'closed' }, syncStatus: {} });
  let called = false;
  const r = await mod.maybeNotifyVerifiedRecovery(async () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(r.notified, false);
});

test('maybeNotifyVerifiedRecovery: already notified -> never calls sendFn again', async () => {
  stubDeps({
    query: async () => ({ rows: [{ value: { incidentId: 'i1', notified: true } }] }),
    breakerState: { state: 'closed', last_transition_at: '2026-11-25T20:00:00Z' },
    syncStatus: { estimate_sync: { available: true, ever_run: false }, inbound_reconcile: { available: true, ever_run: false } },
  });
  let called = false;
  const r = await mod.maybeNotifyVerifiedRecovery(async () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(r.reason, 'no_pending_verification');
});

test('maybeNotifyVerifiedRecovery: pending + not yet caught up -> never calls sendFn, never marks notified', async () => {
  const writes = [];
  stubDeps({
    query: async (sql, params) => {
      if (/SELECT value/.test(sql)) return { rows: [{ value: { incidentId: 'i1', notified: false } }] };
      writes.push(params);
      return { rows: [] };
    },
    breakerState: { state: 'open' },
    syncStatus: {},
  });
  let called = false;
  const r = await mod.maybeNotifyVerifiedRecovery(async () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(r.reason, 'breaker_not_closed');
  assert.strictEqual(writes.length, 0, 'must never write a notified marker when nothing was sent');
});

test('maybeNotifyVerifiedRecovery: pending + caught up -> calls sendFn exactly once and persists notified:true', async () => {
  const writes = [];
  stubDeps({
    query: async (sql, params) => {
      if (/SELECT value/.test(sql)) return { rows: [{ value: { incidentId: 'i1', notified: false } }] };
      writes.push(params);
      return { rows: [] };
    },
    breakerState: { state: 'closed', last_transition_at: '2026-11-25T20:00:00Z' },
    syncStatus: {
      estimate_sync: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:05:00Z' },
      inbound_reconcile: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:05:00Z' },
    },
  });
  let callCount = 0;
  let receivedPending = null;
  let receivedCaughtUp = null;
  await mod.maybeNotifyVerifiedRecovery(async (pending, caughtUp) => {
    callCount++;
    receivedPending = pending;
    receivedCaughtUp = caughtUp;
  });
  assert.strictEqual(callCount, 1);
  assert.strictEqual(receivedPending.incidentId, 'i1');
  assert.strictEqual(receivedCaughtUp.caughtUp, true);
  assert.strictEqual(writes.length, 1);
  const persisted = JSON.parse(writes[0][1]);
  assert.strictEqual(persisted.notified, true);
  assert.ok(persisted.notified_at);
});

test('maybeNotifyVerifiedRecovery: a sendFn failure never throws back to the caller', async () => {
  stubDeps({
    query: async (sql) => (/SELECT value/.test(sql) ? { rows: [{ value: { incidentId: 'i1', notified: false } }] } : { rows: [] }),
    breakerState: { state: 'closed', last_transition_at: '2026-11-25T20:00:00Z' },
    syncStatus: {
      estimate_sync: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:05:00Z' },
      inbound_reconcile: { available: true, ever_run: true, last_successful_sync_at: '2026-11-25T20:05:00Z' },
    },
  });
  await assert.doesNotReject(() => mod.maybeNotifyVerifiedRecovery(async () => { throw new Error('smtp down'); }));
});

test('clearOnFailure: writes a null pending value, never throws on a query failure', async () => {
  const writes = [];
  stubDeps({ query: async (sql, params) => { writes.push(params); return { rows: [] }; }, breakerState: { state: 'closed' }, syncStatus: {} });
  await mod.clearOnFailure();
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0][1], 'null');

  mod._setDeps({ query: async () => { throw new Error('db down'); } });
  await assert.doesNotReject(() => mod.clearOnFailure());
});

test('markRecoveryPending: persists the incident id with notified:false', async () => {
  const writes = [];
  stubDeps({ query: async (sql, params) => { writes.push(params); return { rows: [] }; }, breakerState: { state: 'closed' }, syncStatus: {} });
  await mod.markRecoveryPending('inc-42');
  assert.strictEqual(writes.length, 1);
  const persisted = JSON.parse(writes[0][1]);
  assert.strictEqual(persisted.incidentId, 'inc-42');
  assert.strictEqual(persisted.notified, false);
});
