/* eslint-disable no-undef */
'use strict';

/**
 * platformRelease.test.js — unit coverage for lib/platformRelease.js
 * (PRODUCTIZATION — Company Provisioning System, automated infrastructure +
 * release pipeline). Covers the core safety behaviors the task required:
 *   - staged rollout processes companies in batches
 *   - the FIRST unhealthy company in a batch halts the whole release AND
 *     is automatically rolled back — remaining companies are never touched
 *   - a manual single-company rollback moves only that company
 *
 * Mocks db/client (in-memory fake tables), child_process (no real `gh`
 * calls), and global fetch (health polling) — no live GitHub/Railway/network
 * access anywhere in this file.
 */
process.env.PLATFORM_GITHUB_REPO = process.env.PLATFORM_GITHUB_REPO || 'acme-platform/qb-proxy-server';
process.env.PLATFORM_HEALTH_POLL_ATTEMPTS = '2';
process.env.PLATFORM_HEALTH_POLL_INTERVAL_MS = '5';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

function mockModule(path, exports) {
  const p = require.resolve(path);
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

let releases, companies, deployments;
function reset() {
  releases = [];
  companies = [];
  deployments = [];
}
reset();

function uuid() { return crypto.randomUUID(); }

async function mockQuery(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();

  if (/^INSERT INTO platform_releases/i.test(s)) {
    const row = { id: uuid(), git_sha: params[0], git_ref: params[1], batch_size: params[2], notes: params[3], created_by: params[4], status: 'pending', created_at: new Date().toISOString() };
    releases.push(row);
    return { rows: [row] };
  }
  if (/^SELECT \* FROM platform_releases WHERE id = \$1/i.test(s)) {
    return { rows: releases.filter((r) => r.id === params[0]) };
  }
  if (/^SELECT \* FROM platform_releases ORDER BY created_at DESC/i.test(s)) {
    return { rows: [...releases].reverse() };
  }
  const releaseStatusLiteral = s.match(/^UPDATE platform_releases SET status = '(\w+)'.*WHERE id = \$1/i);
  if (releaseStatusLiteral) {
    const r = releases.find((x) => x.id === params[0]);
    if (r) r.status = releaseStatusLiteral[1];
    return { rows: [] };
  }

  if (/^SELECT \* FROM platform_companies WHERE status IN/i.test(s)) {
    return { rows: companies.filter((c) => ['invited', 'activated'].includes(c.status) && c.deploy_branch).sort((a, b) => a.created_at.localeCompare(b.created_at)) };
  }
  if (/^SELECT \* FROM platform_companies WHERE id = \$1/i.test(s)) {
    return { rows: companies.filter((c) => c.id === params[0]) };
  }
  if (/^UPDATE platform_companies SET current_release_sha = \$1, last_deploy_status = 'healthy'/i.test(s)) {
    const c = companies.find((x) => x.id === params[1]);
    if (c) { c.current_release_sha = params[0]; c.last_deploy_status = 'healthy'; }
    return { rows: [] };
  }
  if (/^UPDATE platform_companies SET last_deploy_status = 'failed'/i.test(s)) {
    const c = companies.find((x) => x.id === params[0]);
    if (c) c.last_deploy_status = 'failed';
    return { rows: [] };
  }
  if (/^UPDATE platform_companies SET current_release_sha = \$1, last_deploy_status = \$2/i.test(s)) {
    const c = companies.find((x) => x.id === params[2]);
    if (c) { c.current_release_sha = params[0]; c.last_deploy_status = params[1]; }
    return { rows: [] };
  }

  if (/^INSERT INTO platform_company_deployments \(company_id, release_id, previous_release_sha, target_release_sha, status\) VALUES \(\$1, \$2, \$3, \$4, 'pending'\) RETURNING \*/i.test(s)) {
    const row = { id: uuid(), company_id: params[0], release_id: params[1], previous_release_sha: params[2], target_release_sha: params[3], status: 'pending', created_at: new Date().toISOString() };
    deployments.push(row);
    return { rows: [row] };
  }
  if (/^UPDATE platform_company_deployments SET status = 'deployed' WHERE id = \$1/i.test(s)) {
    const d = deployments.find((x) => x.id === params[0]);
    if (d) d.status = 'deployed';
    return { rows: [] };
  }
  if (/^UPDATE platform_company_deployments SET status = 'healthy'/i.test(s)) {
    const d = deployments.find((x) => x.id === params[0]);
    if (d) d.status = 'healthy';
    return { rows: [] };
  }
  if (/^UPDATE platform_company_deployments SET status = 'failed', error = \$1/i.test(s)) {
    const d = deployments.find((x) => x.id === params[1]);
    if (d) { d.status = 'failed'; d.error = params[0]; }
    return { rows: [] };
  }
  if (/^SELECT \* FROM platform_company_deployments WHERE company_id = \$1 ORDER BY created_at DESC LIMIT 1/i.test(s)) {
    const rows = deployments.filter((d) => d.company_id === params[0]).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { rows: rows.slice(0, 1) };
  }
  if (/^INSERT INTO platform_company_deployments \(company_id, release_id, previous_release_sha, target_release_sha, status, completed_at\)/i.test(s)) {
    const row = { id: uuid(), company_id: params[0], release_id: params[1], previous_release_sha: params[2], target_release_sha: params[3], status: params[4], created_at: new Date().toISOString() };
    deployments.push(row);
    return { rows: [] };
  }

  throw new Error('mockQuery: unrecognized query: ' + s);
}

function mockDb() {
  mockModule('../db/client', { query: mockQuery, pool: {} });
}

function mockGhApi(handler) {
  const calls = [];
  mockModule('child_process', {
    execFileSync: (cmd, args) => {
      assert.strictEqual(cmd, 'gh');
      calls.push(args);
      return handler(args);
    },
  });
  return calls;
}

function mockNotifications() {
  mockModule('../lib/notificationRecipients', { getProtectedAdminEmails: async () => new Set(['admin@acme.example']) });
  let sent = [];
  mockModule('../lib/emailService', { send: async (args) => { sent.push(args); return { ok: true }; } });
  return sent;
}

function freshRelease() {
  const p = require.resolve('../lib/platformRelease');
  delete require.cache[p];
  return require('../lib/platformRelease');
}

function makeCompany(overrides) {
  const id = uuid();
  const row = {
    id, company_name: `Company ${id.slice(0, 4)}`, company_slug: `co-${id.slice(0, 4)}`,
    status: 'invited', deploy_branch: `deploy/co-${id.slice(0, 4)}`, backend_url: 'https://fake-backend.example',
    current_release_sha: 'old-sha-0000', created_at: new Date().toISOString(),
    ...overrides,
  };
  companies.push(row);
  return row;
}

test('rolloutRelease: deploys every eligible company to the release sha, batch by batch, all healthy -> completed', async () => {
  reset();
  mockDb();
  const ghCalls = mockGhApi(() => '{}');
  globalThis.fetch = async () => ({ ok: true });
  const release = require;
  const platformRelease = freshRelease();

  const companyA = makeCompany({ created_at: '2026-01-01T00:00:00Z' });
  const companyB = makeCompany({ created_at: '2026-01-02T00:00:00Z' });
  const releaseRow = await platformRelease.createRelease({ gitSha: 'new-sha-1111', createdBy: 'admin-1' });

  const result = await platformRelease.rolloutRelease(releaseRow.id, { batchSize: 1 });

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.results.length, 2);
  assert.ok(result.results.every((r) => r.status === 'healthy'));
  assert.strictEqual(companyA.current_release_sha, 'new-sha-1111');
  assert.strictEqual(companyB.current_release_sha, 'new-sha-1111');
  assert.strictEqual(ghCalls.length, 2, 'one ref-move call per company');
  assert.strictEqual(releases.find((r) => r.id === releaseRow.id).status, 'completed');
});

