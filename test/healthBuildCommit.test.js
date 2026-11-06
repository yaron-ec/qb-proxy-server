'use strict';
/**
 * GET /health build_commit field — the fix for verify-production's Bug 1:
 * the CI job previously sent X-Proxy-Secret to GET /api/v1/system/info,
 * but that route is mounted behind requireAuth (Bearer JWT only — see
 * lib/rbac.js) + requireRole('admin'); the proxy secret was silently
 * ignored and the call always 401'd, so the job could never pass.
 *
 * Fix: build_commit now lives on the pre-existing, unauthenticated
 * GET /health (never calls Intuit, never requires a credential) via the
 * shared lib/buildInfo.js — the same module routes/systemInfo.js now uses,
 * so the two can never again compute the commit SHA two different ways.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('lib/buildInfo.buildCommit() reads RAILWAY_GIT_COMMIT_SHA first, never requires a credential', () => {
  delete require.cache[require.resolve('../lib/buildInfo')];
  const prev = process.env.RAILWAY_GIT_COMMIT_SHA;
  try {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'deadbeef1234567890';
    const { buildCommit } = require('../lib/buildInfo');
    assert.strictEqual(buildCommit(), 'deadbeef1234567890');
  } finally {
    if (prev === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = prev;
    delete require.cache[require.resolve('../lib/buildInfo')];
  }
});

test('GET /health is wired to return build_commit from the shared lib/buildInfo module', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const health = server.slice(server.indexOf('async function buildHealthPayload'), server.indexOf('// General health'));
  assert.match(health, /build_commit:\s*buildCommit\(\)/, 'build_commit must come from the shared buildInfo helper, not a new inline implementation');
  assert.match(server, /const \{ buildCommit \} = require\('\.\/lib\/buildInfo'\)/, 'server.js must import the shared module, not duplicate the logic');
  // Confirm /health itself (not just /qb/health) renders this payload, unauthenticated.
  assert.match(server, /app\.get\('\/health', async \(req, res\) => \{\s*res\.json\(await buildHealthPayload\(\)\)/);
  // No token/secret value anywhere in the payload this route returns.
  assert.doesNotMatch(health, /access_token:|refresh_token:/);
});

test('routes/systemInfo.js reuses the same shared buildCommit/productVersion — no second duplicate implementation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'systemInfo.js'), 'utf8');
  assert.match(src, /require\('\.\.\/lib\/buildInfo'\)/);
  assert.doesNotMatch(src, /execSync\('git rev-parse HEAD'/, 'the duplicate inline git-rev-parse fallback must be gone, not just unused');
});
