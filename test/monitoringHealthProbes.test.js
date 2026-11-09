/* eslint-disable no-undef */
'use strict';

/**
 * monitoringHealthProbes.test.js — CRM PRODUCTION final reliability audit.
 * Unit coverage for the three new lib/monitoring/healthProbes.js checks,
 * closing real self-healing/watchdog gaps found by this audit:
 *   - Google Contacts outbox had NO stuck/failed-backlog detection, unlike
 *     Calendar's identical-shaped queue.
 *   - Gmail had NO credential-health signal at all in the watchdog.
 *   - Website Lead Intake had NO "has delivery actually stopped" signal.
 *
 * Every new probe is module-aware: a company that has disabled (or never
 * configured) the relevant integration must never get a false alarm.
 */
const test = require('node:test');
const assert = require('node:assert');

let queryImpl = async () => { throw new Error('unexpected query in test'); };
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (...a) => queryImpl(...a) },
};

let enabledModulesImpl = {};
const companyConfigPath = require.resolve('../lib/companyConfig');
delete require.cache[companyConfigPath];
require.cache[companyConfigPath] = {
  id: companyConfigPath, filename: companyConfigPath, loaded: true,
  exports: { isModuleEnabled: async (mod) => enabledModulesImpl[mod] === true },
};

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

delete require.cache[require.resolve('../lib/monitoring/healthProbes')];
const {
  checkGoogleContactsOutboxHealth, checkGmailIntegrationHealth, checkWebsiteIntakeSilence,
  checkWebsiteIntakeRejections, checkHandoffHealth,
} = require('../lib/monitoring/healthProbes');

// ── Handoff (Direct API) — correct signal: API key presence, NEVER
//    enabled_modules.handoff (follow-up correction) ─────────────────────────
// Production audit found checkHandoffHealth had NO gate at all, so it
// always reported unhealthy, 24/7, for an intentionally-unconfigured
// integration. A FIRST fix gated on companyConfig.isModuleEnabled('handoff')
// — but that flag is ALSO (and, for this installation, ACTUALLY) the gate
// for the unrelated, real, actively-used routes/handoffEstimates.js CRUD
// router (the Handoff-via-QuickBooks estimates feature), so it is `true` in
// production correctly, for a totally different reason — confirmed live:
// that fix deployed and the very next watchdog scan still showed
// handoff-integration unhealthy with "fetch failed." Corrected to gate on
// the ACTUAL, already-authoritative signal instead —
// lib/handoffClient.js#getApiKey() (the same function
// lib/systemHealthChecks.js#checkHandoff already uses to correctly report
// System Health's separate "Handoff (Direct API)" card as Not Configured)
// — completely independent of enabled_modules.handoff's own, unrelated,
// correct value.
test('checkHandoffHealth: no Handoff API key configured anywhere -> healthy (skip), never a false alarm for an intentionally-unconfigured integration, regardless of enabled_modules.handoff', async () => {
  const restore = stub('../lib/handoffClient', { getApiKey: async () => { throw new Error('OFFICIAL_API_KEY_REQUIRED: No Handoff API key in app_settings or HANDOFF_API_KEY env var'); } });
  try {
    const result = await checkHandoffHealth({ id: 'handoff-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.details.apiKeyConfigured, false);
    assert.strictEqual(result.error, null);
  } finally { restore(); }
});

test('checkHandoffHealth: an API key IS configured + stored credential connected + upstream reachable -> healthy', async () => {
  const restore = stub('../lib/handoffClient', { getApiKey: async () => 'real-key-123' });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: true }) });
  try {
    const result = await checkHandoffHealth({ id: 'handoff-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, true);
  } finally { delete global.fetch; restore(); }
});

test('checkHandoffHealth: an API key IS configured but no stored credential -> unhealthy (a genuine, real gap, not a false alarm)', async () => {
  const restore = stub('../lib/handoffClient', { getApiKey: async () => 'real-key-123' });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: false }) });
  try {
    const result = await checkHandoffHealth({ id: 'handoff-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, false);
    assert.match(result.error, /not connected/);
  } finally { delete global.fetch; restore(); }
});

