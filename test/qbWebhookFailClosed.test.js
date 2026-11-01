/* eslint-disable no-undef */
'use strict';

/**
 * qbWebhookFailClosed.test.js — regression coverage for the October 2026
 * "sustained 429, escalate to Intuit" reliability pass's QB webhook fixes
 * (routes/qbWebhook.js):
 *
 *   1. Signature verification previously FAILED OPEN when
 *      QB_WEBHOOK_VERIFIER_TOKEN was unset (accepted ANY unsigned POST).
 *      Fixed: fails CLOSED (503) in PRODUCTION; preserves the lenient
 *      accept-without-verification behavior outside production (logged).
 *   2. A relevant webhook notification unconditionally triggered a FULL
 *      estimate rescan + FULL customer reconciliation with no awareness of
 *      the shared circuit breaker and no coalescing of repeated deliveries.
 *      Fixed: peeks the breaker's cooling-down state before triggering, and
 *      debounces repeated triggers via lib/qbWebhookDebounce.js.
 *
 * Same HTTP-level convention as test/metaWebhookFailClosed.test.js — real
 * Express server, real POST requests, no TEST_DATABASE_URL needed (the
 * breaker and debounce modules are stubbed, same as
 * test/systemHealthChecks.test.js's own require.cache convention, so no
 * real Postgres call happens in this file at all).
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'test-qb-webhook-verifier-token';

function sign(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function stubModule(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

// ── Pure unit tests on the exported verifyIntuitSignature ──────────────────
test('verifyIntuitSignature: returns false (fail-closed default) when QB_WEBHOOK_VERIFIER_TOKEN is unset', () => {
  delete process.env.QB_WEBHOOK_VERIFIER_TOKEN;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/qbWebhook'))];
  const qbWebhook = require(path.join(ROOT, 'routes/qbWebhook'));
  assert.strictEqual(qbWebhook.verifyIntuitSignature({ headers: {}, rawBody: Buffer.from('{}') }), false);
});

test('verifyIntuitSignature: returns false when configured but no signature header is present', () => {
  process.env.QB_WEBHOOK_VERIFIER_TOKEN = TOKEN;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/qbWebhook'))];
  const qbWebhook = require(path.join(ROOT, 'routes/qbWebhook'));
  assert.strictEqual(qbWebhook.verifyIntuitSignature({ headers: {}, rawBody: Buffer.from('{}') }), false);
  delete process.env.QB_WEBHOOK_VERIFIER_TOKEN;
});

test('verifyIntuitSignature: returns false when the signature was computed with the wrong secret', () => {
  process.env.QB_WEBHOOK_VERIFIER_TOKEN = TOKEN;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/qbWebhook'))];
  const qbWebhook = require(path.join(ROOT, 'routes/qbWebhook'));
  const rawBody = Buffer.from('{"eventNotifications":[]}');
  const fakeReq = { headers: { 'intuit-signature': sign('wrong-secret', rawBody) }, rawBody };
  assert.strictEqual(qbWebhook.verifyIntuitSignature(fakeReq), false);
  delete process.env.QB_WEBHOOK_VERIFIER_TOKEN;
});

test('verifyIntuitSignature: returns true for a correctly computed signature', () => {
  process.env.QB_WEBHOOK_VERIFIER_TOKEN = TOKEN;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/qbWebhook'))];
  const qbWebhook = require(path.join(ROOT, 'routes/qbWebhook'));
  const rawBody = Buffer.from('{"eventNotifications":[]}');
  const fakeReq = { headers: { 'intuit-signature': sign(TOKEN, rawBody) }, rawBody };
  assert.strictEqual(qbWebhook.verifyIntuitSignature(fakeReq), true);
  delete process.env.QB_WEBHOOK_VERIFIER_TOKEN;
});

// ── HTTP-level tests: the real POST / route, end to end ─────────────────────
const activeServers = [];
const RELEVANT_PAYLOAD = JSON.stringify({
  eventNotifications: [{ realmId: '123', dataChangeEvent: { entities: [{ name: 'Estimate', id: 'EST-1', operation: 'Create' }] } }],
});

async function startServer({ token, environment, breakerState, debounceAllows = true, syncCalls }) {
  if (token === undefined) delete process.env.QB_WEBHOOK_VERIFIER_TOKEN; else process.env.QB_WEBHOOK_VERIFIER_TOKEN = token;
  if (environment === undefined) delete process.env.QB_ENVIRONMENT; else process.env.QB_ENVIRONMENT = environment;

  const unstubs = [
    stubModule('lib/qbRateLimitBreaker', {
      getState: async () => breakerState || { state: 'closed' },
      isCoolingDown: (s) => !!(s && s.state === 'open' && s.cooldown_until && new Date(s.cooldown_until) > new Date()),
    }),
    stubModule('lib/qbWebhookDebounce', {
      shouldTriggerWebhookSync: async () => debounceAllows,
      DEBOUNCE_WINDOW_MS: 60000,
      KEY: 'qb_webhook_debounce',
    }),
    stubModule('lib/qbSyncTrigger', {
      runQbEstimateSyncAsync: async () => { if (syncCalls) syncCalls.estimate = (syncCalls.estimate || 0) + 1; },
    }),
    stubModule('lib/qbInboundSync', {
      syncAllMappedCustomers: async () => { if (syncCalls) syncCalls.inbound = (syncCalls.inbound || 0) + 1; },
    }),
  ];

  delete require.cache[require.resolve(path.join(ROOT, 'routes/qbWebhook'))];
  const express = require('express');
  const app = express();
  app.use('/qb-webhook', require(path.join(ROOT, 'routes/qbWebhook')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  activeServers.push({ server, unstubs });
  return `http://127.0.0.1:${server.address().port}/qb-webhook`;
}

test.after(async () => {
  delete process.env.QB_WEBHOOK_VERIFIER_TOKEN;
  delete process.env.QB_ENVIRONMENT;
  await Promise.all(activeServers.map(({ server, unstubs }) => {
    unstubs.forEach((u) => u());
    return new Promise((r) => server.close(r));
  }));
});

test('POST: token unset + production → 503 not_configured, never processes or triggers a sync', async () => {
  const syncCalls = {};
  const url = await startServer({ token: undefined, environment: 'production', syncCalls });
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: RELEVANT_PAYLOAD });
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.error, 'not_configured');
  assert.deepStrictEqual(syncCalls, {}, 'no sync may be triggered when the request was rejected');
});

test('POST: token unset + sandbox → 200, accepted without verification (lenient outside production)', async () => {
  const url = await startServer({ token: undefined, environment: 'sandbox' });
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventNotifications: [] }) });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.received, true);
});

test('POST: token set but no signature header → 401', async () => {
  const url = await startServer({ token: TOKEN, environment: 'production' });
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: RELEVANT_PAYLOAD });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'signature_verification_failed');
});

test('POST: token set with an incorrectly signed request (wrong secret) → 401', async () => {
  const url = await startServer({ token: TOKEN, environment: 'production' });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'intuit-signature': sign('attacker-guessed-secret', Buffer.from(RELEVANT_PAYLOAD)) },
    body: RELEVANT_PAYLOAD,
  });
  assert.strictEqual(res.status, 401);
});

test('POST: correctly signed, breaker closed, debounce allows → triggers both sync functions exactly once', async () => {
  const syncCalls = {};
  const url = await startServer({ token: TOKEN, environment: 'production', syncCalls });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'intuit-signature': sign(TOKEN, Buffer.from(RELEVANT_PAYLOAD)) },
    body: RELEVANT_PAYLOAD,
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.processed, 1);
  // The two sync calls are fire-and-forget (not awaited by the route) — give
  // their microtasks a tick to run before asserting.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(syncCalls.estimate, 1);
  assert.strictEqual(syncCalls.inbound, 1);
});

test('POST: correctly signed, breaker COOLING DOWN → sync is NOT triggered, still 200 (change not lost — the cron remains the recovery path)', async () => {
  const syncCalls = {};
  const url = await startServer({
    token: TOKEN, environment: 'production', syncCalls,
    breakerState: { state: 'open', cooldown_until: new Date(Date.now() + 60000).toISOString() },
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'intuit-signature': sign(TOKEN, Buffer.from(RELEVANT_PAYLOAD)) },
    body: RELEVANT_PAYLOAD,
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.processed, 1, 'the notification is still acknowledged/processed — only the rescan trigger is skipped');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(syncCalls, {}, 'no sync call may consume the breaker\'s recovery trial while it is cooling down');
});

test('POST: correctly signed, breaker closed but debounce denies (recent trigger) → sync is NOT triggered again, still 200', async () => {
  const syncCalls = {};
  const url = await startServer({ token: TOKEN, environment: 'production', syncCalls, debounceAllows: false });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'intuit-signature': sign(TOKEN, Buffer.from(RELEVANT_PAYLOAD)) },
    body: RELEVANT_PAYLOAD,
  });
  assert.strictEqual(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(syncCalls, {}, 'a debounced delivery must never trigger a second full rescan');
});

test('POST: a correctly signed EMPTY notification list never triggers a sync and never 503s/401s (proves the fix does not break legitimate signed traffic)', async () => {
  const syncCalls = {};
  const url = await startServer({ token: TOKEN, environment: 'production', syncCalls });
  const rawBody = JSON.stringify({ eventNotifications: [] });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'intuit-signature': sign(TOKEN, Buffer.from(rawBody)) },
    body: rawBody,
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.processed, 0);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(syncCalls, {});
});

test('GET /qb-webhook (verification handshake) is unaffected — still reachable with no token configured, any environment', async () => {
  const url = await startServer({ token: undefined, environment: 'production' });
  const res = await fetch(url);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'active');
});
