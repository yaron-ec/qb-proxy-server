/* eslint-disable no-undef */
/**
 * adminAuthGuard.test.js — regression tests for the break-glass admin
 * endpoints' auth guard in routes/auth.js (admin-set-password,
 * admin-list-users, admin-clear-password, admin-set-role).
 *
 * Original finding (architecture review): each endpoint independently
 * checked `provided !== (process.env.ADMIN_AUTH_SECRET || PROXY_SECRET)`
 * — non-constant-time, and accepted PROXY_SECRET (shared across ~60
 * unrelated server-to-server QB-proxy routes). Anyone holding PROXY_SECRET
 * could mint admin credentials for any email.
 *
 * First fix: one shared requireAdminSecret() guard requiring a DEDICATED
 * ADMIN_AUTH_SECRET (no PROXY_SECRET fallback), constant-time compare,
 * disabled (503) if unset.
 *
 * Second fix (this file now also covers it): disabling the endpoints
 * outright when ADMIN_AUTH_SECRET is unset risked leaving a real admin
 * (Yaron Drilevich / Michelle Roitman Drilevich) unable to reset a lost
 * password if they ever needed to and the secret had never been
 * configured in Railway. requireAdminSecret() now accepts EITHER:
 *   (a) a valid Railway JWT for a user with role='admin' — the normal
 *       path whenever an admin can already log in, independent of
 *       whether ADMIN_AUTH_SECRET is configured at all, or
 *   (b) the dedicated ADMIN_AUTH_SECRET — true break-glass recovery when
 *       no admin session exists.
 * PROXY_SECRET is still never accepted by either path.
 *
 * These tests exercise requireAdminSecret()/safeSecretEquals() directly
 * (exported as routes/auth.js's module.exports._testables) against a
 * mocked req/res, without needing a live DB or HTTP server — the guard
 * runs entirely before any database access.
 *
 * RAILWAY_JWT_SECRET must be set BEFORE the first require of
 * lib/crypto.js (it reads the env var into a module-level const at load
 * time) — set here, at the top of the file, before any test function
 * (which lazily requires ../routes/auth) runs.
 */
'use strict';

process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'test-only-jwt-secret-at-least-32-chars-long';

const assert = require('assert');
const { signJWT } = require('../lib/crypto');

function adminJwt(overrides) {
  return signJWT({ sub: 'user-1', email: 'yaron@ecconstructiongroup.com', role: 'admin', full_name: 'Yaron Drilevich', ...overrides }, 900);
}

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

function testSecretPathUnavailableWhenUnsetButNotAJwtTrap() {
  // With no admin JWT AND no ADMIN_AUTH_SECRET configured, the secret path
  // is simply unavailable (401) — NOT a special "disabled" 503. This is
  // deliberately just "unauthorized", because path 1 (admin JWT) remains
  // fully independent of this env var — an already-logged-in admin is
  // never affected by whether ADMIN_AUTH_SECRET exists (see
  // testAdminJwtWorksRegardlessOfAdminAuthSecret below). There is no
  // scenario where a logged-in Yaron/Michelle gets locked out by this.
  const { requireAdminSecret } = require('../routes/auth')._testables;
  withEnv({ ADMIN_AUTH_SECRET: undefined, PROXY_SECRET: 'some-proxy-secret' }, () => {
    const { req, res } = mockReqRes({ 'x-admin-secret': 'some-proxy-secret' });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'next() must NOT be called with no JWT and no ADMIN_AUTH_SECRET configured');
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, 'unauthorized');
  });
  console.log('  ✓ with no admin JWT and ADMIN_AUTH_SECRET unset, the secret path is unavailable (401, not a special 503 trap)');
}

function testAdminJwtWorksRegardlessOfAdminAuthSecret() {
  // The critical "don't break admin recovery" guarantee: a real admin JWT
  // (Yaron/Michelle already logged in via Google SSO or password) works
  // identically whether or not ADMIN_AUTH_SECRET is configured at all.
  const { requireAdminSecret } = require('../routes/auth')._testables;
  const token = adminJwt();
  withEnv({ ADMIN_AUTH_SECRET: undefined }, () => {
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'A valid admin JWT must work even when ADMIN_AUTH_SECRET is unset');
    assert.strictEqual(req.user.role, 'admin');
  });
  withEnv({ ADMIN_AUTH_SECRET: 'some-configured-secret' }, () => {
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'A valid admin JWT must also work when ADMIN_AUTH_SECRET IS set');
  });
  console.log('  ✓ a valid admin JWT (Yaron/Michelle already logged in) always works, independent of ADMIN_AUTH_SECRET');
}

function testNonAdminJwtDoesNotGrantAccess() {
  const { requireAdminSecret } = require('../routes/auth')._testables;
  const repToken = signJWT({ sub: 'user-2', email: 'rep@ecconstructiongroup.com', role: 'sales_rep' }, 900);
  withEnv({ ADMIN_AUTH_SECRET: undefined }, () => {
    const { req, res } = mockReqRes({ authorization: `Bearer ${repToken}` });
    let nextCalled = false;
    requireAdminSecret(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'A valid but non-admin JWT must NOT grant break-glass admin access');
    assert.strictEqual(res.statusCode, 401);
  });
  console.log('  ✓ a valid sales_rep JWT does not grant admin access');
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
  testAdminJwtWorksRegardlessOfAdminAuthSecret();
  testNonAdminJwtDoesNotGrantAccess();
  testSecretPathUnavailableWhenUnsetButNotAJwtTrap();
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
