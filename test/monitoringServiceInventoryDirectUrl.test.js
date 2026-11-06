/* eslint-disable no-undef */
'use strict';

/**
 * monitoringServiceInventoryDirectUrl.test.js — CRM reliability fix pass.
 *
 * productionWatchdog.js always runs from inside artistic-determination
 * (reminderWorker.js requires it inline — see that file's own header; it
 * is NOT a separate Railway service), never from qb-proxy-server itself.
 * Before this fix, the 'qb-proxy-server' (plain HTTP /health check) and
 * 'quickbooks-integration' (checkQbHealth's /qb/health check) service
 * entries had no `directUrl` at all, so lib/monitoring/healthProbes.js's
 * `service.directUrl || baseUrl` fell through to productionWatchdog.js's
 * own baseUrl fallback chain, which ultimately resolves to
 * 'http://localhost:<port>' — unreachable from a different container (it
 * probes the watchdog's OWN container, which runs no Express server at
 * all). Both checks were therefore structurally guaranteed to fail,
 * regardless of qb-proxy-server's real health.
 *
 * Fixed by giving both entries their own `directUrl`, resolved via
 * Railway's private-network convention ('<service-name>.railway.internal')
 * — the same fix shape 'crm-frontend's own pre-existing `directUrl` already
 * uses for the identical class of problem — with QB_PROXY_URL/CRM_API_URL
 * still taking precedence when an operator sets either.
 */
const test = require('node:test');
const assert = require('node:assert');

function freshServiceInventory() {
  delete require.cache[require.resolve('../lib/monitoring/serviceInventory')];
  return require('../lib/monitoring/serviceInventory');
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

test('qb-proxy-server service entry has a directUrl reachable from a different Railway container, never bare localhost', () => {
  withEnv({ QB_PROXY_URL: undefined, CRM_API_URL: undefined }, () => {
    const { getService } = freshServiceInventory();
    const svc = getService('qb-proxy-server');
    assert.ok(svc.directUrl, 'qb-proxy-server must have a directUrl — this is the exact bug: no directUrl meant the HTTP health check fell back to unreachable localhost');
    assert.doesNotMatch(svc.directUrl, /localhost/, 'must never be localhost — that only ever reaches the watchdog\'s own container (artistic-determination), not qb-proxy-server');
    assert.match(svc.directUrl, /railway\.internal/, 'must use Railway\'s private-network hostname convention, the same fix shape crm-frontend\'s own directUrl already uses');
  });
});

test('quickbooks-integration service entry (checkQbHealth\'s /qb/health call) has the same directUrl fix', () => {
  withEnv({ QB_PROXY_URL: undefined, CRM_API_URL: undefined }, () => {
    const { getService } = freshServiceInventory();
    const svc = getService('quickbooks-integration');
    assert.ok(svc.directUrl);
    assert.doesNotMatch(svc.directUrl, /localhost/);
    assert.match(svc.directUrl, /railway\.internal/);
  });
});

test('QB_PROXY_URL, when set by an operator, still takes precedence over the railway.internal default for both entries', () => {
  withEnv({ QB_PROXY_URL: 'https://custom.example.com', CRM_API_URL: undefined }, () => {
    const { getService } = freshServiceInventory();
    assert.strictEqual(getService('qb-proxy-server').directUrl, 'https://custom.example.com');
    assert.strictEqual(getService('quickbooks-integration').directUrl, 'https://custom.example.com');
  });
});

test('crm-frontend\'s pre-existing directUrl convention is unchanged by this fix', () => {
  const { getService } = freshServiceInventory();
  const svc = getService('crm-frontend');
  assert.ok(svc.directUrl);
});