test('rolloutRelease: the FIRST unhealthy company halts the release, is auto-rolled-back, and the REST are never touched', async () => {
  reset();
  mockDb();
  let companyACallCount = 0;
  globalThis.fetch = async (url) => {
    // companyA's health check fails for the bad deploy (its first
    // PLATFORM_HEALTH_POLL_ATTEMPTS calls) then succeeds once rolled back —
    // simulating "the new version crashes, the previous one still works".
    // companyB would succeed immediately, but must never be reached because
    // companyA is processed first and halts the release.
    if (url.includes('company-a-backend')) {
      companyACallCount++;
      return { ok: companyACallCount > Number(process.env.PLATFORM_HEALTH_POLL_ATTEMPTS) };
    }
    return { ok: true };
  };
  const ghCalls = mockGhApi(() => '{}');
  const sentEmails = mockNotifications();
  const platformRelease = freshRelease();

  const companyA = makeCompany({ created_at: '2026-01-01T00:00:00Z', backend_url: 'https://company-a-backend.example' });
  const companyB = makeCompany({ created_at: '2026-01-02T00:00:00Z', backend_url: 'https://company-b-backend.example' });
  const releaseRow = await platformRelease.createRelease({ gitSha: 'new-sha-2222', createdBy: 'admin-1' });

  const result = await platformRelease.rolloutRelease(releaseRow.id, { batchSize: 1 });

  assert.strictEqual(result.status, 'halted');
  assert.strictEqual(result.halted_on, companyA.company_name);
  assert.strictEqual(companyB.current_release_sha, 'old-sha-0000', 'companyB must NEVER be advanced once the release halted on companyA');
  assert.strictEqual(companyA.current_release_sha, 'old-sha-0000', 'companyA must be rolled back to its OWN previous sha, not left on the bad one');
  assert.strictEqual(releases.find((r) => r.id === releaseRow.id).status, 'halted');
  assert.ok(result.rollback.includes('rolled back successfully'));
  assert.ok(sentEmails.length >= 1, 'platform admins must be alerted on a halted rollout');
  // 2 gh calls for companyA (forward, then rollback) — companyB's branch is
  // never touched at all.
  const companyARefCalls = ghCalls.filter((args) => args.some((a) => String(a).includes(companyA.deploy_branch)));
  assert.strictEqual(companyARefCalls.length, 2);
  assert.ok(!ghCalls.some((args) => args.some((a) => String(a).includes(companyB.deploy_branch))), 'companyB\'s branch must never be touched');
});

