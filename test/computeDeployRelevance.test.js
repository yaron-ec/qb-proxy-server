'use strict';
/**
 * computeDeployRelevance.js — the matcher verify-production (CI) uses to
 * decide whether a push was ever going to redeploy a given service, so a
 * docs-only/other-service-only push is reported SKIPPED, never FAILED.
 *
 * Production incident this guards against: PR #60 (CLAUDE.md-only) was
 * directly observed via the Railway API to SKIP deployment on BOTH
 * qb-proxy-server and insightful-encouragement — if verify-production had
 * been active that day with no relevance check, it would have polled for
 * 10 minutes and reported FAILED on a perfectly healthy push.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  SERVICE_WATCH_PATTERNS,
  matchesPattern,
  isRelevant,
  isServiceRelevant,
} = require('../scripts/ci/computeDeployRelevance');

test('SERVICE_WATCH_PATTERNS has exactly the two services CI verifies', () => {
  assert.deepStrictEqual(Object.keys(SERVICE_WATCH_PATTERNS).sort(), [
    'insightful-encouragement',
    'qb-proxy-server',
  ]);
});

// ── matchesPattern ───────────────────────────────────────────────────────────

test('matchesPattern: directory glob matches the directory itself and nested files', () => {
  assert.strictEqual(matchesPattern('lib', 'lib/**'), true);
  assert.strictEqual(matchesPattern('lib/reminderEngine.js', 'lib/**'), true);
  assert.strictEqual(matchesPattern('lib/monitoring/railwayApiClient.js', 'lib/**'), true, 'nested subdirectory must match');
});

test('matchesPattern: directory glob does not match a different top-level directory', () => {
  assert.strictEqual(matchesPattern('routes/leads.js', 'lib/**'), false);
  assert.strictEqual(matchesPattern('liberty.js', 'lib/**'), false, 'must not match on a bare prefix string collision');
});

test('matchesPattern: exact-filename pattern requires an exact match', () => {
  assert.strictEqual(matchesPattern('server.js', 'server.js'), true);
  assert.strictEqual(matchesPattern('lib/server.js', 'server.js'), false, 'must not match the same basename in another directory');
});

test('matchesPattern: leading slashes on either side are normalized identically', () => {
  assert.strictEqual(matchesPattern('/server.js', 'server.js'), true);
  assert.strictEqual(matchesPattern('server.js', '/server.js'), true);
  assert.strictEqual(matchesPattern('/lib/x.js', '/lib/**'), true);
});

// ── isRelevant / isServiceRelevant ──────────────────────────────────────────

test('isRelevant: false for an empty changed-files list or empty pattern list', () => {
  assert.strictEqual(isRelevant([], ['lib/**']), false);
  assert.strictEqual(isRelevant(['lib/x.js'], []), false);
});

test('isRelevant: true if ANY changed file matches ANY pattern', () => {
  assert.strictEqual(isRelevant(['CLAUDE.md', 'lib/reminderEngine.js'], ['lib/**', 'db/**']), true);
});

test('qb-proxy-server: relevant for every real runtime dependency class', () => {
  for (const f of [
    'server.js',
    'reminderWorker.js',
    'reminderWatchdog.js',
    'productionWatchdog.js',
    'package.json',
    'package-lock.json',
    'Dockerfile',
    'lib/reminderEngine.js',
    'lib/monitoring/railwayApiClient.js',
    'db/migrations/2026-68-sms-outbound-notification-categories.sql',
    'routes/sms.js',
    'scripts/reconcileSmsMessageStatus.js',
  ]) {
    assert.strictEqual(isServiceRelevant('qb-proxy-server', [f]), true, `expected ${f} to be backend-relevant`);
  }
});

test('qb-proxy-server: NOT relevant for docs-only or frontend-only changes — the exact PR #60 shape', () => {
  assert.strictEqual(isServiceRelevant('qb-proxy-server', ['CLAUDE.md']), false);
  assert.strictEqual(isServiceRelevant('qb-proxy-server', ['crm-frontend/src/pages/SystemHealth.jsx']), false);
});

test('insightful-encouragement: relevant only for frontend-watched paths', () => {
  for (const f of ['crm-frontend/src/pages/SystemHealth.jsx', 'Dockerfile.frontend', 'src/legacy.js']) {
    assert.strictEqual(isServiceRelevant('insightful-encouragement', [f]), true, `expected ${f} to be frontend-relevant`);
  }
});

test('insightful-encouragement: NOT relevant for backend-only or docs-only changes', () => {
  assert.strictEqual(isServiceRelevant('insightful-encouragement', ['server.js']), false);
  assert.strictEqual(isServiceRelevant('insightful-encouragement', ['lib/reminderEngine.js']), false);
  assert.strictEqual(isServiceRelevant('insightful-encouragement', ['CLAUDE.md']), false);
});

test('a push touching only CLAUDE.md is irrelevant to BOTH services (reproduces the real PR #60 outcome)', () => {
  const changed = ['CLAUDE.md'];
  assert.strictEqual(isServiceRelevant('qb-proxy-server', changed), false);
  assert.strictEqual(isServiceRelevant('insightful-encouragement', changed), false);
});

test('a push touching both lib/** and crm-frontend/** is relevant to both services independently', () => {
  const changed = ['lib/reminderEngine.js', 'crm-frontend/src/App.jsx'];
  assert.strictEqual(isServiceRelevant('qb-proxy-server', changed), true);
  assert.strictEqual(isServiceRelevant('insightful-encouragement', changed), true);
});

test('isServiceRelevant throws on an unknown service key rather than silently returning false', () => {
  assert.throws(() => isServiceRelevant('noble-illumination', ['db/x.sql']), /Unknown service key/);
});
