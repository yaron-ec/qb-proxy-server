/* eslint-disable no-undef */
'use strict';

/**
 * rbacPlatformAdmin.test.js — unit coverage for lib/rbac.js#requirePlatformAdmin
 * (PRODUCTIZATION — Company Provisioning System, multi-company onboarding
 * workflow). Deliberately NOT a new `role` and NOT a hardcoded email — it
 * reuses THIS installation's own company_settings.protected_admin_emails via
 * lib/notificationRecipients.js#getProtectedAdminEmails. Mocks that module
 * in require.cache to avoid a live DB.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'test-only-jwt-secret-at-least-32-chars-long';

const test = require('node:test');
const assert = require('node:assert');

function mockReqRes(user) {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const req = { user };
  return { req, res };
}

function loadRbacWithProtectedEmails(emails) {
  const nrPath = require.resolve('../lib/notificationRecipients');
  delete require.cache[nrPath];
  require.cache[nrPath] = {
    id: nrPath, filename: nrPath, loaded: true,
    exports: { getProtectedAdminEmails: async () => new Set(emails.map((e) => e.toLowerCase())) },
  };
  delete require.cache[require.resolve('../lib/rbac')];
  return require('../lib/rbac');
}

// requirePlatformAdmin's email-lookup branch is async (a .then()/.catch()
// chain, not an awaited call) — give it a tick to resolve before asserting.
function run(fn) {
  return new Promise((resolve) => { fn(); setImmediate(() => setImmediate(resolve)); });
}

test('requirePlatformAdmin: 401 when not authenticated at all', async () => {
  const rbac = loadRbacWithProtectedEmails(['yaron@ecconstructiongroup.com']);
  const { req, res } = mockReqRes(null);
  let nextCalled = false;
  await run(() => rbac.requirePlatformAdmin(req, res, () => { nextCalled = true; }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

test('requirePlatformAdmin: 403 for a non-admin role even if email is in the protected list', async () => {
  const rbac = loadRbacWithProtectedEmails(['yaron@ecconstructiongroup.com']);
  const { req, res } = mockReqRes({ sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'sales_rep' });
  let nextCalled = false;
  await run(() => rbac.requirePlatformAdmin(req, res, () => { nextCalled = true; }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('requirePlatformAdmin: 403 for an admin whose email is NOT in protected_admin_emails (e.g. a customer company admin)', async () => {
  const rbac = loadRbacWithProtectedEmails([]); // fresh company installation default
  const { req, res } = mockReqRes({ sub: 'u1', email: 'owner@acme.example', role: 'admin' });
  let nextCalled = false;
  await run(() => rbac.requirePlatformAdmin(req, res, () => { nextCalled = true; }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403, 'a customer company admin must never reach the platform control plane');
});

test('requirePlatformAdmin: passes for an admin whose email IS in protected_admin_emails (Yaron/Michelle on EC\'s own installation)', async () => {
  const rbac = loadRbacWithProtectedEmails(['yaron@ecconstructiongroup.com', 'michelle@ecconstructiongroup.com']);
  const { req, res } = mockReqRes({ sub: 'u1', email: 'Yaron@EcConstructionGroup.com', role: 'admin' });
  let nextCalled = false;
  await run(() => rbac.requirePlatformAdmin(req, res, () => { nextCalled = true; }));
  assert.strictEqual(nextCalled, true, 'match must be case-insensitive');
  assert.strictEqual(res.statusCode, null);
});

test('requirePlatformAdmin: a fresh company installation (protected_admin_emails = []) is inert for every one of its own admins', async () => {
  const rbac = loadRbacWithProtectedEmails([]);
  const { req, res } = mockReqRes({ sub: 'u1', email: 'owner@newcompany.example', role: 'admin' });
  let nextCalled = false;
  await run(() => rbac.requirePlatformAdmin(req, res, () => { nextCalled = true; }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('requirePlatformAdmin: a lookup failure returns 500, never silently grants access', async () => {
  const nrPath = require.resolve('../lib/notificationRecipients');
  delete require.cache[nrPath];
  require.cache[nrPath] = {
    id: nrPath, filename: nrPath, loaded: true,
    exports: { getProtectedAdminEmails: async () => { throw new Error('db unreachable'); } },
  };
  delete require.cache[require.resolve('../lib/rbac')];
  const rbac = require('../lib/rbac');
  const { req, res } = mockReqRes({ sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  let nextCalled = false;
  await run(() => rbac.requirePlatformAdmin(req, res, () => { nextCalled = true; }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 500);
});
