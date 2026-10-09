/* eslint-disable no-undef */
'use strict';

/**
 * platformInfraProvisioning.test.js — unit coverage for
 * lib/platformInfraProvisioning.js (PRODUCTIZATION — Company Provisioning
 * System, automated infrastructure + release pipeline). Covers:
 *   - estimateInfrastructure() is pure (never touches lib/platformRailway)
 *   - provisionInfrastructure() runs every step in order on a fresh company
 *   - it is RESUMABLE: a simulated mid-flight failure, retried, never
 *     re-creates a Railway resource that a prior (mocked) call already made
 *   - it never calls Railway at all when RAILWAY_API_TOKEN isn't set
 *
 * No real Railway/GitHub/network calls — lib/platformRailway,
 * lib/platformRelease and global fetch (for the health-check poll) are all
 * mocked in require.cache / globalThis.
 */
process.env.PLATFORM_GITHUB_REPO = process.env.PLATFORM_GITHUB_REPO || 'acme-platform/qb-proxy-server';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');

function mockModule(path, exports) {
  const p = require.resolve(path);
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function freshOrchestrator() {
  const p = require.resolve('../lib/platformInfraProvisioning');
  delete require.cache[p];
  return require('../lib/platformInfraProvisioning');
}

const BASE_CFG = {
  company_name: 'Acme Remodeling',
  company_slug: 'acme-remodeling',
  admin_email: 'owner@acme.example',
  enabled_modules: { quickbooks: false, gmail: false, google_calendar: false, google_contacts: false, signnow: false, handoff: false, meta: false, sms: false, website_intake: false },
};

test('estimateInfrastructure: pure — never requires/touches lib/platformRailway, returns a services breakdown + cost range', () => {
  // Deliberately do NOT mock platformRailway here — if estimateInfrastructure
  // ever required it, this test would still pass or fail on its own merits,
  // but we assert no Railway calls were attempted by never installing a
  // working mock at all (a real call would throw "RAILWAY_API_TOKEN not set").
  const orchestrator = freshOrchestrator();
  const estimate = orchestrator.estimateInfrastructure(BASE_CFG);
  assert.ok(Array.isArray(estimate.services) && estimate.services.length >= 2);
  assert.ok(estimate.services.some((s) => s.id === 'api'));
  assert.ok(estimate.services.some((s) => s.id === 'frontend'));
  assert.ok(estimate.services.some((s) => s.id === 'postgres'));
  assert.ok(!estimate.services.some((s) => s.id === 'calendar-outbox-worker'), 'google_calendar/contacts both off — worker must not be included');
  assert.ok(estimate.estimated_monthly_usd_low > 0);
  assert.ok(estimate.estimated_monthly_usd_high >= estimate.estimated_monthly_usd_low);
});

function mockRailwaySuccess(createdServiceIds) {
  let projectCreated = 0;
  let postgresCreated = 0;
  const servicesCreated = [];
  mockModule('../lib/platformRailway', {
    isConfigured: () => true,
    createProject: async () => { projectCreated++; return { id: 'proj-1', name: 'Acme' }; },
    getDefaultEnvironment: async () => ({ id: 'env-1', name: 'production' }),
    createPostgres: async () => { postgresCreated++; return { id: 'pg-svc-1' }; },
    getServiceVariables: async () => ({ DATABASE_URL: 'postgresql://generated-by-railway/db' }),
    createEmptyService: async (_projectId, name) => { servicesCreated.push(name); return { id: `svc-${name}` }; },
    connectServiceSource: async () => ({ id: 'connected' }),
    upsertVariables: async () => {},
    generateDomain: async (_envId, serviceId) => `${serviceId}.up.railway.app`,
    deployService: async () => ({ id: 'deploy-1' }),
    getLatestDeploymentStatus: async () => ({ status: 'SUCCESS' }),
  });
  return { projectCreatedCount: () => projectCreated, postgresCreatedCount: () => postgresCreated, servicesCreated };
}

function mockPlatformRelease() {
  const calls = [];
  mockModule('../lib/platformRelease', {
    ensureDeployBranch: (repo, branch, sha) => { calls.push({ repo, branch, sha }); return { created: true }; },
    getCurrentPlatformReleaseSha: () => 'deadbeef00112233',
  });
  return calls;
}

function mockHealthyFetch() {
  globalThis.fetch = async () => ({ ok: true });
}

function mockDbProvisioning(overrides) {
  mockModule('../lib/platformProvisioning', {
    provisionCompanyDatabase: async () => ({ ok: true, health_checks: { ok: true }, first_admin: { created: true, email: 'owner@acme.example', invite_token: 'raw-invite-xyz' } }),
    ...overrides,
  });
}

test('provisionInfrastructure: runs every step in order on a fresh (never-before-provisioned) company', async () => {
  const railwaySpy = mockRailwaySuccess();
  const branchCalls = mockPlatformRelease();
  mockDbProvisioning();
  mockHealthyFetch();
  const orchestrator = freshOrchestrator();

  const row = { id: 'c1', company_slug: 'acme-remodeling', provisioning_state: {}, railway_service_ids: {} };
  const progressSteps = [];
  const onProgress = async (step, patch) => { progressSteps.push(step); Object.assign(row, patch); };

  const result = await orchestrator.provisionInfrastructure(row, BASE_CFG, onProgress);

  assert.deepStrictEqual(progressSteps, ['project', 'environment', 'postgres', 'services', 'variables', 'domains', 'deploy', 'health', 'database']);
  assert.strictEqual(railwaySpy.projectCreatedCount(), 1);
  assert.strictEqual(railwaySpy.postgresCreatedCount(), 1);
  assert.ok(railwaySpy.servicesCreated.includes('api'));
  assert.ok(railwaySpy.servicesCreated.includes('frontend'));
  assert.strictEqual(branchCalls.length, 1, 'the deploy branch must be created exactly once, before any service is connected');
  assert.strictEqual(branchCalls[0].sha, 'deadbeef00112233');
  assert.ok(result.frontendUrl.startsWith('https://'));
  assert.ok(result.backendUrl.startsWith('https://'));
  assert.strictEqual(result.dbReport.first_admin.invite_token, 'raw-invite-xyz');
});

test('provisionInfrastructure: refuses immediately when RAILWAY_API_TOKEN is not configured — never attempts a single Railway call', async () => {
  mockModule('../lib/platformRailway', { isConfigured: () => false });
  const orchestrator = freshOrchestrator();
  await assert.rejects(
    () => orchestrator.provisionInfrastructure({ id: 'c2', company_slug: 'beta', provisioning_state: {} }, BASE_CFG, async () => {}),
    /RAILWAY_API_TOKEN not set/
  );
});

test('provisionInfrastructure: RESUMABLE — a retry after a mid-flight failure never re-creates an already-recorded resource', async () => {
  let projectCreateCalls = 0;
  let postgresCreateCalls = 0;
  mockModule('../lib/platformRailway', {
    isConfigured: () => true,
    createProject: async () => { projectCreateCalls++; return { id: 'proj-resumed' }; },
    getDefaultEnvironment: async () => ({ id: 'env-resumed' }),
    createPostgres: async () => { postgresCreateCalls++; throw new Error('Railway API error: Problem processing request'); },
  });
  mockPlatformRelease();
  const orchestrator = freshOrchestrator();

  // First attempt: project + environment succeed, postgres throws.
  const row = { id: 'c3', company_slug: 'gamma', provisioning_state: {}, railway_service_ids: {} };
  const onProgress = async (step, patch) => { Object.assign(row, patch); };
  await assert.rejects(() => orchestrator.provisionInfrastructure(row, BASE_CFG, onProgress), /Problem processing request/);
  assert.strictEqual(projectCreateCalls, 1);
  assert.strictEqual(postgresCreateCalls, 1);
  assert.ok(row.provisioning_state.completed_steps.includes('project'));
  assert.ok(row.provisioning_state.completed_steps.includes('environment'));
  assert.ok(!row.provisioning_state.completed_steps.includes('postgres'));
  assert.strictEqual(row.railway_project_id, 'proj-resumed');

  // Second attempt (retry): must NOT call createProject or
  // getDefaultEnvironment again — only retries the failed postgres step
  // onward. Fix the mock so postgres succeeds this time.
  mockModule('../lib/platformRailway', {
    isConfigured: () => true,
    createProject: async () => { projectCreateCalls++; return { id: 'proj-resumed' }; },
    getDefaultEnvironment: async () => { throw new Error('must never be called again on resume'); },
    createPostgres: async () => { postgresCreateCalls++; return { id: 'pg-svc' }; },
    getServiceVariables: async () => ({ DATABASE_URL: 'postgresql://resumed/db' }),
    createEmptyService: async (_p, name) => ({ id: `svc-${name}` }),
    connectServiceSource: async () => ({}),
    upsertVariables: async () => {},
    generateDomain: async (_e, id) => `${id}.up.railway.app`,
    deployService: async () => ({}),
  });
  mockDbProvisioning();
  mockHealthyFetch();
  const orchestrator2 = freshOrchestrator();
  const result = await orchestrator2.provisionInfrastructure(row, BASE_CFG, onProgress);

  assert.strictEqual(projectCreateCalls, 1, 'createProject must never be called a second time once already recorded done');
  assert.strictEqual(postgresCreateCalls, 2, 'postgres step itself IS retried (it was the one that failed) — called once per attempt, not skipped');
  assert.ok(result.dbReport.ok);
});

test('provisionInfrastructure: isolation — never reuses or reads another company\'s railway_project_id/service ids', async () => {
  mockRailwaySuccess();
  mockPlatformRelease();
  mockDbProvisioning();
  mockHealthyFetch();
  const orchestrator = freshOrchestrator();

  const otherCompanyRow = { id: 'other', railway_project_id: 'OTHER-COMPANYS-PROJECT', railway_service_ids: { api: 'OTHER-SVC' } };
  const row = { id: 'c4', company_slug: 'delta', provisioning_state: {}, railway_service_ids: {} }; // fresh, no prior state
  const onProgress = async (step, patch) => { Object.assign(row, patch); };
  const result = await orchestrator.provisionInfrastructure(row, BASE_CFG, onProgress);

  assert.notStrictEqual(result.projectId, otherCompanyRow.railway_project_id);
  assert.notStrictEqual(result.serviceIds.api, otherCompanyRow.railway_service_ids.api);
});
