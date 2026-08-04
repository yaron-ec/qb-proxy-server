/* eslint-disable no-undef */
/**
 * gmailOAuth.test.js — automated tests for the Gmail OAuth connection flow.
 *
 * Covers:
 *   1.  Start route rejects unauthorized access.
 *   2.  Start route creates a valid short-lived state.
 *   3.  Callback rejects missing state.
 *   4.  Callback rejects invalid state.
 *   5.  Callback rejects expired state.
 *   6.  Callback rejects reused state.
 *   7.  Callback rejects a Google account other than yaron@ecconstructiongroup.com.
 *   8.  Callback rejects an unverified email.
 *   9.  Callback rejects a token response without refresh_token.
 *   10. Successful callback stores the credential using gmailCredentialStore.
 *   11. Successful callback does not expose any token or secret.
 *   12. Status endpoint never returns credentials.
 *   13. No Gmail send function is called anywhere in this OAuth phase.
 *
 * Run: npm run gmail:oauth:test
 */
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

// ── Test env vars (must be set before requiring the router) ──────────────────
process.env.GMAIL_CLIENT_ID = 'test-client-id';
process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';
process.env.GMAIL_OAUTH_REDIRECT_URI = 'http://localhost:0/internal/gmail/oauth/callback';
process.env.PROXY_SECRET = 'test-proxy-secret-32-chars-min-length!!';

const { createGmailOAuthRouter } = require('../lib/gmailOAuthRouter');

const EXPECTED_EMAIL = 'yaron@ecconstructiongroup.com';

// ── Mock database ─────────────────────────────────────────────────────────────
function createMockDb() {
  const states = new Map(); // state_hash -> { expected_email, expires_at, used_at }
  return {
    query: async (sql, params) => {
      // INSERT state
      if (/INSERT INTO gmail_oauth_states/.test(sql)) {
        const [hash, email, expiresAt] = params;
        states.set(hash, { expected_email: email, expires_at: new Date(expiresAt), used_at: null });
        return { rows: [] };
      }
      // Atomic claim: UPDATE ... SET used_at = NOW() WHERE ... RETURNING
      if (/UPDATE gmail_oauth_states\s+SET used_at/.test(sql)) {
        const hash = params[0];
        const row = states.get(hash);
        if (!row) return { rows: [] };
        if (row.used_at) return { rows: [] };
        if (new Date(row.expires_at) <= new Date()) return { rows: [] };
        row.used_at = new Date();
        return { rows: [{ id: 'test-id', expected_email: row.expected_email }] };
      }
      // SELECT for error diagnosis
      if (/SELECT used_at, expires_at FROM gmail_oauth_states/.test(sql)) {
        const hash = params[0];
        const row = states.get(hash);
        if (!row) return { rows: [] };
        return { rows: [{ used_at: row.used_at, expires_at: row.expires_at }] };
      }
      return { rows: [] };
    },
    _states: states,
  };
}

// ── Mock credential store ────────────────────────────────────────────────────
function createMockCredStore() {
  let savedCredential = null;
  return {
    saveGmailCredential: async (env, tokens) => {
      savedCredential = { env, tokens: { ...tokens } };
      return 'postgres';
    },
    loadGmailCredential: async () => {
      if (savedCredential) {
        return { refresh_token: savedCredential.tokens.refresh_token, account_identifier: EXPECTED_EMAIL };
      }
      return null;
    },
    _getSaved: () => savedCredential,
    _reset: () => { savedCredential = null; },
  };
}

// ── Mock fetch ────────────────────────────────────────────────────────────────
function createMockFetch(opts) {
  opts = opts || {};
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), method: init && init.method });
    // Token endpoint
    if (String(url).includes('oauth2.googleapis.com/token')) {
      if (opts.tokenError) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: opts.tokenError, error_description: 'test desc' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: opts.accessToken || 'test-access-token',
          refresh_token: opts.refreshToken === undefined ? 'test-refresh-token' : opts.refreshToken,
          expires_in: 3600,
          id_token: opts.idToken || createMockIdToken(opts.idEmail || EXPECTED_EMAIL, opts.idVerified !== false),
        }),
      };
    }
    // Userinfo endpoint
    if (String(url).includes('openidconnect.googleapis.com/v1/userinfo')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          email: opts.userinfoEmail || opts.idEmail || EXPECTED_EMAIL,
          email_verified: opts.userinfoVerified !== false,
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
  mockFetch._calls = calls;
  return mockFetch;
}

function createMockIdToken(email, verified) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, email_verified: verified })).toString('base64url');
  return `${header}.${payload}.fake-signature`;
}

