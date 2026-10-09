/* eslint-disable no-undef */
'use strict';

/**
 * usersPendingStatus.test.js — GET /api/v1/users' new `user_status: 'pending'`
 * mapping (PRODUCTIZATION — Company Provisioning System, multi-company
 * onboarding workflow). A user created via POST /api/v1/auth/invite has no
 * password_hash and no google_sub yet — routes/users.js#mapUser must report
 * that as 'pending' (not 'active'), matching
 * crm-frontend/src/components/UsersTab.jsx's existing STATUS_CONFIG.pending
 * UI, which previously had no backend state to ever actually display.
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

function mockRbacAdmin() {
  mockModule('../lib/rbac', {
    requireAuth: (req, res, next) => { req.user = { sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'admin' }; next(); },
    requireRole: () => (req, res, next) => next(),
  });
}

function mockDbUsers(rows) {
  mockModule('../db/client', {
    query: async (sql) => {
      const s = String(sql);
      if (/FROM users ORDER BY email/i.test(s)) return { rows };
      throw new Error('unexpected query: ' + s);
    },
    ensureColumns: async () => {},
    pool: {},
  });
}

function startServer() {
  delete require.cache[require.resolve('../routes/users')];
  const usersRouter = require('../routes/users');
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/users', usersRouter);
    const server = app.listen(0, () => resolve(server));
  });
}

function req(server, pathStr) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ port, path: pathStr }, (res) => {
      let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => {
        let parsed; try { parsed = JSON.parse(out); } catch { parsed = out; }
        resolve({ status: res.statusCode, body: parsed });
      });
    }).on('error', reject);
  });
}

test('GET /api/v1/users: a password-less, SSO-less, non-disabled user maps to user_status "pending"', async () => {
  mockRbacAdmin();
  mockDbUsers([
    { id: 'u1', email: 'invited@acme.example', full_name: 'Invited Person', role: 'sales_rep', status: 'active', owner_name: null, has_google_sso: false, has_password: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ]);
  const s = await startServer();
  try {
    const r = await req(s, '/api/v1/users');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items[0].user_status, 'pending');
  } finally { s.close(); }
});

test('GET /api/v1/users: a user with a password is "active", regardless of SSO', async () => {
  mockRbacAdmin();
  mockDbUsers([
    { id: 'u2', email: 'active@acme.example', full_name: 'Active Person', role: 'admin', status: 'active', owner_name: null, has_google_sso: false, has_password: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ]);
  const s = await startServer();
  try {
    const r = await req(s, '/api/v1/users');
    assert.strictEqual(r.body.items[0].user_status, 'active');
  } finally { s.close(); }
});

test('GET /api/v1/users: a user with Google SSO linked (no password) is "active", never "pending"', async () => {
  mockRbacAdmin();
  mockDbUsers([
    { id: 'u3', email: 'sso@acme.example', full_name: 'SSO Person', role: 'manager', status: 'active', owner_name: null, has_google_sso: true, has_password: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ]);
  const s = await startServer();
  try {
    const r = await req(s, '/api/v1/users');
    assert.strictEqual(r.body.items[0].user_status, 'active');
  } finally { s.close(); }
});

test('GET /api/v1/users: a disabled user is "deactivated" even if also password-less (disabled always wins over pending)', async () => {
  mockRbacAdmin();
  mockDbUsers([
    { id: 'u4', email: 'disabled@acme.example', full_name: 'Disabled Person', role: 'user', status: 'disabled', owner_name: null, has_google_sso: false, has_password: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ]);
  const s = await startServer();
  try {
    const r = await req(s, '/api/v1/users');
    assert.strictEqual(r.body.items[0].user_status, 'deactivated');
  } finally { s.close(); }
});
