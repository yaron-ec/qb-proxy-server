/* eslint-disable no-undef */
'use strict';

/**
 * metaWebhookFailClosed.test.js — regression coverage for the Railway
 * October 2026 incident-response security fix: routes/metaWebhook.js's
 * signature verification previously FAILED OPEN when META_APP_SECRET was
 * unset (`verifyMetaSignature` returned `true`, silently accepting ANY
 * unsigned leadgen payload). This proves the fixed fail-CLOSED behavior:
 *
 *   - META_APP_SECRET unset            → verifyMetaSignature() === false,
 *                                         and POST / responds 503 not_configured
 *                                         (never runs the leadgen ingestion logic).
 *   - META_APP_SECRET set, no/garbled
 *     signature header                 → verifyMetaSignature() === false,
 *                                         POST / responds 401.
 *   - META_APP_SECRET set, signature
 *     computed with the WRONG secret    → false / 401.
 *   - META_APP_SECRET set, correct
 *     HMAC-SHA256 signature             → verifyMetaSignature() === true.
 *
 * The HTTP-level tests spin up a real Express server (no mocking of the
 * route) and send real POST requests — no TEST_DATABASE_URL is needed
 * because a rejected request never reaches any DB-touching code
 * (lib/moduleGate's own fail-open-on-infra-error path only matters for a
 * request that gets past this check, which these never do except the
 * final "correct signature" case, documented below).
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SECRET = 'test-meta-app-secret';

function sign(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// ── Pure unit tests on the exported verifyMetaSignature ────────────────────
test('verifyMetaSignature: returns false (fail-closed) when META_APP_SECRET is unset', () => {
  delete process.env.META_APP_SECRET;
  delete process.env.FACEBOOK_APP_SECRET;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/metaWebhook'))];
  const metaWebhook = require(path.join(ROOT, 'routes/metaWebhook'));
  const fakeReq = { headers: {}, rawBody: Buffer.from('{}') };
  assert.strictEqual(metaWebhook.verifyMetaSignature(fakeReq), false);
});

test('verifyMetaSignature: returns false when configured but no signature header is present', () => {
  process.env.META_APP_SECRET = SECRET;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/metaWebhook'))];
  const metaWebhook = require(path.join(ROOT, 'routes/metaWebhook'));
  const fakeReq = { headers: {}, rawBody: Buffer.from('{}') };
  assert.strictEqual(metaWebhook.verifyMetaSignature(fakeReq), false);
  delete process.env.META_APP_SECRET;
});

test('verifyMetaSignature: returns false when the signature was computed with the wrong secret', () => {
  process.env.META_APP_SECRET = SECRET;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/metaWebhook'))];
  const metaWebhook = require(path.join(ROOT, 'routes/metaWebhook'));
  const rawBody = Buffer.from('{"entry":[]}');
  const fakeReq = { headers: { 'x-hub-signature-256': sign('wrong-secret', rawBody) }, rawBody };
  assert.strictEqual(metaWebhook.verifyMetaSignature(fakeReq), false);
  delete process.env.META_APP_SECRET;
});

test('verifyMetaSignature: returns true for a correctly computed signature', () => {
  process.env.META_APP_SECRET = SECRET;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/metaWebhook'))];
  const metaWebhook = require(path.join(ROOT, 'routes/metaWebhook'));
  const rawBody = Buffer.from('{"entry":[]}');
  const fakeReq = { headers: { 'x-hub-signature-256': sign(SECRET, rawBody) }, rawBody };
  assert.strictEqual(metaWebhook.verifyMetaSignature(fakeReq), true);
  delete process.env.META_APP_SECRET;
});

// ── HTTP-level tests: the real POST / route, end to end ─────────────────────
// META_APP_SECRET is captured as a module-level const at require() time (same
// pattern as lib/crypto.js's JWT_SECRET) — so each scenario below clears the
// require cache and mounts a FRESH server after setting/unsetting the env var,
// rather than changing it under an already-loaded module instance.
const activeServers = [];
async function startServer(secretValue) {
  if (secretValue === undefined) { delete process.env.META_APP_SECRET; delete process.env.FACEBOOK_APP_SECRET; }
  else process.env.META_APP_SECRET = secretValue;
  delete require.cache[require.resolve(path.join(ROOT, 'routes/metaWebhook'))];
  const express = require('express');
  const app = express();
  app.use('/meta-webhook', require(path.join(ROOT, 'routes/metaWebhook')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  activeServers.push(server);
  return `http://127.0.0.1:${server.address().port}/meta-webhook`;
}
test.after(async () => {
  delete process.env.META_APP_SECRET;
  await Promise.all(activeServers.map((s) => new Promise((r) => s.close(r))));
});

test('POST /meta-webhook with META_APP_SECRET unset: 503 not_configured — never processes the payload', async () => {
  const url = await startServer(undefined);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'fake-unsigned-123' } }] }] }),
  });
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.error, 'not_configured');
});

test('POST /meta-webhook with META_APP_SECRET set but no signature header: 401', async () => {
  const url = await startServer(SECRET);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [] }),
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'signature_verification_failed');
});

test('POST /meta-webhook with an incorrectly signed request (wrong secret): 401', async () => {
  const url = await startServer(SECRET);
  const rawBody = JSON.stringify({ entry: [] });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign('attacker-guessed-secret', Buffer.from(rawBody)) },
    body: rawBody,
  });
  assert.strictEqual(res.status, 401);
});

test('POST /meta-webhook with a correctly signed EMPTY entry list: passes verification (200, processed=0) — proves the fix does not break legitimate signed traffic', async () => {
  const url = await startServer(SECRET);
  const rawBody = JSON.stringify({ entry: [] });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(SECRET, Buffer.from(rawBody)) },
    body: rawBody,
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.received, true);
  assert.strictEqual(body.processed, 0);
});

test('GET /meta-webhook (verification handshake) is unaffected by the fix — still reachable with no secret configured', async () => {
  const url = await startServer(undefined);
  const res = await fetch(url);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'active');
});