// ── HTTP server helper ───────────────────────────────────────────────────────
async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function buildApp(deps) {
  const instance = createGmailOAuthRouter(deps);
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/internal/gmail/oauth', instance.router);
  return { app, instance };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gmail OAuth Router', () => {

  test('1. Start route rejects unauthorized access', async () => {
    const { app } = buildApp({ db: createMockDb(), credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/start`);
      assert.strictEqual(res.status, 401);
    });
  });

  test('2. Start route creates a valid short-lived state and redirects to Google', async () => {
    const db = createMockDb();
    const { app } = buildApp({ db, credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/start`, {
        headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET },
        redirect: 'manual',
      });
      assert.strictEqual(res.status, 302);
      const location = res.headers.get('location');
      assert.ok(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), 'redirects to Google');
      const params = new URL(location).searchParams;
      assert.strictEqual(params.get('client_id'), 'test-client-id');
      assert.strictEqual(params.get('response_type'), 'code');
      assert.strictEqual(params.get('access_type'), 'offline');
      assert.strictEqual(params.get('prompt'), 'consent');
      assert.strictEqual(params.get('login_hint'), EXPECTED_EMAIL);
      assert.ok(params.get('scope').includes('gmail.send'));
      assert.ok(params.get('state'), 'state is present');
      // State should be stored as a hash in the DB
      assert.strictEqual(db._states.size, 1, 'one state record created');
    });
  });

  test('3. Callback rejects missing state', async () => {
    const { app } = buildApp({ db: createMockDb(), credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code`);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.ok(body.includes('Missing authorization code or state'), body);
    });
  });

  test('4. Callback rejects invalid state', async () => {
    const { app } = buildApp({ db: createMockDb(), credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=invalid-state-hash`);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.ok(body.includes('Invalid or expired'), body);
    });
  });

  test('5. Callback rejects expired state', async () => {
    const db = createMockDb();
    // Manually insert an expired state
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() - 60000), // expired 1 min ago
      used_at: null,
    });
    const { app } = buildApp({ db, credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.ok(body.includes('Invalid or expired'), body);
    });
  });

  test('6. Callback rejects reused state', async () => {
    const db = createMockDb();
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() + 60000),
      used_at: new Date(), // already used
    });
    const { app } = buildApp({ db, credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.ok(body.includes('Invalid or expired'), body);
    });
  });

  test('7. Callback rejects a Google account other than yaron@ecconstructiongroup.com', async () => {
    const db = createMockDb();
    const credStore = createMockCredStore();
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() + 60000),
      used_at: null,
    });
    const mockFetch = createMockFetch({ idEmail: 'wrong@gmail.com', idVerified: true });
    const { app } = buildApp({ db, credStore, fetch: mockFetch });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.ok(body.includes('does not match'), body);
      assert.ok(!credStore._getSaved(), 'no credential stored');
    });
  });

  test('8. Callback rejects an unverified email', async () => {
    const db = createMockDb();
    const credStore = createMockCredStore();
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() + 60000),
      used_at: null,
    });
    const mockFetch = createMockFetch({ idEmail: EXPECTED_EMAIL, idVerified: false });
    const { app } = buildApp({ db, credStore, fetch: mockFetch });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.ok(body.includes('not verified'), body);
      assert.ok(!credStore._getSaved(), 'no credential stored');
    });
  });

  test('9. Callback rejects a token response without refresh_token', async () => {
    const db = createMockDb();
    const credStore = createMockCredStore();
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() + 60000),
      used_at: null,
    });
    const mockFetch = createMockFetch({ refreshToken: null });
    const { app } = buildApp({ db, credStore, fetch: mockFetch });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.ok(body.includes('No refresh token'), body);
      assert.ok(!credStore._getSaved(), 'no credential stored');
    });
  });

  test('10. Successful callback stores the credential using gmailCredentialStore', async () => {
    const db = createMockDb();
    const credStore = createMockCredStore();
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() + 60000),
      used_at: null,
    });
    const mockFetch = createMockFetch({});
    const { app } = buildApp({ db, credStore, fetch: mockFetch });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('Gmail connected successfully'), body);
      const saved = credStore._getSaved();
      assert.ok(saved, 'credential was stored');
      assert.strictEqual(saved.tokens.client_id, 'test-client-id');
      assert.strictEqual(saved.tokens.refresh_token, 'test-refresh-token');
      assert.strictEqual(saved.tokens.account_identifier, EXPECTED_EMAIL);
      // State should be marked as used
      assert.ok(db._states.get(hash).used_at, 'state is marked used');
    });
  });

  test('11. Successful callback does not expose any token or secret', async () => {
    const db = createMockDb();
    const credStore = createMockCredStore();
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() + 60000),
      used_at: null,
    });
    const mockFetch = createMockFetch({});
    const { app } = buildApp({ db, credStore, fetch: mockFetch });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      const body = await res.text();
      // Must NOT contain any token/secret values
      assert.ok(!body.includes('test-refresh-token'), 'no refresh token in response');
      assert.ok(!body.includes('test-access-token'), 'no access token in response');
      assert.ok(!body.includes('test-client-secret'), 'no client secret in response');
      assert.ok(!body.includes('test-code'), 'no authorization code in response');
      assert.ok(!body.includes(rawState), 'no raw state in response');
    });
  });

  test('12. Status endpoint never returns credentials', async () => {
    const credStore = createMockCredStore();
    // Simulate a stored credential
    await credStore.saveGmailCredential('production', {
      client_id: 'secret-id',
      client_secret: 'secret-secret',
      refresh_token: 'secret-refresh',
      account_identifier: EXPECTED_EMAIL,
    });
    const { app } = buildApp({ db: createMockDb(), credStore, fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/status`, {
        headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.connected, true);
      assert.strictEqual(data.account, EXPECTED_EMAIL);
      assert.strictEqual(data.status, 'connected');
      // Must not contain any token/secret
      const body = JSON.stringify(data);
      assert.ok(!body.includes('secret-id'), 'no client_id');
      assert.ok(!body.includes('secret-secret'), 'no client_secret');
      assert.ok(!body.includes('secret-refresh'), 'no refresh_token');
    });
  });

  test('12b. Status endpoint returns connected=false when no credential exists', async () => {
    const credStore = createMockCredStore();
    const { app } = buildApp({ db: createMockDb(), credStore, fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/status`, {
        headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.connected, false);
    });
  });

  test('13. No Gmail send function is called anywhere in this OAuth phase', async () => {
    const db = createMockDb();
    const credStore = createMockCredStore();
    const rawState = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawState).digest('hex');
    db._states.set(hash, {
      expected_email: EXPECTED_EMAIL,
      expires_at: new Date(Date.now() + 60000),
      used_at: null,
    });
    const mockFetch = createMockFetch({});
    const { app } = buildApp({ db, credStore, fetch: mockFetch });
    await withServer(app, async (base) => {
      // Run the full start + callback flow
      await fetch(`${base}/internal/gmail/oauth/start`, {
        headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET },
        redirect: 'manual',
      });
      await fetch(`${base}/internal/gmail/oauth/callback?code=test-code&state=${rawState}`);
      await fetch(`${base}/internal/gmail/oauth/status`, {
        headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET },
      });
      // Verify no fetch call hit the Gmail API send endpoint
      const gmailSendCalls = mockFetch._calls.filter((c) =>
        c.url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')
      );
      assert.strictEqual(gmailSendCalls.length, 0, 'no Gmail send API call was made');
      // All fetch calls should be to Google OAuth endpoints only
      for (const c of mockFetch._calls) {
        assert.ok(
          c.url.includes('oauth2.googleapis.com/token') || c.url.includes('openidconnect.googleapis.com'),
          `unexpected fetch to: ${c.url}`
        );
      }
    });
  });

  test('Setup token flow: issue via X-Proxy-Secret, use via query param', async () => {
    const db = createMockDb();
    const { app, instance } = buildApp({ db, credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      // Issue a setup token
      const issueRes = await fetch(`${base}/internal/gmail/oauth/start?issue_setup_token=true`, {
        headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET },
      });
      assert.strictEqual(issueRes.status, 200);
      const issueData = await issueRes.json();
      assert.ok(issueData.setup_token, 'setup_token returned');
      // Use the setup token to start the flow
      const startRes = await fetch(`${base}/internal/gmail/oauth/start?setup_token=${issueData.setup_token}`, {
        redirect: 'manual',
      });
      assert.strictEqual(startRes.status, 302);
      assert.ok(db._states.size >= 1, 'state created via setup_token');
    });
  });

  test('Setup token cannot issue another setup token', async () => {
    const { app } = buildApp({ db: createMockDb(), credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const issueRes = await fetch(`${base}/internal/gmail/oauth/start?issue_setup_token=true`, {
        headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET },
      });
      const { setup_token } = await issueRes.json();
      const res = await fetch(`${base}/internal/gmail/oauth/start?setup_token=${setup_token}&issue_setup_token=true`);
      assert.strictEqual(res.status, 403);
    });
  });

  test('Status endpoint rejects unauthorized access', async () => {
    const { app } = buildApp({ db: createMockDb(), credStore: createMockCredStore(), fetch: createMockFetch() });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/internal/gmail/oauth/status`);
      assert.strictEqual(res.status, 401);
    });
  });

});