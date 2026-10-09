/* eslint-disable no-undef */
'use strict';

/**
 * platformCompaniesRoute.test.js — route-level coverage for
 * /api/v1/platform/companies (PRODUCTIZATION — Company Provisioning System,
 * multi-company onboarding workflow). Covers: platform-admin gating (reused
 * from lib/rbac.js#requirePlatformAdmin, tested on its own in
 * test/rbacPlatformAdmin.test.js — here just confirmed wired in), the
 * create → infrastructure → invite lifecycle, resend-invite, and
 * suspend/activate. lib/platformProvisioning.js (the actual cross-database
 * engine) is mocked here — its own isolation behavior is covered by
 * test/platformProvisioning.test.js; this file only proves the ROUTE wires
 * it correctly.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'test-only-jwt-secret-at-least-32-chars-long';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

function mockModule(path, exports) {
  const p = require.resolve(path);
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

let companies;
function reset() {
  companies = [];
}
reset();
let idCounter = 1;

async function mockQuery(sql, params = []) {
  const s = String(sql);
  if (/^\s*INSERT INTO platform_companies/i.test(s)) {
    const row = {
      id: `c${idCounter++}`, company_name: params[0], company_slug: params[1], owner_email: String(params[2]).toLowerCase(),
      owner_name: params[3], status: 'draft', created_by: params[4],
      config_json: {}, database_url_encrypted: null, frontend_url: null, backend_url: null,
      contract_version: null, last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    companies.push(row);
    return { rows: [row] };
  }
  if (/^\s*SELECT 1 FROM platform_companies WHERE company_slug/i.test(s)) {
    return { rows: companies.filter((c) => c.company_slug === params[0]) };
  }
  if (/^\s*SELECT \* FROM platform_companies ORDER BY created_at DESC/i.test(s)) {
    return { rows: [...companies].sort((a, b) => b.created_at.localeCompare(a.created_at)) };
  }
  if (/^\s*SELECT \* FROM platform_companies WHERE id = \$1\s*$/i.test(s)) {
    return { rows: companies.filter((c) => c.id === params[0]) };
  }
  if (/^\s*UPDATE platform_companies SET status = 'provisioning'/i.test(s)) {
    const c = companies.find((x) => x.id === params[4]);
    if (c) { c.status = 'provisioning'; c.config_json = JSON.parse(params[0]); c.frontend_url = params[1]; c.backend_url = params[2]; c.contract_version = params[3]; }
    return { rows: [] };
  }
  if (/^\s*UPDATE platform_companies SET status = 'failed'/i.test(s)) {
    const c = companies.find((x) => x.id === params[1]);
    if (c) { c.status = 'failed'; c.last_error = params[0]; }
    return { rows: [] };
  }
  if (/^\s*UPDATE platform_companies SET database_url_encrypted/i.test(s)) {
    const c = companies.find((x) => x.id === params[1]);
    if (c) { c.database_url_encrypted = params[0]; c.status = 'ready_to_invite'; c.provisioned_at = new Date().toISOString(); }
    return { rows: [] };
  }
  if (/^\s*UPDATE platform_companies SET status = 'invited'/i.test(s)) {
    const c = companies.find((x) => x.id === params[0]);
    if (c) { c.status = 'invited'; c.invited_at = new Date().toISOString(); }
    return { rows: [] };
  }
  if (/^\s*UPDATE platform_companies SET status = \$1, \w+ = NOW\(\)/i.test(s)) {
    const c = companies.find((x) => x.id === params[1]);
    if (c) c.status = params[0];
    return { rows: [] };
  }
  throw new Error('mockQuery: unrecognized query: ' + s);
}

function mockPlatformAdminRbac(isPlatformAdmin) {
  mockModule('../lib/rbac', {
    requireAuth: (req, res, next) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
      req.user = { sub: 'u1', email: auth.replace('Bearer ', ''), role: 'admin' };
      next();
    },
    requirePlatformAdmin: (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'not authenticated' });
      if (!isPlatformAdmin) return res.status(403).json({ error: 'forbidden: platform admin only' });
      next();
    },
  });
}

function mockDbClient() {
  mockModule('../db/client', { query: mockQuery, pool: {} });
}

function startServer() {
  delete require.cache[require.resolve('../routes/platformCompanies')];
  const platformCompaniesRouter = require('../routes/platformCompanies');
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/platform/companies', platformCompaniesRouter);
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

test('every route is gated: a non-platform-admin (e.g. a regular EC admin, or any customer company admin) gets 403', async () => {
  reset();
  mockPlatformAdminRbac(false);
  mockDbClient();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/platform/companies', { headers: { Authorization: 'Bearer someone@else.example' } });
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('POST /: validates company_name and owner_email, creates a draft company with a unique slug', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  const s = await startServer();
  try {
    const bad = await req(s, 'POST', '/api/v1/platform/companies', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' }, body: { company_name: '', owner_email: 'not-an-email' } });
    assert.strictEqual(bad.status, 400);

    const ok = await req(s, 'POST', '/api/v1/platform/companies', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' }, body: { company_name: 'Acme Remodeling', owner_email: 'Owner@Acme.example', owner_name: 'Jordan' } });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.company.company_name, 'Acme Remodeling');
    assert.strictEqual(ok.body.company.company_slug, 'acme-remodeling');
    assert.strictEqual(ok.body.company.owner_email, 'owner@acme.example');
    assert.strictEqual(ok.body.company.status, 'draft');
    assert.strictEqual(ok.body.company.database_url_encrypted, undefined, 'secrets must never be in the response');
    assert.strictEqual(ok.body.company.has_infrastructure, false);
  } finally { s.close(); }
});

test('GET /: lists companies, redacting database_url_encrypted', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  companies.push({ id: 'c1', company_name: 'Acme', company_slug: 'acme', owner_email: 'o@acme.example', status: 'draft', database_url_encrypted: 'v1:iv:cipher', created_at: new Date().toISOString() });
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/platform/companies', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 1);
    assert.strictEqual(r.body.items[0].database_url_encrypted, undefined);
    assert.strictEqual(r.body.items[0].has_infrastructure, true);
  } finally { s.close(); }
});

test('GET /:id: 404 for an unknown company id', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/platform/companies/does-not-exist', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 404);
  } finally { s.close(); }
});

test('POST /:id/infrastructure: validates database_url/frontend_url/backend_url, then provisions, encrypts the connection string, and sends the owner invite', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  companies.push({
    id: 'c1', company_name: 'Acme Remodeling', company_slug: 'acme-remodeling', owner_email: 'owner@acme.example', owner_name: 'Jordan',
    status: 'draft', config_json: {}, database_url_encrypted: null, created_at: new Date().toISOString(),
  });

  mockModule('../lib/platformProvisioning', {
    provisionCompanyDatabase: async ({ databaseUrl, cfg }) => {
      assert.strictEqual(databaseUrl, 'postgresql://fake-target/db');
      assert.strictEqual(cfg.company_name, 'Acme Remodeling');
      assert.strictEqual(cfg.admin_password, undefined, 'never invents/transmits a password for the owner');
      return { ok: true, health_checks: { ok: true }, first_admin: { created: true, email: 'owner@acme.example', invite_token: 'raw-invite-xyz' } };
    },
  });
  let encryptedPayload = null;
  mockModule('../lib/integrationCredentialStore', {
    encryptPayload: (obj) => { encryptedPayload = obj; return 'v1:fakeiv:fakecipher'; },
    decryptPayload: () => ({ database_url: 'postgresql://fake-target/db' }),
  });
  mockModule('../lib/emailTemplates', { inviteEmail: () => '<html>invite</html>' });
  let sentArgs = null;
  mockModule('../lib/emailService', { send: async (args) => { sentArgs = args; return { ok: true }; } });

  const s = await startServer();
  try {
    const bad = await req(s, 'POST', '/api/v1/platform/companies/c1/infrastructure', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' }, body: { database_url: 'not-postgres' } });
    assert.strictEqual(bad.status, 400);

    const r = await req(s, 'POST', '/api/v1/platform/companies/c1/infrastructure', {
      headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' },
      body: { database_url: 'postgresql://fake-target/db', frontend_url: 'https://acme.example', backend_url: 'https://acme-api.example' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.company.status, 'invited');
    assert.strictEqual(r.body.email_sent, true);
    assert.strictEqual(encryptedPayload.database_url, 'postgresql://fake-target/db');
    assert.ok(sentArgs.to === 'owner@acme.example');
    assert.ok(String(sentArgs.htmlBody).includes('invite'));
    assert.strictEqual(companies[0].database_url_encrypted, 'v1:fakeiv:fakecipher');
  } finally { s.close(); }
});

test('POST /:id/infrastructure: a provisioning failure marks the company failed and returns 502 — never crashes, never leaves it silently stuck', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  companies.push({ id: 'c2', company_name: 'Beta Co', company_slug: 'beta-co', owner_email: 'owner@beta.example', status: 'draft', config_json: {}, created_at: new Date().toISOString() });
  mockModule('../lib/platformProvisioning', {
    provisionCompanyDatabase: async () => { throw new Error('target database unreachable'); },
  });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/companies/c2/infrastructure', {
      headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' },
      body: { database_url: 'postgresql://unreachable/db', frontend_url: 'https://beta.example', backend_url: 'https://beta-api.example' },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(companies[0].status, 'failed');
  } finally { s.close(); }
});

test('POST /:id/resend-invite: 409 when infrastructure not yet configured; otherwise regenerates + resends', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  companies.push({ id: 'c3', company_name: 'Gamma', company_slug: 'gamma', owner_email: 'owner@gamma.example', status: 'invited', database_url_encrypted: null, frontend_url: 'https://gamma.example', created_at: new Date().toISOString() });
  const s = await startServer();
  try {
    const notReady = await req(s, 'POST', '/api/v1/platform/companies/c3/resend-invite', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' } });
    assert.strictEqual(notReady.status, 409);
  } finally { s.close(); }

  companies[0].database_url_encrypted = 'v1:iv:cipher';
  mockModule('../lib/integrationCredentialStore', { decryptPayload: () => ({ database_url: 'postgresql://fake-target/db' }), encryptPayload: () => 'x' });
  mockModule('../lib/platformProvisioning', { regenerateInviteOnTarget: async ({ email }) => { assert.strictEqual(email, 'owner@gamma.example'); return { user: { email }, rawToken: 'resend-token', expiresAt: new Date().toISOString() }; } });
  mockModule('../lib/emailTemplates', { inviteEmail: () => '<html>' });
  mockModule('../lib/emailService', { send: async () => ({ ok: true }) });
  const s2 = await startServer();
  try {
    const r = await req(s2, 'POST', '/api/v1/platform/companies/c3/resend-invite', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.email_sent, true);
  } finally { s2.close(); }
});

test('POST /:id/resend-invite: 409 when the owner already activated (regenerateInviteOnTarget returns null)', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  companies.push({ id: 'c4', company_name: 'Delta', company_slug: 'delta', owner_email: 'owner@delta.example', status: 'activated', database_url_encrypted: 'v1:iv:cipher', frontend_url: 'https://delta.example', created_at: new Date().toISOString() });
  mockModule('../lib/integrationCredentialStore', { decryptPayload: () => ({ database_url: 'postgresql://fake-target/db' }) });
  mockModule('../lib/platformProvisioning', { regenerateInviteOnTarget: async () => null });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/companies/c4/resend-invite', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 409);
  } finally { s.close(); }
});

test('POST /:id/suspend and /:id/activate: flips the platform_companies status and reports updated_users from the TARGET db', async () => {
  reset();
  mockPlatformAdminRbac(true);
  mockDbClient();
  companies.push({ id: 'c5', company_name: 'Epsilon', company_slug: 'epsilon', owner_email: 'owner@epsilon.example', status: 'activated', database_url_encrypted: 'v1:iv:cipher', created_at: new Date().toISOString() });
  mockModule('../lib/integrationCredentialStore', { decryptPayload: () => ({ database_url: 'postgresql://fake-target/db' }) });
  let lastStatusCall = null;
  mockModule('../lib/platformProvisioning', {
    setCompanyUsersStatus: async ({ status }) => { lastStatusCall = status; return { updated_users: 4 }; },
  });
  const s = await startServer();
  try {
    const suspend = await req(s, 'POST', '/api/v1/platform/companies/c5/suspend', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' } });
    assert.strictEqual(suspend.status, 200);
    assert.strictEqual(suspend.body.updated_users, 4);
    assert.strictEqual(lastStatusCall, 'disabled');
    assert.strictEqual(companies[0].status, 'suspended');

    const activate = await req(s, 'POST', '/api/v1/platform/companies/c5/activate', { headers: { Authorization: 'Bearer yaron@ecconstructiongroup.com' } });
    assert.strictEqual(activate.status, 200);
    assert.strictEqual(lastStatusCall, 'active');
    assert.strictEqual(companies[0].status, 'activated');
  } finally { s.close(); }
});
