/* eslint-disable no-undef */
/**
 * gmailReadRoutes.test.js — Railway Gmail READ routes.
 *
 * Verifies:
 *   - routes require auth (401 without a token)
 *   - profile/messages/:id return 200 with a valid token
 *   - NO Gmail access/refresh token, client id, or client secret appears in
 *     any response body
 *   - no send capability is exposed (only GET routes)
 *   - Gmail token is obtained server-side (gmailSender.refreshAccessToken)
 *
 * Run: cd src/proxy-server && node --test test/gmailReadRoutes.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// Mock rbac.requireAuth to accept a synthetic token and set req.user.
const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = { id: rbacPath, filename: rbacPath, loaded: true, exports: {
  requireAuth: (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer valid')) return res.status(401).json({ error: 'unauthorized' });
    req.user = { sub: 'u1', email: 'a@x.com', role: 'admin' };
    next();
  },
} };

// Mock gmailSender so no real Gmail call and no token leakage.
let refreshCalled = 0;
const gmailPath = require.resolve('../lib/gmailSender');
delete require.cache[gmailPath];
require.cache[gmailPath] = { id: gmailPath, filename: gmailPath, loaded: true, exports: {
  refreshAccessToken: async () => { refreshCalled++; return 'fake-access-token'; },
  GmailCredentialsError: class extends Error {},
} };

// Mock global fetch for Gmail API calls (messages list + get + profile).
let gmailFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
global.fetch = (...a) => gmailFetchImpl(...a);

const gmailRouter = require('../routes/gmail');

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/gmail', gmailRouter);
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

test('profile: 401 without auth token', async () => {
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/gmail/profile');
    assert.strictEqual(r.status, 401);
  } finally { s.close(); }
});

test('profile: 200 with valid token, no secrets in body', async () => {
  gmailFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ emailAddress: 'yaron@ecconstructiongroup.com', messagesTotal: 5, historyId: 'h1' }) });
  refreshCalled = 0;
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/gmail/profile', { Authorization: 'Bearer valid' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.emailAddress, 'yaron@ecconstructiongroup.com');
    assert.strictEqual(r.body.access_token, undefined);
    assert.strictEqual(r.body.refresh_token, undefined);
    assert.strictEqual(r.body.client_id, undefined);
    assert.strictEqual(r.body.client_secret, undefined);
    assert.ok(refreshCalled > 0, 'server-side token refresh occurred');
  } finally { s.close(); }
});

test('messages: returns list, no secrets in body', async () => {
  gmailFetchImpl = async (url) => {
    if (String(url).includes('/messages?') || String(url).includes('/messages&')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1', threadId: 't1' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'm1', threadId: 't1', snippet: 'hi', payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'Test' }] } }) };
  };
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/gmail/messages?maxResults=5', { Authorization: 'Bearer valid' });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.messages));
    assert.strictEqual(r.body.access_token, undefined);
    assert.strictEqual(r.body.refresh_token, undefined);
  } finally { s.close(); }
});

test('messages/:id: returns one message, no secrets', async () => {
  gmailFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 'm1', threadId: 't1', snippet: 'hi', payload: { headers: [{ name: 'From', value: 'a@b.com' }] } }) });
  const s = await startServer();
  try {
    const r = await get(s, '/api/v1/gmail/messages/m1', { Authorization: 'Bearer valid' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.id, 'm1');
    assert.strictEqual(r.body.access_token, undefined);
  } finally { s.close(); }
});

test('router exposes only GET (read-only, no send capability)', () => {
  // routes/gmail.js defines GET /profile, GET /messages, GET /messages/:id only.
  const src = require('fs').readFileSync(require.resolve('../routes/gmail'), 'utf8');
  assert.ok(/router\.get\('\/profile'/.test(src));
  assert.ok(/router\.get\('\/messages'/.test(src));
  assert.ok(/router\.get\('\/messages\/:id'/.test(src));
  assert.ok(!/router\.post\(/.test(src), 'no POST/send routes');
  assert.ok(!/messages\/send/.test(src), 'no Gmail send path');
});