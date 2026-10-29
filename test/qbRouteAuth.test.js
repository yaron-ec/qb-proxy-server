/* eslint-disable no-undef */
'use strict';

/**
 * qbRouteAuth.test.js — lib/qbRouteAuth.js#requireProxySecretOrRole, the
 * admin/manager-restricted variant of server.js's requireProxySecret added
 * during the October 2026 QuickBooks reliability audit.
 *
 * Finding: requireProxySecret accepts EITHER the server-to-server
 * X-Proxy-Secret header OR any valid Railway JWT, with no role check at
 * all on the JWT path — so a sales_rep's own JWT could reach QuickBooks
 * OAuth connect/disconnect or invoice/estimate/customer creation directly,
 * bypassing the role checks routes/leadQB.js and routes/dealQbSync.js
 * already enforce for their own (indirect, proxy-secret) callers.
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

delete require.cache[require.resolve('../lib/qbRouteAuth')];
const { requireProxySecretOrRole } = require('../lib/qbRouteAuth');

function fakeReqRes({ headers = {} } = {}) {
  const req = { headers };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

test.beforeEach(() => { delete process.env.PROXY_SECRET; });

test('X-Proxy-Secret matching PROXY_SECRET is allowed through unconditionally, regardless of roles requested', async () => {
  process.env.PROXY_SECRET = 's3cr3t';
  const mw = requireProxySecretOrRole('admin');
  const { req, res } = fakeReqRes({ headers: { 'x-proxy-secret': 's3cr3t' } });
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.strictEqual(called, true);
  assert.strictEqual(res.statusCode, null);
});

test('a wrong X-Proxy-Secret falls through to the JWT path and 401s with no Authorization header', async () => {
  process.env.PROXY_SECRET = 's3cr3t';
  const mw = requireProxySecretOrRole('admin');
  const { req, res } = fakeReqRes({ headers: { 'x-proxy-secret': 'wrong' } });
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(res.statusCode, 401);
});

test('no X-Proxy-Secret and no Authorization header -> 401', async () => {
  const mw = requireProxySecretOrRole('admin', 'manager');
  const { req, res } = fakeReqRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(res.statusCode, 401);
});

test('a valid JWT whose role IS in the allowed list is let through, with req.user set', async () => {
  const restore = stub('../lib/authService', { verifyAccessToken: () => ({ sub: 'u1', email: 'mgr@x.com', role: 'manager' }) });
  try {
    const mw = requireProxySecretOrRole('admin', 'manager');
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer good-token' } });
    let called = false;
    await mw(req, res, () => { called = true; });
    assert.strictEqual(called, true);
    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(req.user.role, 'manager');
  } finally { restore(); }
});

test('a valid JWT whose role is NOT in the allowed list -> 403 forbidden, never next()', async () => {
  const restore = stub('../lib/authService', { verifyAccessToken: () => ({ sub: 'u2', email: 'rep@x.com', role: 'sales_rep' }) });
  try {
    const mw = requireProxySecretOrRole('admin', 'manager');
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer good-token' } });
    let called = false;
    await mw(req, res, () => { called = true; });
    assert.strictEqual(called, false);
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /insufficient role/);
  } finally { restore(); }
});

test('an admin-only route rejects a manager JWT (the OAuth connect/disconnect tier)', async () => {
  const restore = stub('../lib/authService', { verifyAccessToken: () => ({ sub: 'u3', email: 'mgr@x.com', role: 'manager' }) });
  try {
    const mw = requireProxySecretOrRole('admin');
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer good-token' } });
    let called = false;
    await mw(req, res, () => { called = true; });
    assert.strictEqual(called, false);
    assert.strictEqual(res.statusCode, 403);
  } finally { restore(); }
});

test('an invalid/expired JWT -> 401, never 403 (distinguishes "not authenticated" from "not authorized")', async () => {
  const restore = stub('../lib/authService', { verifyAccessToken: () => { throw new Error('jwt expired'); } });
  try {
    const mw = requireProxySecretOrRole('admin', 'manager');
    const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer stale-token' } });
    let called = false;
    await mw(req, res, () => { called = true; });
    assert.strictEqual(called, false);
    assert.strictEqual(res.statusCode, 401);
  } finally { restore(); }
});

test('office and sales_rep roles are both rejected from an admin/manager-only route', async () => {
  for (const role of ['office', 'sales_rep']) {
    const restore = stub('../lib/authService', { verifyAccessToken: () => ({ sub: 'u', email: 'x@x.com', role }) });
    try {
      const mw = requireProxySecretOrRole('admin', 'manager');
      const { req, res } = fakeReqRes({ headers: { authorization: 'Bearer t' } });
      let called = false;
      await mw(req, res, () => { called = true; });
      assert.strictEqual(called, false, `role ${role} should be rejected`);
      assert.strictEqual(res.statusCode, 403);
    } finally { restore(); }
  }
});
