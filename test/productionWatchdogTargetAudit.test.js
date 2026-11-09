/* eslint-disable no-undef */
'use strict';

/**
 * productionWatchdogTargetAudit.test.js — CRM follow-up watchdog fix
 * (item 6 of the explicit follow-up request: "Verify the watchdog's actual
 * health-check targets and expected results using tests before
 * deployment").
 *
 * This is the one place the complete, 11-service surface
 * productionWatchdog.js actually scans is checked together — every other
 * test file in this suite proves one check/entry at a time. Two classes of
 * regression this file guards against recurring:
 *
 *  1. The exact bug this whole follow-up PR fixes: a cross-container HTTP
 *     check (any check reached via `service.directUrl || baseUrl` in
 *     lib/monitoring/healthProbes.js) with NO directUrl at all silently
 *     falls back to `baseUrl`, which — since productionWatchdog.js always
 *     runs from inside artistic-determination, never from the service
 *     being checked — resolves to this watchdog's OWN container, not the
 *     target. Every service whose healthSignal needs an HTTP call to a
 *     DIFFERENT service must carry an explicit directUrl that is never a
 *     bare localhost/loopback address.
 *  2. `probeService`'s switch in lib/monitoring/healthProbes.js must have a
 *     case for every healthSignal any SERVICES entry actually uses — a
 *     typo'd or removed case would silently fall through to the generic
 *     `checkHttpHealth` default, probing the wrong kind of check entirely
 *     without any test ever catching it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function freshServiceInventory() {
  delete require.cache[require.resolve('../lib/monitoring/serviceInventory')];
  return require('../lib/monitoring/serviceInventory');
}

// Health signals whose own check function resolves its HTTP target via
// `service.directUrl || baseUrl` (confirmed by reading
// lib/monitoring/healthProbes.js directly below) — these are exactly the
// ones that MUST carry a real directUrl, since baseUrl alone only ever
// reaches the watchdog's own container.
const CROSS_CONTAINER_HTTP_SIGNALS = new Set(['http', 'qb_integration', 'handoff_integration']);

test('every monitored service with a cross-container HTTP check has an explicit, non-localhost directUrl (the exact class of bug this follow-up PR fixes)', () => {
  const { getMonitoredServices } = freshServiceInventory();
  const services = getMonitoredServices();
  const offenders = [];
  for (const service of services) {
    const signal = service.healthSignal || 'http';
    if (!CROSS_CONTAINER_HTTP_SIGNALS.has(signal)) continue;
    if (!service.directUrl) { offenders.push(`${service.id}: no directUrl at all`); continue; }
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(service.directUrl)) {
      offenders.push(`${service.id}: directUrl is a loopback address (${service.directUrl}) — unreachable from a different container`);
    }
  }
  assert.deepStrictEqual(offenders, [], `found service(s) with a cross-container HTTP check but no safe directUrl:\n${offenders.join('\n')}`);
});

test('exactly the expected 4 services carry an explicit directUrl today — a regression guard against a new cross-container check shipping without one, and an audit trail of which services needed the fix', () => {
  const { getMonitoredServices } = freshServiceInventory();
  const withDirectUrl = getMonitoredServices().filter((s) => !!s.directUrl).map((s) => s.id).sort();
  assert.deepStrictEqual(withDirectUrl, ['crm-frontend', 'handoff-integration', 'qb-proxy-server', 'quickbooks-integration'].sort());
});

test('probeService (lib/monitoring/healthProbes.js) has a dispatch case for every healthSignal any monitored service actually declares', () => {
  const { getMonitoredServices } = freshServiceInventory();
  const services = getMonitoredServices();
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'monitoring', 'healthProbes.js'), 'utf8');
  const switchStart = src.indexOf('async function probeService');
  assert.ok(switchStart !== -1, 'probeService must exist');
  const switchBody = src.slice(switchStart, src.indexOf('\n}', switchStart));

  const declaredSignals = new Set(services.map((s) => s.healthSignal).filter(Boolean));
  for (const signal of declaredSignals) {
    assert.match(switchBody, new RegExp(`case '${signal}':`), `probeService has no case for healthSignal "${signal}" — it would silently fall through to the generic HTTP default check`);
  }
});

test('the full expected healthSignal roster for all 11 monitored services matches this known-good inventory (fails loudly if a service is added/removed/retargeted without updating this audit)', () => {
  const { getMonitoredServices } = freshServiceInventory();
  const services = getMonitoredServices();
  const roster = Object.fromEntries(services.map((s) => [s.id, s.healthSignal || 'http']));
  assert.deepStrictEqual(roster, {
    'qb-proxy-server': 'http',
    'reminder-worker': 'reminder_runs_heartbeat',
    'calendar-outbox-worker': 'outbox_backlog',
    'google-contacts-outbox': 'google_contacts_outbox_backlog',
    'gmail-integration': 'gmail_integration',
    'website-intake': 'website_intake_silence',
    'website-intake-rejections': 'website_intake_rejections',
    'crm-frontend': 'http',
    'quickbooks-integration': 'qb_integration',
    'handoff-integration': 'handoff_integration',
    postgres: 'db_connection',
  });
  assert.strictEqual(services.length, 11);
});

test('website-intake-rejections is the ONLY service marked alwaysCritical, and it is also the only genuine-delivery-failure signal among the two website-intake entries', () => {
  const { getMonitoredServices } = freshServiceInventory();
  const services = getMonitoredServices();
  const alwaysCritical = services.filter((s) => s.alwaysCritical === true).map((s) => s.id);
  assert.deepStrictEqual(alwaysCritical, ['website-intake-rejections']);
});

test('qb-proxy-server, quickbooks-integration, and handoff-integration all resolve to the SAME qb-proxy-server.railway.internal host/port by default — they are, correctly, the same backend process', () => {
  const { getService } = freshServiceInventory();
  const prev = { QB_PROXY_URL: process.env.QB_PROXY_URL, CRM_API_URL: process.env.CRM_API_URL };
  delete process.env.QB_PROXY_URL;
  delete process.env.CRM_API_URL;
  try {
    delete require.cache[require.resolve('../lib/monitoring/serviceInventory')];
    const fresh = require('../lib/monitoring/serviceInventory');
    const a = fresh.getService('qb-proxy-server').directUrl;
    const b = fresh.getService('quickbooks-integration').directUrl;
    const c = fresh.getService('handoff-integration').directUrl;
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
    assert.match(a, /^http:\/\/qb-proxy-server\.railway\.internal:8080$/);
  } finally {
    if (prev.QB_PROXY_URL !== undefined) process.env.QB_PROXY_URL = prev.QB_PROXY_URL;
    if (prev.CRM_API_URL !== undefined) process.env.CRM_API_URL = prev.CRM_API_URL;
  }
});
