/* eslint-disable no-undef */
/**
 * adminAuthGuard.test.js — regression tests for the break-glass admin
 * endpoints' auth guard in routes/auth.js (admin-set-password,
 * admin-list-users, admin-clear-password, admin-set-role).
 *
 * Prior behavior (security finding from the architecture review): each
 * endpoint independently checked
 *   `provided !== (process.env.ADMIN_AUTH_SECRET || process.env.PROXY_SECRET)`
 * — a non-constant-time comparison that ALSO accepted PROXY_SECRET, a
 * secret shared across ~60 unrelated server-to-server QB-proxy routes.
 * Anyone/anything holding PROXY_SECRET could mint admin credentials for
 * any email via /admin-set-password or /admin-set-role.
 *
 * Fixed behavior: a single shared requireAdminSecret() guard that (a)
 * requires a DEDICATED ADMIN_AUTH_SECRET (no PROXY_SECRET fallback), (b)
 * disables the endpoints entirely (503) if ADMIN_AUTH_SECRET is unset
 * rather than silently falling back to a weaker secret, and (c) compares
 * secrets in constant time via crypto.timingSafeEqual.
 *
 * These tests exercise requireAdminSecret()/safeSecretEquals() directly
 * (exported as routes/auth.js's module.exports._testables) against a
 * mocked req/res, without needing a live DB or HTTP server — the guard
 * runs entirely before any database access.
 */
'use strict';

const assert = require('assert');

function mockReqRes(headers) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const req = { headers: headers || {} };
  return { req, res };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; }
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function testDisabledWhenAdminSecretUnset() {
  const { requireAdminSecret } = require('../routes/auth')._testables;
  withEnv({ ADMIN_AUTH_SECRET: undefined, PROXY_SECRET: 'some-proxy-secret' }, () => {
    const { req, res } = mockReqRes({ 'x-admin-secret': 'some-proxy-secret' });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'next() must NOT be called when ADMIN_AUTH_SECRET is unset');
    assert.strictEqual(res.statusCode, 503, 'Should respond 503 when break-glass admin is not configured');
    assert.strictEqual(res.body.error, 'admin_bootstrap_disabled');
  });
  console.log('  ✓ break-glass admin endpoints are disabled (503) when ADMIN_AUTH_SECRET is not set');
}

function testProxySecretAloneNoLongerWorks() {
  const { requireAdminSecret } = require('../routes/auth')._testables;
  withEnv({ ADMIN_AUTH_SECRET: 'the-real-admin-secret', PROXY_SECRET: 'the-proxy-secret' }, () => {
    const { req, res } = mockReqRes({ 'x-admin-secret': 'the-proxy-secret' });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'PROXY_SECRET must be rejected — it is not ADMIN_AUTH_SECRET');
    assert.strictEqual(res.statusCode, 401);
  });
  console.log('  ✓ PROXY_SECRET alone is rejected — dedicated ADMIN_AUTH_SECRET is required (regression guard)');
}

function testCorrectAdminSecretPasses() {
  const { requireAdminSecret } = require('../routes/auth')._testables;
  withEnv({ ADMIN_AUTH_SECRET: 'the-real-admin-secret', PROXY_SECRET: 'the-proxy-secret' }, () => {
    const { req, res } = mockReqRes({ 'x-admin-secret': 'the-real-admin-secret' });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'Correct ADMIN_AUTH_SECRET must be accepted');
    assert.strictEqual(res.statusCode, null, 'No error response should be set on success');
  });
  console.log('  ✓ correct ADMIN_AUTH_SECRET is accepted');
}

function testWrongSecretRejected() {
  const { requireAdminSecret } = require('../routes/auth')._testables;
  withEnv({ ADMIN_AUTH_SECRET: 'the-real-admin-secret', PROXY_SECRET: undefined }, () => {
    const { req, res } = mockReqRes({ 'x-admin-secret': 'guessed-wrong' });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
  });
  console.log('  ✓ wrong secret is rejected');
}

function testMissingHeaderRejected() {
  const { requireAdminSecret } = require('../routes/auth')._testables;
  withEnv({ ADMIN_AUTH_SECRET: 'the-real-admin-secret' }, () => {
    const { req, res } = mockReqRes({});
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
  });
  console.log('  ✓ missing X-Admin-Secret header is rejected');
}

function testSafeSecretEqualsIsLengthSafe() {
  const { safeSecretEquals } = require('../routes/auth')._testables;
  // Different lengths must not throw (crypto.timingSafeEqual throws on
  // mismatched buffer lengths if not guarded) and must return false.
  assert.strictEqual(safeSecretEquals('short', 'a-much-longer-secret-value'), false);
  assert.strictEqual(safeSecretEquals('same-value', 'same-value'), true);
  assert.strictEqual(safeSecretEquals('same-value', 'different'), false);
  console.log('  ✓ safeSecretEquals handles mismatched lengths without throwing, matches correctly');
}

async function runAll() {
  console.log('Admin Auth Guard Tests:\n');
  testDisabledWhenAdminSecretUnset();
  testProxySecretAloneNoLongerWorks();
  testCorrectAdminSecretPasses();
  testWrongSecretRejected();
  testMissingHeaderRejected();
  testSafeSecretEqualsIsLengthSafe();
  console.log('\n✅ All admin auth guard tests passed');
}

runAll().catch(e => {
  console.error('❌ Test failed:', e.message);
  process.exit(1);
});
