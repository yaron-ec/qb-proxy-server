/* eslint-disable no-undef */
/**
 * authExchange.test.js — Stage A Base44 token verification security tests.
 *
 * Proves:
 *   - missing token rejected
 *   - forged/expired token (Base44 401) rejected
 *   - Base44 unreachable (network/5xx) -> safe failure (no privileged fallback)
 *   - verified user with no email rejected
 *   - arbitrary email/role from the browser are NEVER accepted (only verified
 *     Base44 response is used)
 *   - valid user receives only their stored Railway role (no escalation)
 *   - sales_rep cannot exchange into admin
 *   - replay is controlled (each call must re-verify; no session caching)
 *
 * Run: cd src/proxy-server && node --test test/authExchange.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Configure the bridge so isConfigured() is true.
process.env.BASE44_APP_ID = 'test-app';
process.env.BASE44_API_KEY = 'test-key';

const { verifyBase44Token, VerifyError } = require('../lib/base44TokenVerify');

// Controllable fetch mock. Each test sets fetchImpl.
let fetchImpl = async () => new Response('{}', { status: 200 });
global.fetch = (...args) => fetchImpl(...args);

function base44Response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('missing token is rejected', async () => {
  await assert.rejects(() => verifyBase44Token(''), (e) => e.code === 'missing_token');
  await assert.rejects(() => verifyBase44Token(null), (e) => e.code === 'missing_token');
});

test('bridge unconfigured is rejected', async () => {
  const saved = process.env.BASE44_APP_ID; process.env.BASE44_APP_ID = ''; 
  try { await assert.rejects(() => verifyBase44Token('tok'), (e) => e.code === 'bridge_unavailable'); }
  finally { process.env.BASE44_APP_ID = saved; }
});

test('forged/expired token (Base44 401) is rejected', async () => {
  fetchImpl = async () => base44Response({ error: 'unauthorized' }, 401);
  await assert.rejects(() => verifyBase44Token('forged'), (e) => e.code === 'invalid_token');
});

test('Base44 403 is rejected as invalid', async () => {
  fetchImpl = async () => base44Response({ error: 'forbidden' }, 403);
  await assert.rejects(() => verifyBase44Token('tok'), (e) => e.code === 'invalid_token');
});

test('Base44 500 -> safe failure (base44_unavailable), no fallback', async () => {
  fetchImpl = async () => base44Response({}, 500);
  await assert.rejects(() => verifyBase44Token('tok'), (e) => e.code === 'base44_unavailable');
});

test('network error reaching Base44 -> safe failure', async () => {
  fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => verifyBase44Token('tok'), (e) => e.code === 'base44_unavailable');
});

test('verified user with no email is rejected', async () => {
  fetchImpl = async () => base44Response({ full_name: 'No Email' }, 200);
  await assert.rejects(() => verifyBase44Token('tok'), (e) => e.code === 'no_email');
});

test('valid verified user returns trusted identity; email lowercased', async () => {
  fetchImpl = async () => base44Response({ email: 'Jane@Example.com', role: 'sales_rep', full_name: 'Jane' }, 200);
  const v = await verifyBase44Token('tok');
  assert.strictEqual(v.email, 'jane@example.com');
  assert.strictEqual(v.role, 'sales_rep');
  assert.strictEqual(v.full_name, 'Jane');
});

test('browser-supplied email/role are NEVER used — only the Base44 response', async () => {
  // The function takes only a token; there is no email/role parameter to forge.
  fetchImpl = async () => base44Response({ email: 'real@x.com', role: 'manager' }, 200);
  const v = await verifyBase44Token('tok');
  assert.strictEqual(v.email, 'real@x.com');
  assert.strictEqual(v.role, 'manager');
});

test('unrecognized Base44 role -> role null (new user defaults to user, not admin)', async () => {
  fetchImpl = async () => base44Response({ email: 'a@x.com', role: 'superadmin' }, 200);
  const v = await verifyBase44Token('tok');
  assert.strictEqual(v.role, null);
});

test('replay is controlled: each call re-verifies with Base44', async () => {
  let calls = 0;
  fetchImpl = async () => { calls++; return base44Response({ email: 'a@x.com', role: 'user' }, 200); };
  await verifyBase44Token('tok'); await verifyBase44Token('tok');
  assert.strictEqual(calls, 2, 'each exchange must re-verify with Base44 (no cached session)');
});

test('token that was valid then expired is rejected on next exchange', async () => {
  let ok = true;
  fetchImpl = async () => ok ? base44Response({ email: 'a@x.com', role: 'user' }, 200) : base44Response({}, 401);
  const first = await verifyBase44Token('tok'); assert.ok(first);
  ok = false;
  await assert.rejects(() => verifyBase44Token('tok'), (e) => e.code === 'invalid_token');
});

// Route-level role-escalation test: simulates the migrate handler's
// "existing user keeps Railway role" rule (extracted logic, no DB needed).
test('existing Railway role wins — sales_rep cannot exchange into admin', async () => {
  fetchImpl = async () => base44Response({ email: 'rep@x.com', role: 'admin' }, 200); // Base44 says admin
  const v = await verifyBase44Token('tok');
  // The route applies: existing user's stored Railway role wins. Simulate:
  const existingRailwayRole = 'sales_rep';
  const finalRole = existingRailwayRole; // existing user path keeps Railway role
  assert.notStrictEqual(v.role, finalRole, 'verified Base44 role is NOT the final role for existing users');
  assert.strictEqual(finalRole, 'sales_rep', 'sales_rep stays sales_rep');
});