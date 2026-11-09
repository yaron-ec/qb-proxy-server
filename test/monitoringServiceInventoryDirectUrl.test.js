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

// ── Stale/incorrect internal port regression guard (follow-up fix) ─────────
// Production incident: the FIRST directUrl fix (above) shipped with port
// 3000 — a stale, never-actually-exercised value from the pre-existing
// `port` field — while qb-proxy-server's real, live-verified listening port
// is 8080 (confirmed two independent ways against the live Railway service:
// its public serviceDomain config reports targetPort: 8080, and its own
// boot log prints "[proxy] QuickBooks Proxy running on port 8080"; server.js
// resolves this via `process.env.PORT || 3000`, so Railway sets PORT=8080
// for this specific service). The watchdog's first post-deploy scan proved
// this live: qb-proxy-server and quickbooks-integration were STILL reported
// unhealthy ("fetch failed") after the directUrl fix deployed, because the
// fix reached the right hostname on the wrong port (connection refused).
// These tests pin the exact, verified port and guard against the two ways
// this class of bug can recur: a hardcoded literal silently drifting from
// the service's own `port` metadata field, and the port simply being wrong
// again after some future change.
test('qb-proxy-server directUrl uses its real, live-verified port (8080), never the stale 3000', () => {
  withEnv({ QB_PROXY_URL: undefined, CRM_API_URL: undefined }, () => {
    const { getService } = freshServiceInventory();
    const svc = getService('qb-proxy-server');
    assert.match(svc.directUrl, /:8080$/, 'must target the real listening port (8080), verified against the live Railway service config and boot log — not the stale, never-exercised 3000 fallback');
    assert.doesNotMatch(svc.directUrl, /:3000/, 'the old, wrong port must never reappear');
  });
});

test('quickbooks-integration directUrl targets the SAME port as the qb-proxy-server entry — the two can never silently disagree', () => {
  withEnv({ QB_PROXY_URL: undefined, CRM_API_URL: undefined }, () => {
    const { getService } = freshServiceInventory();
    const qbProxyPort = getService('qb-proxy-server').directUrl.match(/:(\d+)$/)[1];
    const qbIntegrationPort = getService('quickbooks-integration').directUrl.match(/:(\d+)$/)[1];
    assert.strictEqual(qbIntegrationPort, qbProxyPort, 'both entries target the same real process (qb-proxy-server) and must always use the same port — a single shared constant, never two separately-maintained literals');
  });
});

test('qb-proxy-server\'s own `port` metadata field matches the port actually embedded in its directUrl — single source of truth, cannot silently diverge', () => {
  withEnv({ QB_PROXY_URL: undefined, CRM_API_URL: undefined }, () => {
    const { getService } = freshServiceInventory();
    const svc = getService('qb-proxy-server');
    const urlPort = svc.directUrl.match(/:(\d+)$/)[1];
    assert.strictEqual(String(svc.port), urlPort, 'service.port and the directUrl\'s own port must be the exact same value — this is precisely the invariant whose violation (port:3000 metadata vs. a separately-hardcoded URL) caused the original regression');
  });
});

test('an operator-set QB_PROXY_URL/CRM_API_URL overriding the default is trusted as-is, including its own port (or lack of one) — this fix never second-guesses an explicit operator override', () => {
  withEnv({ QB_PROXY_URL: 'https://custom.example.com:9999', CRM_API_URL: undefined }, () => {
    const { getService } = freshServiceInventory();
    assert.strictEqual(getService('qb-proxy-server').directUrl, 'https://custom.example.com:9999');
    assert.strictEqual(getService('quickbooks-integration').directUrl, 'https://custom.example.com:9999');
  });
});