test('rollbackCompany: moves only the named company back to ITS OWN previous release sha', async () => {
  reset();
  mockDb();
  const ghCalls = mockGhApi(() => '{}');
  globalThis.fetch = async () => ({ ok: true });
  const platformRelease = freshRelease();

  const company = makeCompany({ current_release_sha: 'sha-current' });
  const release = await platformRelease.createRelease({ gitSha: 'sha-current', createdBy: 'admin-1' });
  deployments.push({ id: uuid(), company_id: company.id, release_id: release.id, previous_release_sha: 'sha-previous', target_release_sha: 'sha-current', status: 'healthy', created_at: new Date().toISOString() });

  const result = await platformRelease.rollbackCompany(company.id);

  assert.strictEqual(result.rolled_back_to, 'sha-previous');
  assert.strictEqual(company.current_release_sha, 'sha-previous');
  assert.strictEqual(ghCalls.length, 1);
  assert.ok(ghCalls[0].some((a) => String(a).includes(company.deploy_branch)));
  assert.ok(ghCalls[0].some((a) => String(a).includes('sha-previous')));
});

test('rollbackCompany: refuses when there is no prior deployment to roll back to', async () => {
  reset();
  mockDb();
  mockGhApi(() => '{}');
  const platformRelease = freshRelease();
  const company = makeCompany();
  await assert.rejects(() => platformRelease.rollbackCompany(company.id), /nothing to roll back to/);
});
