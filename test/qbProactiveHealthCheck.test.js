/* eslint-disable no-undef */
'use strict';

/**
 * qbProactiveHealthCheck.test.js — lib/qbProactiveHealthCheck.js, the
 * read-only scheduled QuickBooks connection probe added during the October
 * 2026 QuickBooks reliability audit to close the "detection is purely
 * reactive" gap. It adds NO new refresh/notification mechanism — it only
 * decides WHEN to call the existing qbTokenManager.verifyConnection(), and
 * skips the call entirely when a real QB API call already succeeded
 * recently (avoiding redundant Intuit API usage).
 */
const test = require('node:test');
const assert = require('node:assert');
const { shouldSkipProactiveCheck, runProactiveHealthCheck } = require('../lib/qbProactiveHealthCheck');

test('shouldSkipProactiveCheck: never connected (no tokens) -> skip, reason not_connected', () => {
  const d = shouldSkipProactiveCheck(null, { skipIfRecentMs: 1000 });
  assert.deepStrictEqual(d, { skip: true, reason: 'not_connected' });
});

test('shouldSkipProactiveCheck: last_used_at within the recency window -> skip, reason recently_verified', () => {
  const now = Date.now();
  const tokens = { last_used_at: new Date(now - 5000).toISOString() };
  const d = shouldSkipProactiveCheck(tokens, { now, skipIfRecentMs: 10000 });
  assert.deepStrictEqual(d, { skip: true, reason: 'recently_verified' });
});

test('shouldSkipProactiveCheck: last_used_at older than the recency window -> do not skip', () => {
  const now = Date.now();
  const tokens = { last_used_at: new Date(now - 30 * 60 * 1000).toISOString() };
  const d = shouldSkipProactiveCheck(tokens, { now, skipIfRecentMs: 20 * 60 * 1000 });
  assert.deepStrictEqual(d, { skip: false, reason: null });
});

test('shouldSkipProactiveCheck: tokens exist but last_used_at is null (never actually used) -> do not skip', () => {
  const d = shouldSkipProactiveCheck({ last_used_at: null }, { now: Date.now(), skipIfRecentMs: 1000 });
  assert.strictEqual(d.skip, false);
});

test('runProactiveHealthCheck: skips and never calls verifyConnection when recently verified', async () => {
  let verifyCalls = 0;
  const now = Date.now();
  const tokenStore = { loadPersistedTokens: async () => ({ last_used_at: new Date(now - 1000).toISOString() }) };
  const qbTokenManager = { verifyConnection: async () => { verifyCalls++; return { ok: true }; } };
  const outcome = await runProactiveHealthCheck({ environment: 'production', apiBase: 'https://x', tokenStore, qbTokenManager, skipIfRecentMs: 60000, now });
  assert.deepStrictEqual(outcome, { ran: false, reason: 'recently_verified' });
  assert.strictEqual(verifyCalls, 0, 'must never call verifyConnection when skipping');
});

test('runProactiveHealthCheck: calls verifyConnection and returns its result when due', async () => {
  const now = Date.now();
  const tokenStore = { loadPersistedTokens: async () => ({ last_used_at: new Date(now - 3600000).toISOString() }) };
  let calledWith = null;
  const qbTokenManager = {
    verifyConnection: async (env, apiBase) => { calledWith = { env, apiBase }; return { ok: true, reconnectRequired: false }; },
  };
  const outcome = await runProactiveHealthCheck({ environment: 'production', apiBase: 'https://qb.example/v3/company', tokenStore, qbTokenManager, skipIfRecentMs: 1200000, now });
  assert.strictEqual(outcome.ran, true);
  assert.deepStrictEqual(outcome.result, { ok: true, reconnectRequired: false });
  assert.deepStrictEqual(calledWith, { env: 'production', apiBase: 'https://qb.example/v3/company' });
});

test('runProactiveHealthCheck: a genuine revocation surfaces reconnectRequired in the result (the existing notifyReconnectRequired path fires as a side effect of verifyConnection itself, not duplicated here)', async () => {
  const now = Date.now();
  const tokenStore = { loadPersistedTokens: async () => ({ last_used_at: new Date(now - 3600000).toISOString() }) };
  const qbTokenManager = { verifyConnection: async () => ({ ok: false, reconnectRequired: true, error: 'invalid_grant' }) };
  const outcome = await runProactiveHealthCheck({ environment: 'production', apiBase: 'https://x', tokenStore, qbTokenManager, skipIfRecentMs: 1200000, now });
  assert.strictEqual(outcome.ran, true);
  assert.strictEqual(outcome.result.reconnectRequired, true);
});

test('runProactiveHealthCheck: never connected at all -> skips without calling verifyConnection', async () => {
  let verifyCalls = 0;
  const tokenStore = { loadPersistedTokens: async () => null };
  const qbTokenManager = { verifyConnection: async () => { verifyCalls++; return { ok: true }; } };
  const outcome = await runProactiveHealthCheck({ environment: 'production', apiBase: 'https://x', tokenStore, qbTokenManager });
  assert.deepStrictEqual(outcome, { ran: false, reason: 'not_connected' });
  assert.strictEqual(verifyCalls, 0);
});
