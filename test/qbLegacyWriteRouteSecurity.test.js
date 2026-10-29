/* eslint-disable no-undef */
'use strict';

/**
 * qbLegacyWriteRouteSecurity.test.js — source-level proof that server.js's
 * legacy QB proxy write routes are wired to the new admin/manager role
 * gate and idempotency lock added in the October 2026 QuickBooks
 * reliability audit. server.js has top-level side effects (process.exit
 * on missing ENCRYPTION_KEY, app.listen, cron registration) and is not a
 * requirable module, so — same convention as
 * test/qbEstimateSyncManualMatch.test.js and
 * test/qbEstimateSyncCapacity.test.js — this asserts against the actual
 * shipped source text rather than executing the routes directly. The real
 * BEHAVIOR of the role gate and the lock helper is covered by
 * test/qbRouteAuth.test.js and test/advisoryLock.test.js, which exercise
 * the extracted lib/qbRouteAuth.js and lib/advisoryLock.js modules for
 * real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function routeBlock(method, routePath) {
  const re = new RegExp(`app\\.${method}\\('${routePath.replace(/[/:]/g, '\\$&')}'[\\s\\S]{0,400}`);
  const m = SOURCE.match(re);
  assert.ok(m, `expected to find app.${method}('${routePath}', ...) in server.js`);
  return m[0];
}

test('admin-only: OAuth connect/callback/disconnect (and their /qb/auth-* aliases) use requireProxySecretOrRole(\'admin\')', () => {
  for (const [method, p] of [
    ['get', '/auth/connect'], ['post', '/auth/callback'], ['post', '/auth/disconnect'],
    ['post', '/qb/auth-connect'], ['post', '/qb/auth-callback'], ['post', '/qb/auth-disconnect'],
  ]) {
    const block = routeBlock(method, p);
    assert.match(block, /requireProxySecretOrRole\('admin'\)/, `${method.toUpperCase()} ${p} must be admin-only`);
  }
});

test('/auth/status (read-only) is intentionally left on the unrestricted requireProxySecret — any authenticated caller may read connection status', () => {
  const block = routeBlock('get', '/auth/status');
  assert.match(block, /requireProxySecret,/);
  assert.doesNotMatch(block, /requireProxySecretOrRole/);
});

test('admin/manager: the financial write routes use requireProxySecretOrRole(\'admin\', \'manager\')', () => {
  for (const [method, p] of [
    ['post', '/customers'], ['post', '/estimates'], ['post', '/invoices'],
    ['post', '/invoices/:id/void'], ['post', '/qb/sync-lead'],
  ]) {
    const block = routeBlock(method, p);
    assert.match(block, /requireProxySecretOrRole\('admin', 'manager'\)/, `${method.toUpperCase()} ${p} must be admin/manager`);
  }
});

test('read-only QB passthrough routes (GET /customers, GET /estimates, GET /invoices) are untouched — still the unrestricted requireProxySecret', () => {
  for (const p of ['/customers', '/estimates', '/invoices']) {
    const block = routeBlock('get', p);
    assert.match(block, /requireProxySecret,/);
    assert.doesNotMatch(block, /requireProxySecretOrRole/);
  }
});

test('POST /customers, /estimates, /invoices (create path), /invoices/:id/void, and /qb/sync-lead all call withQbWriteLock', () => {
  assert.match(SOURCE, /app\.post\('\/customers'[\s\S]{0,2000}withQbWriteLock/);
  assert.match(SOURCE, /app\.post\('\/estimates'[\s\S]{0,2000}withQbWriteLock/);
  assert.match(SOURCE, /app\.post\('\/invoices'[\s\S]{0,2000}withQbWriteLock/);
  assert.match(SOURCE, /app\.post\('\/invoices\/:id\/void'[\s\S]{0,2000}withQbWriteLock/);
  assert.match(SOURCE, /app\.post\('\/qb\/sync-lead'[\s\S]{0,2500}withQbWriteLock/);
});

test('both invoice-void paths (the dedicated route and the POST /invoices fallback) check saleMap.isVoided before calling QuickBooks\' void operation', () => {
  const voidRouteBlock = routeBlock('post', '/invoices/:id/void');
  assert.match(voidRouteBlock, /saleMap\.isVoided/);
  const invoicesRouteIdx = SOURCE.indexOf("app.post('/invoices',");
  assert.ok(invoicesRouteIdx >= 0);
  const invoicesRouteBlock = SOURCE.slice(invoicesRouteIdx, invoicesRouteIdx + 1500);
  assert.match(invoicesRouteBlock, /saleMap\.isVoided/);
});

test('the proactive QB health-check cron is gated behind an explicit opt-in env var, off by default', () => {
  const idx = SOURCE.indexOf('QB Proactive Connection Health Check Cron');
  assert.ok(idx >= 0, 'expected the proactive health check cron section to exist');
  const block = SOURCE.slice(idx, idx + 2500);
  assert.match(block, /QB_PROACTIVE_HEALTH_CHECK_ENABLED === 'true'/);
  assert.match(block, /runProactiveHealthCheck/);
  assert.match(block, /require\('\.\/lib\/qbProactiveHealthCheck'\)/);
});

test('lib/qbRouteAuth.js and lib/advisoryLock.js are actually required by server.js (not dead files)', () => {
  assert.match(SOURCE, /require\('\.\/lib\/qbRouteAuth'\)/);
  assert.match(SOURCE, /require\('\.\/lib\/advisoryLock'\)/);
});
