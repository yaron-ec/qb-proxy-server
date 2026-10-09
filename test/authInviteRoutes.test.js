/* eslint-disable no-undef */
'use strict';

/**
 * authInviteRoutes.test.js — route-level coverage for POST /api/v1/auth/invite
 * and POST /api/v1/auth/accept-invite (PRODUCTIZATION — Company Provisioning
 * System, multi-company onboarding workflow). Matches
 * crm-frontend/src/components/UsersTab.jsx's existing, previously-404ing
 * calls to POST /invite. Mocks lib/rbac, lib/authService, lib/emailService
 * and lib/companyConfig in require.cache — no live DB, no real email sent.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'test-only-jwt-secret-at-least-32-chars-long';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

function mockModule(path, exports) {
  const p = require.resolve(path);
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function startServer() {
  delete require.cache[require.resolve('../routes/auth')];
  const authRouter = require('../routes/auth');
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRouter);
    const server = app.listen(0, () => resolve(server));
  });
}

function req(server, method, pathStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ port, path: pathStr, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => {
        let parsed; try { parsed = JSON.parse(out); } catch { parsed = out; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function mockRbac(role) {
  mockModule('../lib/rbac', {
    requireAuth: (req2, res2, next) => {
      const auth = req2.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return res2.status(401).json({ error: 'unauthorized' });
      req2.user = { sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: auth.replace('Bearer ', '') };
      next();
    },
    requireRole: (...roles) => (req2, res2, next) => {
      if (!req2.user) return res2.status(401).json({ error: 'not authenticated' });
      if (!roles.includes(req2.user.role)) return res2.status(403).json({ error: 'forbidden: insufficient role' });
      next();
    },
  });
}

test('POST /invite: 401 with no auth', async () => {
  mockRbac();
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/auth/invite', { body: { email: 'new@acme.example' } });
    assert.strictEqual(r.status, 401);
  } finally { s.close(); }
});

test('POST /invite: 403 for a non-admin', async () => {
  mockRbac();
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/auth/invite', { headers: { Authorization: 'Bearer sales_rep' }, body: { email: 'new@acme.example' } });
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('POST /invite: 400 on missing email, 400 on invalid role', async () => {
  mockRbac();
  const s = await startServer();
  try {
    const r1 = await req(s, 'POST', '/api/v1/auth/invite', { headers: { Authorization: 'Bearer admin' }, body: {} });
    assert.strictEqual(r1.status, 400);
    const r2 = await req(s, 'POST', '/api/v1/auth/invite', { headers: { Authorization: 'Bearer admin' }, body: { email: 'new@acme.example', role: 'superuser' } });
    assert.strictEqual(r2.status, 400);
  } finally { s.close(); }
});

test('POST /invite: creates a pending user and returns 201, never includes a password anywhere in the response', async () => {
  mockRbac();
  let created = null;
  mockModule('../lib/authService', {
    createPendingUser: async ({ email, full_name, role }) => {
      created = { email, full_name, role };
      return { user: { id: 'u2', email, full_name, role }, rawToken: 'raw-token-abc', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
    },
    INVITE_TTL_DAYS: 7,
  });
  mockModule('../lib/companyConfig', { getCompanyConfig: async () => ({ company_name: 'Acme Remodeling' }) });
  mockModule('../lib/emailTemplates', { inviteEmail: () => '<html>invite</html>' });
  let sentArgs = null;
  mockModule('../lib/emailService', { send: async (args) => { sentArgs = args; return { ok: true }; } });

  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/auth/invite', { headers: { Authorization: 'Bearer admin' }, body: { email: 'new@acme.example', role: 'sales_rep', full_name: 'New Rep' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.status, 'pending');
    assert.strictEqual(r.body.email_sent, true);
    assert.strictEqual(r.body.invite_url, undefined, 'the raw link must not be echoed back once the email send itself succeeded');
    assert.strictEqual(JSON.stringify(r.body).includes('raw-token-abc'), false, 'the raw invite token must never leak into the HTTP response when email sending succeeded');
    assert.strictEqual(created.email, 'new@acme.example');
    assert.strictEqual(created.role, 'sales_rep');
    assert.ok(sentArgs.to === 'new@acme.example');
  } finally { s.close(); }
});

test('POST /invite: 409 when the email already has an active account', async () => {
  mockRbac();
  mockModule('../lib/authService', {
    createPendingUser: async () => { throw Object.assign(new Error('a user with this email already has an active account'), { code: 'already_active' }); },
    INVITE_TTL_DAYS: 7,
  });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/auth/invite', { headers: { Authorization: 'Bearer admin' }, body: { email: 'existing@acme.example' } });
    assert.strictEqual(r.status, 409);
  } finally { s.close(); }
});

test('POST /invite: when email sending fails, returns invite_url as a fallback so the admin can relay the link manually', async () => {
  mockRbac();
  mockModule('../lib/authService', {
    createPendingUser: async ({ email }) => ({ user: { id: 'u3', email }, rawToken: 'raw-token-xyz', expiresAt: new Date().toISOString() }),
    INVITE_TTL_DAYS: 7,
  });
  mockModule('../lib/companyConfig', { getCompanyConfig: async () => ({ company_name: 'Acme Remodeling' }) });
  mockModule('../lib/emailTemplates', { inviteEmail: () => '<html>invite</html>' });
  mockModule('../lib/emailService', { send: async () => { throw new Error('gmail not connected'); } });

  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/auth/invite', { headers: { Authorization: 'Bearer admin' }, body: { email: 'new2@acme.example' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.email_sent, false);
    assert.ok(r.body.invite_url && r.body.invite_url.includes('raw-token-xyz'));
  } finally { s.close(); }
});

test('POST /accept-invite: 400 on missing token/password, 400 on a too-short password', async () => {
  mockRbac();
  const s = await startServer();
  try {
    const r1 = await req(s, 'POST', '/api/v1/auth/accept-invite', { body: {} });
    assert.strictEqual(r1.status, 400);
    const r2 = await req(s, 'POST', '/api/v1/auth/accept-invite', { body: { token: 't', password: 'short' } });
    assert.strictEqual(r2.status, 400);
  } finally { s.close(); }
});

test('POST /accept-invite: invalid/expired token returns 400 invalid_or_expired_token', async () => {
  mockModule('../lib/authService', { acceptInvite: async () => null, INVITE_TTL_DAYS: 7 });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/auth/accept-invite', { body: { token: 'bad-token', password: 'a-real-password-123' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'invalid_or_expired_token');
  } finally { s.close(); }
});

test('POST /accept-invite: a valid token activates the account and signs them in (same session shape as /login)', async () => {
  mockModule('../lib/authService', {
    acceptInvite: async (token, password) => {
      assert.strictEqual(token, 'good-token');
      assert.strictEqual(password, 'a-real-password-123');
      return { id: 'u4', email: 'owner@acme.example', role: 'admin', full_name: 'Owner', status: 'active' };
    },
    issueSession: async (user) => ({ access: 'access-jwt', refresh: 'refresh-token', user: { id: user.id, email: user.email }, accessTtlSeconds: 900 }),
    INVITE_TTL_DAYS: 7,
  });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/auth/accept-invite', { body: { token: 'good-token', password: 'a-real-password-123' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.access, 'access-jwt');
    assert.strictEqual(r.body.refresh, 'refresh-token');
    assert.strictEqual(r.body.user.email, 'owner@acme.example');
  } finally { s.close(); }
});
