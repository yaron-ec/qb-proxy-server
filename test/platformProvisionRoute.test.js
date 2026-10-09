/* eslint-disable no-undef */
'use strict';

/**
 * platformProvisionRoute.test.js — route-level coverage for the AUTOMATED
 * provisioning endpoints added to routes/platformCompanies.js (PRODUCTIZATION
 * — Company Provisioning System, automated infrastructure + release
 * pipeline): POST /:id/estimate and POST /:id/provision. The thing this
 * file exists to prove: there is NO way to reach real Railway infrastructure
 * creation without first calling /estimate and then echoing its exact cost
 * back — the task's own explicit "never create billable infrastructure
 * without explicit cost approval" requirement.
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

let companies;
function reset() { companies = []; }
reset();

async function mockQuery(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (/^SELECT \* FROM platform_companies WHERE id = \$1/i.test(s)) {
    return { rows: companies.filter((c) => c.id === params[0]) };
  }
  if (/^UPDATE platform_companies SET\s+cost_estimate_monthly_usd/i.test(s)) {
    const c = companies.find((x) => x.id === params[4]);
    if (c) {
      c.cost_estimate_monthly_usd = params[0];
      c.cost_estimate_breakdown = JSON.parse(params[1]);
      c.config_json = JSON.parse(params[2]);
      c.contract_version = params[3];
      if (c.status === 'draft') c.status = 'awaiting_infrastructure';
    }
    return { rows: [] };
  }
  if (/^UPDATE platform_companies SET\s+status = 'provisioning'/i.test(s)) {
    const c = companies.find((x) => x.id === params[1]);
    if (c) { c.status = 'provisioning'; c.cost_confirmed_at = c.cost_confirmed_at || new Date().toISOString(); c.cost_confirmed_by = c.cost_confirmed_by || params[0]; }
    return { rows: [] };
  }
  if (/^UPDATE platform_companies SET status = 'provisioning_failed'/i.test(s)) {
    const c = companies.find((x) => x.id === params[1]);
    if (c) { c.status = 'provisioning_failed'; c.last_error = params[0]; }
    return { rows: [] };
  }
  if (/^UPDATE platform_companies SET status = 'ready_to_invite'/i.test(s)) {
    const c = companies.find((x) => x.id === params[0]);
    if (c) c.status = 'ready_to_invite';
    return { rows: [] };
  }
  if (/^UPDATE platform_companies SET status = 'invited'/i.test(s)) {
    const c = companies.find((x) => x.id === params[0]);
    if (c) c.status = 'invited';
    return { rows: [] };
  }
  // Generic per-step provisioning_state / railway_* progress writes from onProgress().
  if (/^UPDATE platform_companies SET /i.test(s) && /updated_at = NOW\(\)/i.test(s)) {
    const c = companies.find((x) => x.id === params[params.length - 1]);
    if (c) c.provisioning_state = { touched: true };
    return { rows: [] };
  }
  throw new Error('mockQuery: unrecognized query: ' + s);
}

function mockDb() { mockModule('../db/client', { query: mockQuery, pool: {} }); }

function mockRbac() {
  mockModule('../lib/rbac', {
    requireAuth: (req, res, next) => { req.user = { sub: 'admin-1', email: 'yaron@ecconstructiongroup.com', role: 'admin' }; next(); },
    requirePlatformAdmin: (req, res, next) => next(),
  });
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

function req(server, method, pathStr, { body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ port, path: pathStr, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
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

function makeCompany() {
  return { id: 'c1', company_name: 'Acme Remodeling', company_slug: 'acme-remodeling', owner_email: 'owner@acme.example', owner_name: null, status: 'draft', config_json: {}, cost_estimate_monthly_usd: null, database_url_encrypted: null, frontend_url: null, backend_url: null, created_at: new Date().toISOString() };
}

test('POST /:id/provision: 501 when RAILWAY_API_TOKEN is not configured — never silently falls through', async () => {
  reset();
  mockRbac();
  mockDb();
  mockModule('../lib/platformRailway', { isConfigured: () => false });
  companies.push({ ...makeCompany(), cost_estimate_monthly_usd: 30 });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/companies/c1/provision', { body: { confirm_cost_usd: 30 } });
    assert.strictEqual(r.status, 501);
    assert.strictEqual(r.body.error, 'railway_automation_not_configured');
  } finally { s.close(); }
});

test('POST /:id/provision: 409 when /estimate was never called', async () => {
  reset();
  mockRbac();
  mockDb();
  mockModule('../lib/platformRailway', { isConfigured: () => true });
  companies.push(makeCompany());
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/companies/c1/provision', { body: { confirm_cost_usd: 30 } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'no_estimate');
  } finally { s.close(); }
});

test('POST /:id/estimate: pure — computes and stores an estimate, creates nothing, never requires RAILWAY_API_TOKEN', async () => {
  reset();
  mockRbac();
  mockDb();
  mockModule('../lib/platformRailway', { isConfigured: () => false }); // deliberately unconfigured — estimate must still work
  companies.push(makeCompany());
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/companies/c1/estimate');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.estimate.estimated_monthly_usd_high > 0);
    assert.strictEqual(r.body.railway_automation_available, false);
    assert.strictEqual(companies[0].cost_estimate_monthly_usd, r.body.estimate.estimated_monthly_usd_high);
    assert.strictEqual(companies[0].status, 'awaiting_infrastructure');
  } finally { s.close(); }
});

test('POST /:id/provision: 400 when confirm_cost_usd does not exactly echo the stored estimate — the explicit cost-approval gate', async () => {
  reset();
  mockRbac();
  mockDb();
  mockModule('../lib/platformRailway', { isConfigured: () => true });
  companies.push({ ...makeCompany(), cost_estimate_monthly_usd: 30, config_json: { company_name: 'Acme' } });
  const s = await startServer();
  try {
    const wrongNumber = await req(s, 'POST', '/api/v1/platform/companies/c1/provision', { body: { confirm_cost_usd: 25 } });
    assert.strictEqual(wrongNumber.status, 400);
    assert.strictEqual(wrongNumber.body.error, 'cost_not_confirmed');

    const missing = await req(s, 'POST', '/api/v1/platform/companies/c1/provision', { body: {} });
    assert.strictEqual(missing.status, 400);
  } finally { s.close(); }
});

test('POST /:id/provision: with the cost correctly confirmed, runs the orchestrator and reports a retryable 502 on failure (never crashes, never silently succeeds)', async () => {
  reset();
  mockRbac();
  mockDb();
  mockModule('../lib/platformRailway', { isConfigured: () => true });
  mockModule('../lib/platformInfraProvisioning', {
    provisionInfrastructure: async () => { throw new Error('Railway API error: Problem processing request'); },
  });
  companies.push({ ...makeCompany(), cost_estimate_monthly_usd: 30, config_json: { company_name: 'Acme' } });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/companies/c1/provision', { body: { confirm_cost_usd: 30 } });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.error, 'provisioning_failed');
    assert.strictEqual(r.body.retryable, true);
    assert.strictEqual(companies[0].status, 'provisioning_failed');
  } finally { s.close(); }
});

test('POST /:id/provision: success path — provisions, sends the owner invite, and reports it without leaking the raw invite token', async () => {
  reset();
  mockRbac();
  mockDb();
  mockModule('../lib/platformRailway', { isConfigured: () => true });
  mockModule('../lib/platformInfraProvisioning', {
    provisionInfrastructure: async (row, cfg, onProgress) => {
      await onProgress('project', { railway_project_id: 'proj-1' });
      return {
        projectId: 'proj-1', environmentId: 'env-1', serviceIds: { api: 'svc-api', frontend: 'svc-fe' },
        frontendUrl: 'https://acme.up.railway.app', backendUrl: 'https://acme-api.up.railway.app',
        databaseUrl: 'postgresql://generated/db',
        dbReport: { ok: true, first_admin: { created: true, email: 'owner@acme.example', invite_token: 'raw-invite-xyz' } },
      };
    },
  });
  mockModule('../lib/emailTemplates', { inviteEmail: () => '<html>invite</html>' });
  let sentTo = null;
  mockModule('../lib/emailService', { send: async (args) => { sentTo = args.to; return { ok: true }; } });
  companies.push({ ...makeCompany(), cost_estimate_monthly_usd: 30, config_json: { company_name: 'Acme' } });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/companies/c1/provision', { body: { confirm_cost_usd: 30 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.email_sent, true);
    assert.strictEqual(sentTo, 'owner@acme.example');
    assert.strictEqual(JSON.stringify(r.body).includes('raw-invite-xyz'), false, 'the raw invite token must never appear in the HTTP response');
    assert.strictEqual(companies[0].status, 'invited');
  } finally { s.close(); }
});