test('checkHandoffHealth never reads enabled_modules.handoff at all (source-level guard against the exact regression this fix corrects)', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/monitoring/healthProbes'), 'utf8');
  const fnStart = src.indexOf('async function checkHandoffHealth');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
  assert.doesNotMatch(fnBody, /isModuleEnabled|companyConfig/, 'checkHandoffHealth must never depend on enabled_modules.handoff again — that flag is unrelated (it also gates the real handoffEstimates.js router) and was the root cause of the first fix still failing live');
  assert.match(fnBody, /getApiKey/, 'must gate on the actual, authoritative "is a direct connection configured" signal');
});

// ── Google Contacts outbox backlog ──────────────────────────────────────
test('checkGoogleContactsOutboxHealth: empty backlog -> healthy', async () => {
  queryImpl = async () => ({ rows: [{ pending_count: '0', dead_count: '0', oldest_pending_age_ms: '0' }] });
  const result = await checkGoogleContactsOutboxHealth({ id: 'google-contacts-outbox', maxBacklogAge: 1800000 });
  assert.strictEqual(result.healthy, true);
});

test('checkGoogleContactsOutboxHealth: a backlog older than maxBacklogAge -> unhealthy, stuck reason', async () => {
  queryImpl = async () => ({ rows: [{ pending_count: '5', dead_count: '0', oldest_pending_age_ms: String(40 * 60 * 1000) }] });
  const result = await checkGoogleContactsOutboxHealth({ id: 'google-contacts-outbox', maxBacklogAge: 1800000 });
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /Backlog/);
});

test('checkGoogleContactsOutboxHealth: any dead-lettered row -> unhealthy, names the reconciliation script', async () => {
  queryImpl = async () => ({ rows: [{ pending_count: '0', dead_count: '2', oldest_pending_age_ms: '0' }] });
  const result = await checkGoogleContactsOutboxHealth({ id: 'google-contacts-outbox', maxBacklogAge: 1800000 });
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /permanently failed/);
  assert.match(result.error, /reconcileGoogleContacts/);
});

test('checkGoogleContactsOutboxHealth: a query failure never crashes, reports unhealthy with the error', async () => {
  queryImpl = async () => { throw new Error('connection reset'); };
  const result = await checkGoogleContactsOutboxHealth({ id: 'google-contacts-outbox', maxBacklogAge: 1800000 });
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /connection reset/);
});

// ── Gmail credential health (cheap, no-network) ─────────────────────────
test('checkGmailIntegrationHealth: module disabled -> healthy (skip), never a false alarm', async () => {
  enabledModulesImpl = { gmail: false };
  const result = await checkGmailIntegrationHealth({ id: 'gmail-integration' });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.moduleEnabled, false);
});

test('checkGmailIntegrationHealth: module enabled but no credential -> unhealthy, names the OAuth connect step', async () => {
  enabledModulesImpl = { gmail: true };
  const restore = stub('../lib/gmailCredentialStore', { loadGmailCredential: async () => null });
  try {
    const result = await checkGmailIntegrationHealth({ id: 'gmail-integration' });
    assert.strictEqual(result.healthy, false);
    assert.match(result.error, /OAuth/);
  } finally { restore(); }
});

test('checkGmailIntegrationHealth: enabled + credential present + last_used_at after last_error_at -> healthy', async () => {
  enabledModulesImpl = { gmail: true };
  const restore = stub('../lib/gmailCredentialStore', {
    loadGmailCredential: async () => ({ refresh_token: 'rt', last_used_at: '2026-01-02T00:00:00Z', last_error_at: '2026-01-01T00:00:00Z' }),
  });
  try {
    const result = await checkGmailIntegrationHealth({ id: 'gmail-integration' });
    assert.strictEqual(result.healthy, true);
  } finally { restore(); }
});

test('checkGmailIntegrationHealth: enabled + credential present + a MORE RECENT error than last success -> unhealthy', async () => {
  enabledModulesImpl = { gmail: true };
  const restore = stub('../lib/gmailCredentialStore', {
    loadGmailCredential: async () => ({ refresh_token: 'rt', last_used_at: '2026-01-01T00:00:00Z', last_error_at: '2026-01-02T00:00:00Z' }),
  });
  try {
    const result = await checkGmailIntegrationHealth({ id: 'gmail-integration' });
    assert.strictEqual(result.healthy, false);
    assert.match(result.error, /more recent/);
  } finally { restore(); }
});

