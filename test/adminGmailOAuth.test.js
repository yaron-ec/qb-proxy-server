/* eslint-disable no-undef */
/**
 * adminGmailOAuth.test.js — tests for routes/adminGmailOAuth.js, the
 * ADMIN-AUTHENTICATED (Railway JWT) bridge into the internal
 * (PROXY_SECRET/setup_token-gated) Gmail OAuth flow.
 *
 * Covers:
 *   1. Non-admin (sales_rep) is denied 403 on GET /status.
 *   2. Non-admin (sales_rep) is denied 403 on GET /start-url.
 *   3. No auth at all is denied 401 on both routes.
 *   4. Admin gets a valid /status response (delegates to gmailOAuth.handleStatus
 *      verbatim — same shape, no extra wrapping).
 *   5. Admin gets a /start-url response containing a well-formed, same-origin
 *      `path` with an embedded setup_token query param.
 *   6. /start-url response never contains any token/secret material other than
 *      the intentionally-opaque, short-lived setup_token itself.
 *   7. /start-url returns 503 (not a crash) when Gmail OAuth is not configured
 *      (signSetupToken throws).
 *   8. Integration: a setup_token minted by signSetupToken() on a REAL
 *      createGmailOAuthRouter instance is accepted by that same instance's
 *      own /internal/gmail/oauth/start route (requireInternalAuth) and
 *      produces a 302 redirect to Google — proving the cross-router bridge
 *      routes/adminGmailOAuth.js relies on actually works end-to-end, not
 *      just in isolation with a mocked gmailOAuthRouter.
 *
 * Run: node --test test/adminGmailOAuth.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── Mock lib/rbac (same pattern as test/gmailReadRoutes.test.js) ────────────
const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = {
  id: rbacPath, filename: rbacPath, loaded: true, exports: {
    requireAuth: (req, res, next) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer admin') && !auth.startsWith('Bearer nonadmin')) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      req.user = auth.startsWith('Bearer nonadmin')
        ? { sub: 'u2', email: 'rep@ecconstructiongroup.com', role: 'sales_rep' }
        : { sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
      next();
    },
    requireRole: (...roles) => (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'not authenticated' });
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden: insufficient role' });
      next();
    },
  },
};

// ── Mock lib/gmailOAuthRouter ────────────────────────────────────────────────
let statusResponse = { connected: true, account: 'yaron@ecconstructiongroup.com', environment: 'production', status: 'connected', has_send_access: true, has_read_access: true, scope_recorded: true };
let signSetupTokenImpl = () => 'fake-setup-token-abc123';
const gmailOAuthPath = require.resolve('../lib/gmailOAuthRouter');
delete require.cache[gmailOAuthPath];
require.cache[gmailOAuthPath] = {
  id: gmailOAuthPath, filename: gmailOAuthPath, loaded: true, exports: {
    handleStatus: (req, res) => res.status(200).json(statusResponse),
    signSetupToken: (...a) => signSetupTokenImpl(...a),
  },
};

const adminGmailOAuthRouter = require('../routes/adminGmailOAuth');

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/gmail-oauth', adminGmailOAuthRouter);
    const server = app.listen(0, () => resolve(server));
  });
}

function get(server, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ port, path: pathStr, headers }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => {
        let body; try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    }).on('error', reject);
  });
}

test('status: 401 with no auth token at all', async () => {
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/admin/gmail-oauth/status');
    assert.strictEqual(r.status, 401);
  } finally { s.close(); }
});

test('start-url: 401 with no auth token at all', async () => {
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/admin/gmail-oauth/start-url');
    assert.strictEqual(r.status, 401);
  } finally { s.close(); }
});

test('status: 403 for a non-admin (sales_rep) — this mints an admin-privileged setup token downstream, must never be reachable by a rep', async () => {
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/admin/gmail-oauth/status', { Authorization: 'Bearer nonadmin' });
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('start-url: 403 for a non-admin (sales_rep)', async () => {
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/admin/gmail-oauth/start-url', { Authorization: 'Bearer nonadmin' });
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('status: admin gets the exact response from gmailOAuth.handleStatus, unmodified', async () => {
  statusResponse = { connected: true, account: 'yaron@ecconstructiongroup.com', environment: 'production', status: 'connected', has_send_access: true, has_read_access: false, scope_recorded: true };
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/admin/gmail-oauth/status', { Authorization: 'Bearer admin' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, statusResponse);
    assert.strictEqual(r.body.has_send_access, true);
    assert.strictEqual(r.body.has_read_access, false, 'must truthfully distinguish send-only from read-available');
  } finally { s.close(); }
});

test('start-url: admin gets a same-origin internal path embedding the setup_token, no secret material otherwise', async () => {
  signSetupTokenImpl = () => 'opaque-setup-token-xyz789';
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/admin/gmail-oauth/start-url', { Authorization: 'Bearer admin' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(Object.keys(r.body).length, 1, 'response body must contain nothing but `path`');
    assert.ok(r.body.path.startsWith('/internal/gmail/oauth/start?setup_token='), r.body.path);
    const encoded = r.body.path.split('setup_token=')[1];
    assert.strictEqual(decodeURIComponent(encoded), 'opaque-setup-token-xyz789');
    // No PROXY_SECRET, client_id, client_secret, refresh_token, or access_token anywhere in the body.
    const raw = JSON.stringify(r.body);
    for (const forbidden of ['PROXY_SECRET', 'client_secret', 'refresh_token', 'access_token']) {
      assert.ok(!raw.includes(forbidden), `must not leak ${forbidden}`);
    }
  } finally { s.close(); }
});

test('start-url: 503 (not a crash) when Gmail OAuth is not configured', async () => {
  signSetupTokenImpl = () => { throw new Error('PROXY_SECRET not configured'); };
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/admin/gmail-oauth/start-url', { Authorization: 'Bearer admin' });
    assert.strictEqual(r.status, 503);
    assert.ok(!JSON.stringify(r.body).includes('PROXY_SECRET not configured'), 'must not leak the internal error message');
  } finally { s.close(); }
});

// ── Integration: prove the bridge mechanism itself works end-to-end ─────────
// This does NOT use the mocked lib/gmailOAuthRouter above — it builds a real
// createGmailOAuthRouter() instance (with mocked db/credStore/fetch, no live
// network) and proves that a setup_token minted by ITS OWN signSetupToken()
// is accepted by ITS OWN /start route's requireInternalAuth, exactly as
// production relies on (routes/adminGmailOAuth.js and server.js's
// /internal/gmail/oauth mount both `require('../lib/gmailOAuthRouter')` — the
// SAME cached module instance — so a token minted by one is always honored by
// the other).
test('integration: a setup_token minted by signSetupToken() unlocks the real /internal/gmail/oauth/start route and redirects to Google', async () => {
  process.env.GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'test-client-id';
  process.env.GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'test-client-secret';
  process.env.GMAIL_OAUTH_REDIRECT_URI = process.env.GMAIL_OAUTH_REDIRECT_URI || 'http://localhost:0/internal/gmail/oauth/callback';
  process.env.PROXY_SECRET = process.env.PROXY_SECRET || 'test-proxy-secret-32-chars-min-length!!';

  // Fresh require, uninfluenced by this file's own lib/gmailOAuthRouter mock above.
  delete require.cache[gmailOAuthPath];
  const { createGmailOAuthRouter } = require('../lib/gmailOAuthRouter');
  const mockDb = { query: async () => ({ rows: [] }) };
  const mockCredStore = { loadGmailCredential: async () => null, saveGmailCredential: async () => 'postgres' };
  const instance = createGmailOAuthRouter({ db: mockDb, credStore: mockCredStore, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });

  const app = express();
  app.use('/internal/gmail/oauth', instance.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const port = server.address().port;
    const setupToken = instance.signSetupToken();
    const res = await fetch(`http://localhost:${port}/internal/gmail/oauth/start?setup_token=${encodeURIComponent(setupToken)}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302, 'setup_token must be accepted exactly like X-Proxy-Secret is');
    const location = res.headers.get('location');
    assert.ok(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), 'redirects to Google');
    assert.ok(new URL(location).searchParams.get('scope').includes('gmail.readonly'), 'expanded scope requested via the bridged flow too');
  } finally {
    await new Promise((r) => server.close(r));
    delete require.cache[gmailOAuthPath];
    require.cache[gmailOAuthPath] = {
      id: gmailOAuthPath, filename: gmailOAuthPath, loaded: true, exports: {
        handleStatus: (req, res) => res.status(200).json(statusResponse),
        signSetupToken: (...a) => signSetupTokenImpl(...a),
      },
    };
  }
});
