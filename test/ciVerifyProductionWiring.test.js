'use strict';
/**
 * Source-level wiring guard for .github/workflows/ci.yml's verify-production
 * job — there is no GitHub Actions runner inside this test suite, so (same
 * convention as every other "server.js has top-level side effects" test in
 * this repo) this asserts against the raw YAML text that:
 *   1. Bug 1 (wrong auth) stays fixed: no X-Proxy-Secret / PRODUCTION_PROXY_SECRET
 *      anywhere in this job, and it polls GET /health, not the admin-only
 *      GET /api/v1/system/info.
 *   2. Bug 2 (false failure on an irrelevant push) stays fixed: a
 *      change-detection step exists, both poll steps are gated on their own
 *      relevance output, and the Summary step reports a relevance-based skip
 *      distinctly from a real pass/fail.
 *   3. Independent backend/frontend verification is preserved (frontend step
 *      still runs via always() regardless of the backend step's outcome).
 *   4. No new privileged credential was introduced for this job.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'ci.yml');

function readJob() {
  const full = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const start = full.indexOf('  verify-production:');
  assert.ok(start !== -1, 'verify-production job must exist');
  return full.slice(start);
}

test('ci.yml is syntactically valid YAML with exactly the three expected jobs', () => {
  // No js-yaml dependency in this repo (checked) — shell out to python3's
  // yaml module, already used to validate this file during its original
  // authoring, rather than add a new devDependency for one test.
  const { execFileSync } = require('child_process');
  const out = execFileSync('python3', ['-c',
    "import yaml,json; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(json.dumps(sorted(d['jobs'].keys())))"
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out), ['backend', 'frontend', 'verify-production']);
});

test('Bug 1 fixed: no proxy-secret auth against the admin-only system/info route', () => {
  const job = readJob();
  assert.doesNotMatch(job, /X-Proxy-Secret/, 'must not send a header that /health never needs and /api/v1/system/info never accepts');
  assert.doesNotMatch(job, /PRODUCTION_PROXY_SECRET/, 'the now-unused secret must be fully removed, not just unreferenced in one spot');
  assert.doesNotMatch(job, /api\/v1\/system\/info/, 'must not poll the admin-JWT-gated route');
  assert.match(job, /curl -sf "\$URL\/health"/, 'must poll the unauthenticated /health route instead');
});

test('Bug 2 fixed: a change-detection step exists and both poll steps are gated on it', () => {
  const job = readJob();
  assert.match(job, /Determine which services this push could have redeployed/);
  assert.match(job, /computeDeployRelevance\.js qb-proxy-server/);
  assert.match(job, /computeDeployRelevance\.js insightful-encouragement/);
  assert.match(job, /backend_relevant=\$backend/);
  assert.match(job, /frontend_relevant=\$frontend/);
  assert.match(job, /id: backend-check\s*\n\s*if: steps\.changed\.outputs\.backend_relevant == 'true'/);
  assert.match(job, /steps\.changed\.outputs\.frontend_relevant == 'true'/);
});

test('Bug 2 fixed: an unresolvable diff (initial push / unresolvable before-SHA) fails safe to relevant=true, never silently skips', () => {
  const job = readJob();
  assert.match(job, /backend_relevant=true/);
  assert.match(job, /frontend_relevant=true/);
  assert.match(job, /0000000000000000000000000000000000000000/, 'must explicitly handle the all-zero before-SHA (initial push) case');
});

test('Summary reports a relevance-based SKIPPED distinctly from a pass/fail result', () => {
  const job = readJob();
  assert.match(job, /skipped — no backend-relevant files changed this push/);
  assert.match(job, /skipped — no frontend-relevant files changed this push/);
});

test('independent verification preserved: frontend step still runs via always() regardless of the backend step outcome', () => {
  const job = readJob();
  assert.match(job, /id: frontend-check\s*\n\s*if: always\(\) && steps\.backend-check\.outcome != 'cancelled'/);
});

test('full history is fetched so github.event.before can actually be diffed against', () => {
  const job = readJob();
  assert.match(job, /actions\/checkout@v4\s*\n\s*with:\s*\n\s*fetch-depth: 0/);
});

test('no new privileged CI credential introduced: zero secrets. references in this job', () => {
  const job = readJob();
  assert.doesNotMatch(job, /secrets\./, 'this job must read no GitHub Actions secret at all — build_commit is public, non-sensitive data');
});

test('a FAILED result is still a real job failure (exit 1 + ::error::), never downgraded to a soft warning', () => {
  const job = readJob();
  assert.match(job, /::error::Backend never reported build_commit/);
  assert.match(job, /::error::Frontend never served build hash/);
  const errorCount = (job.match(/exit 1/g) || []).length;
  assert.ok(errorCount >= 2, 'both the backend and frontend failure paths must exit 1');
});
