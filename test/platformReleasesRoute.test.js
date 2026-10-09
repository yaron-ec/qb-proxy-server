/* eslint-disable no-undef */
'use strict';

/**
 * platformReleasesRoute.test.js — route-level coverage for
 * routes/platformReleases.js (PRODUCTIZATION — Company Provisioning System,
 * automated infrastructure + release pipeline): platform-admin gating, and
 * that each endpoint wires through to lib/platformRelease.js's corresponding
 * function with the right arguments. The engine's own behavior (batching,
 * halt-and-rollback, isolation) is covered by test/platformRelease.test.js;
 * this file only proves the ROUTE is wired correctly and gated correctly.
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

function mockRbac(isPlatformAdmin) {
  mockModule('../lib/rbac', {
    requireAuth: (req, res, next) => { req.user = { sub: 'admin-1', email: 'yaron@ecconstructiongroup.com', role: 'admin' }; next(); },
    requirePlatformAdmin: (req, res, next) => (isPlatformAdmin ? next() : res.status(403).json({ error: 'forbidden: platform admin only' })),
  });
}

function startServer() {
  delete require.cache[require.resolve('../routes/platformReleases')];
  const releasesRouter = require('../routes/platformReleases');
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/platform/releases', releasesRouter);
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

test('every route is gated: a non-platform-admin gets 403', async () => {
  mockRbac(false);
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/platform/releases');
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('POST /: creates a release via lib/platformRelease.js#createRelease, passing the authenticated admin as created_by', async () => {
  mockRbac(true);
  let captured = null;
  mockModule('../lib/platformRelease', {
    createRelease: async (args) => { captured = args; return { id: 'rel-1', ...args }; },
  });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/releases', { body: { git_sha: 'abc123', notes: 'test release' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.release.id, 'rel-1');
    assert.strictEqual(captured.gitSha, 'abc123');
    assert.strictEqual(captured.createdBy, 'admin-1');
  } finally { s.close(); }
});

test('GET /: lists releases via lib/platformRelease.js#listReleases', async () => {
  mockRbac(true);
  mockModule('../lib/platformRelease', { listReleases: async () => [{ id: 'rel-1' }, { id: 'rel-2' }] });
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/platform/releases');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 2);
  } finally { s.close(); }
});

test('POST /:id/rollout: invokes rolloutRelease with the batch_size from the request body and returns its result verbatim', async () => {
  mockRbac(true);
  let captured = null;
  mockModule('../lib/platformRelease', {
    rolloutRelease: async (releaseId, opts) => { captured = { releaseId, opts }; return { release_id: releaseId, status: 'completed', results: [] }; },
  });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/releases/rel-1/rollout', { body: { batch_size: 3 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'completed');
    assert.strictEqual(captured.releaseId, 'rel-1');
    assert.strictEqual(captured.opts.batchSize, 3);
  } finally { s.close(); }
});

test('POST /:id/rollout: a thrown error from the engine surfaces as 500, never a silent 200', async () => {
  mockRbac(true);
  mockModule('../lib/platformRelease', { rolloutRelease: async () => { throw new Error('release not found'); } });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/releases/does-not-exist/rollout');
    assert.strictEqual(r.status, 500);
  } finally { s.close(); }
});

test('POST /company/:companyId/rollback: invokes rollbackCompany for exactly the named company', async () => {
  mockRbac(true);
  let captured = null;
  mockModule('../lib/platformRelease', {
    rollbackCompany: async (companyId) => { captured = companyId; return { company_id: companyId, rolled_back_to: 'old-sha' }; },
  });
  const s = await startServer();
  try {
    const r = await req(s, 'POST', '/api/v1/platform/releases/company/c-42/rollback');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(captured, 'c-42');
    assert.strictEqual(r.body.rolled_back_to, 'old-sha');
  } finally { s.close(); }
});
