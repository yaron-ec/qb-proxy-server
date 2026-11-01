/* eslint-disable no-undef */
'use strict';

/**
 * qbWebhookDebounce.test.js — lib/qbWebhookDebounce.js, the bounded
 * coalescing guard added to routes/qbWebhook.js (October 2026 "sustained
 * 429, escalate to Intuit" reliability pass) so a burst of webhook
 * deliveries can trigger at most one full QB rescan per debounce window,
 * cross-process-safe via the same app_settings-backed atomic-claim pattern
 * lib/qbRateLimitBreaker.js already uses.
 *
 * The fake `query` below honestly simulates the real SQL's conditional
 * semantics (first claim always succeeds; a claim within the window is
 * denied; a claim after the window elapses succeeds again) rather than
 * just returning canned values, so this proves the actual logic, not a
 * restatement of it.
 */
const test = require('node:test');
const assert = require('node:assert');

let queryImpl = async () => { throw new Error('unexpected query in test'); };
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (...a) => queryImpl(...a) },
};

delete require.cache[require.resolve('../lib/qbWebhookDebounce')];
const { shouldTriggerWebhookSync, DEBOUNCE_WINDOW_MS, KEY } = require('../lib/qbWebhookDebounce');

function fakeDebounceStore() {
  let lastClaimedAt = null; // simulated wall-clock ms, or null if never claimed
  let now = 0;
  return {
    advance(ms) { now += ms; },
    query: async (sql, params) => {
      assert.strictEqual(params[0], KEY);
      const windowMs = Number(params[1]);
      if (lastClaimedAt === null || now - lastClaimedAt >= windowMs) {
        lastClaimedAt = now;
        return { rows: [{ value: String(now) }] };
      }
      return { rows: [] }; // WHERE clause did not match — no claim
    },
  };
}

test('first-ever call always succeeds (no prior row to conflict with)', async () => {
  const store = fakeDebounceStore();
  queryImpl = store.query;
  assert.strictEqual(await shouldTriggerWebhookSync(), true);
});

test('a second call within the debounce window is denied', async () => {
  const store = fakeDebounceStore();
  queryImpl = store.query;
  assert.strictEqual(await shouldTriggerWebhookSync(), true);
  store.advance(1000); // well within DEBOUNCE_WINDOW_MS
  assert.strictEqual(await shouldTriggerWebhookSync(), false);
});

test('a burst of many rapid deliveries claims exactly once', async () => {
  const store = fakeDebounceStore();
  queryImpl = store.query;
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(await shouldTriggerWebhookSync());
    store.advance(10); // 10ms apart — all well within the window
  }
  assert.strictEqual(results.filter(Boolean).length, 1, 'exactly one of the 10 rapid calls should succeed');
});

test('a call after the debounce window has elapsed succeeds again', async () => {
  const store = fakeDebounceStore();
  queryImpl = store.query;
  assert.strictEqual(await shouldTriggerWebhookSync(), true);
  store.advance(DEBOUNCE_WINDOW_MS + 1);
  assert.strictEqual(await shouldTriggerWebhookSync(), true, 'the window elapsed — a fresh claim must succeed');
});

test('a DB failure fails OPEN (returns true) — never silently drops a legitimate trigger', async () => {
  queryImpl = async () => { throw new Error('app_settings unreachable'); };
  const origWarn = console.warn;
  let warned = false;
  console.warn = (...args) => { warned = true; origWarn.apply(console, args); };
  try {
    assert.strictEqual(await shouldTriggerWebhookSync(), true);
    assert.strictEqual(warned, true, 'the failure must be logged, not silent');
  } finally { console.warn = origWarn; }
});