// ── Website Intake inbound-silence ───────────────────────────────────────
// FOLLOW-UP CORRECTION (production reliability audit): absence of website
// leads is a marketing/activity metric, never an automatic system-failure
// alert — this check must ALWAYS report healthy:true (so
// productionWatchdog.js never opens an incident / sends a SYSTEM_FAILURE
// email over mere silence), while still computing and returning the real
// underlying data (`silenceDetected`) so it remains a queryable metric via
// monitoring_health_checks. A genuine failure of the check itself (e.g. the
// query throwing) is still a real, reportable failure — see the last test.
test('checkWebsiteIntakeSilence: module disabled -> healthy (skip)', async () => {
  enabledModulesImpl = { website_intake: false };
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 1000 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.moduleEnabled, false);
});

test('checkWebsiteIntakeSilence: enabled but zero receipts ever -> healthy, silenceDetected:false (never alarms a not-yet-launched install)', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ last_at: null, total: 0 }] });
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 1000 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.total, 0);
  assert.strictEqual(result.details.silenceDetected, false);
});

test('checkWebsiteIntakeSilence: enabled, recent receipt -> healthy, silenceDetected:false', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ last_at: new Date().toISOString(), total: 5 }] });
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 60 * 60 * 1000 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.silenceDetected, false);
});

test('checkWebsiteIntakeSilence: last receipt older than maxSilenceMs -> still healthy:true (NEVER a system-failure alert), but silenceDetected:true and the real age/metric data is preserved', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ last_at: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), total: 5 }] });
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 60 * 60 * 1000 });
  assert.strictEqual(result.healthy, true, 'absence of leads must never report unhealthy — that would feed productionWatchdog.js\'s incident/alert pipeline and generate a false SYSTEM_FAILURE email over mere silence');
  assert.strictEqual(result.error, null, 'never an alert-worthy error for silence alone');
  assert.strictEqual(result.details.silenceDetected, true, 'the real signal must still be computed and recorded as a metric, just never escalated');
  assert.ok(result.details.ageMs > 0);
});

test('checkWebsiteIntakeSilence: even extreme, months-long silence still never reports unhealthy', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ last_at: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(), total: 50 }] });
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 7 * 24 * 60 * 60 * 1000 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.silenceDetected, true);
});

test('checkWebsiteIntakeSilence: a real query failure (the check\'s own infrastructure breaking) is still reported unhealthy — distinct from "no leads"', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => { throw new Error('db down'); };
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 1000 });
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /db down/);
});

// ── Website Intake rejected-delivery burst ──────────────────────────────
test('checkWebsiteIntakeRejections: module disabled -> healthy (skip)', async () => {
  enabledModulesImpl = { website_intake: false };
  const result = await checkWebsiteIntakeRejections({ id: 'website-intake-rejections', windowMs: 3600000, threshold: 3 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.moduleEnabled, false);
});

test('checkWebsiteIntakeRejections: below threshold -> healthy', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ n: 2, last_at: new Date().toISOString() }] });
  const result = await checkWebsiteIntakeRejections({ id: 'website-intake-rejections', windowMs: 3600000, threshold: 3 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.count, 2);
});

test('checkWebsiteIntakeRejections: zero rejections -> healthy', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ n: 0, last_at: null }] });
  const result = await checkWebsiteIntakeRejections({ id: 'website-intake-rejections', windowMs: 3600000, threshold: 3 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.count, 0);
});

test('checkWebsiteIntakeRejections: at/above threshold -> unhealthy, names the secret', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ n: 5, last_at: new Date().toISOString() }] });
  const result = await checkWebsiteIntakeRejections({ id: 'website-intake-rejections', windowMs: 3600000, threshold: 3 });
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /WEBSITE_LEAD_WEBHOOK_SECRET/);
  assert.match(result.error, /credential/);
});

test('checkWebsiteIntakeRejections: a query failure never crashes, reports unhealthy with the error', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => { throw new Error('db down'); };
  const result = await checkWebsiteIntakeRejections({ id: 'website-intake-rejections', windowMs: 3600000, threshold: 3 });
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /db down/);
});
