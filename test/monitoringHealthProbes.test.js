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
  checkWebsiteIntakeRejections, checkHandoffHealth, checkOutboxBacklog, checkQbHealth, checkQbSyncScheduler,
} = require('../lib/monitoring/healthProbes');

// ── calendar_outbox backlog — November 2026 "John John" incident fix ──────
// Previously counted ONLY backlogPendingValue ('pending'); a 'failed'
// (awaiting backoff) or 'dead' (retries exhausted) row was invisible,
// regardless of count or age — exactly the "silently leaving stale events"
// gap the production bug report asked to be closed. These tests use the
// REAL calendar-outbox-worker service-config shape (backlogRetryableValues/
// backlogDeadValue), not a bespoke one, so a future drift in
// serviceInventory.js's actual entry would be caught by the companion
// source-level test below, not just by these unit tests passing an
// idealized config.
const CALENDAR_OUTBOX_SERVICE = {
  id: 'calendar-outbox-worker', backlogTable: 'calendar_outbox', backlogStatusField: 'status',
  backlogPendingValue: 'pending', backlogRetryableValues: ['pending', 'failed'], backlogDeadValue: 'dead',
  maxBacklogAge: 10 * 60 * 1000,
};

test('checkOutboxBacklog: empty backlog -> healthy', async () => {
  queryImpl = async () => ({ rows: [{ pending_count: '0', dead_count: '0', oldest_age_ms: '0' }] });
  const result = await checkOutboxBacklog(CALENDAR_OUTBOX_SERVICE);
  assert.strictEqual(result.healthy, true);
});

test('checkOutboxBacklog: rows stuck at "failed" (not just "pending") are counted and can trip the stuck threshold', async () => {
  queryImpl = async (sql, params) => {
    // Confirms the query actually asks for BOTH retryable values, not only 'pending'.
    assert.deepStrictEqual(params[0], ['pending', 'failed']);
    return { rows: [{ pending_count: '3', dead_count: '0', oldest_age_ms: String(20 * 60 * 1000) }] };
  };
  const result = await checkOutboxBacklog(CALENDAR_OUTBOX_SERVICE);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.details.pendingCount, 3);
  assert.match(result.error, /Backlog/);
});

test('checkOutboxBacklog: any dead-lettered row -> unhealthy, even with zero pending/failed and a fresh backlog', async () => {
  queryImpl = async (sql, params) => {
    assert.strictEqual(params[1], 'dead');
    return { rows: [{ pending_count: '0', dead_count: '1', oldest_age_ms: '0' }] };
  };
  const result = await checkOutboxBacklog(CALENDAR_OUTBOX_SERVICE);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.details.deadCount, 1);
  assert.match(result.error, /permanently failed/);
  assert.match(result.error, /dead-lettered/);
});

test('checkOutboxBacklog: a small, fresh backlog with zero dead rows is healthy', async () => {
  queryImpl = async () => ({ rows: [{ pending_count: '2', dead_count: '0', oldest_age_ms: String(30 * 1000) }] });
  const result = await checkOutboxBacklog(CALENDAR_OUTBOX_SERVICE);
  assert.strictEqual(result.healthy, true);
});

test('checkOutboxBacklog: a caller with no backlogRetryableValues/backlogDeadValue (legacy config) is unaffected — defaults to pending-only, dead never checked', async () => {
  queryImpl = async (sql, params) => {
    assert.deepStrictEqual(params[0], ['pending']);
    assert.strictEqual(params[1], null);
    return { rows: [{ pending_count: '0', dead_count: '0', oldest_age_ms: '0' }] };
  };
  const result = await checkOutboxBacklog({ id: 'legacy', backlogTable: 'calendar_outbox', backlogPendingValue: 'pending', maxBacklogAge: 600000 });
  assert.strictEqual(result.healthy, true);
});

test('checkOutboxBacklog: a query failure never crashes, reports unhealthy with the error', async () => {
  queryImpl = async () => { throw new Error('connection reset'); };
  const result = await checkOutboxBacklog(CALENDAR_OUTBOX_SERVICE);
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /connection reset/);
});

test('serviceInventory.js: the real calendar-outbox-worker entry actually opts into failed+dead visibility (source-level — keeps the unit tests above honest about the real config)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'monitoring', 'serviceInventory.js'), 'utf8');
  const entry = src.slice(src.indexOf("id: 'calendar-outbox-worker'"), src.indexOf("id: 'calendar-outbox-heartbeat'"));
  assert.match(entry, /backlogRetryableValues:\s*\['pending',\s*'failed'\]/);
  assert.match(entry, /backlogDeadValue:\s*'dead'/);
});

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

// ── checkQbHealth: circuit-breaker awareness (November 2026 incident) ──────
//
// Production finding: a 3+ day QuickBooks rate-limit outage (confirmed via
// real Railway logs — opens_count climbing past 100, every sync call
// failing) never triggered the production watchdog's automated alert at
// all, because checkQbHealth (the ONE thing that drives it for the
// 'quickbooks-integration' service) only ever checked OAuth-credential
// validity (connected/reconnectRequired) — completely blind to the shared
// circuit breaker, which stayed open the entire time while the access
// token kept refreshing successfully every hour (confirmed in the same
// logs) and the stored credential was never revoked. Fixed by folding a
// SUSTAINED (not a brief, normal) open breaker into this same health
// signal, reusing the EXISTING app_settings-backed breaker state — no new
// alert mechanism, no new QuickBooks network call.

function stubBreaker(state) {
  return stub('../lib/qbRateLimitBreaker', {
    getState: async () => state,
    isCoolingDown: (s) => !!(s && s.state === 'open' && s.cooldown_until && new Date(s.cooldown_until) > new Date()),
  });
}

test('checkQbHealth: valid credential + breaker CLOSED -> healthy (the ordinary, overwhelmingly common case)', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: true, reconnectRequired: false, tokenExpired: false }) });
  const restore = stubBreaker({ state: 'closed', consecutive_failures: 0, opens_count: 0, cooldown_until: null, last_failure_detail: null });
  try {
    const result = await checkQbHealth({ id: 'quickbooks-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.error, null);
  } finally { delete global.fetch; restore(); }
});

test('checkQbHealth: valid credential + breaker open but BELOW the sustained threshold -> still healthy (never a false alarm on a brief, ordinary blip)', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: true, reconnectRequired: false, tokenExpired: false }) });
  const restore = stubBreaker({ state: 'open', consecutive_failures: 5, opens_count: 1, cooldown_until: new Date(Date.now() + 60000).toISOString(), last_failure_detail: null });
  try {
    const result = await checkQbHealth({ id: 'quickbooks-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, true, 'the breaker opening once is exactly what it is designed to do for an ordinary blip — not yet a watchdog-worthy incident');
  } finally { delete global.fetch; restore(); }
});

test('checkQbHealth: valid credential + breaker SUSTAINED open (the real production shape, opens_count=112) -> unhealthy, naming the sustained reopen count', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: true, reconnectRequired: false, tokenExpired: false }) });
  const restore = stubBreaker({ state: 'open', consecutive_failures: 5, opens_count: 112, cooldown_until: new Date(Date.now() + 1800000).toISOString(), last_failure_detail: null });
  try {
    const result = await checkQbHealth({ id: 'quickbooks-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, false, 'a credential that keeps refreshing fine must NOT mask a sync pipeline that has been down for a sustained period');
    assert.match(result.error, /112 consecutive times/);
    assert.strictEqual(result.details.circuit_breaker_state, 'open');
    assert.strictEqual(result.details.circuit_breaker_opens_count, 112);
  } finally { delete global.fetch; restore(); }
});

test('checkQbHealth: sustained open breaker classified as a monthly quota exhaustion -> the error names it distinctly, not a generic "rate-limited" message', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: true, reconnectRequired: false, tokenExpired: false }) });
  const restore = stubBreaker({
    state: 'open', consecutive_failures: 5, opens_count: 126, cooldown_until: new Date(Date.now() + 1800000).toISOString(),
    last_failure_detail: { reason: 'quota_exhausted', throttlePlanName: 'Block All CorePlus for a Builder App', description: 'You have reached the monthly limit of 500K CorePlus API calls' },
  });
  try {
    const result = await checkQbHealth({ id: 'quickbooks-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, false);
    assert.match(result.error, /monthly call quota exhausted/i);
    assert.match(result.error, /Block All CorePlus for a Builder App/);
  } finally { delete global.fetch; restore(); }
});

test('checkQbHealth: an invalid/revoked credential is unhealthy regardless of breaker state — the two signals are independent', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: false, reconnectRequired: true, tokenExpired: true }) });
  const restore = stubBreaker({ state: 'closed', consecutive_failures: 0, opens_count: 0, cooldown_until: null, last_failure_detail: null });
  try {
    const result = await checkQbHealth({ id: 'quickbooks-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, false);
    assert.match(result.error, /reconnect required/i);
  } finally { delete global.fetch; restore(); }
});

test('checkQbHealth: a breaker-read failure never flips this check unhealthy on its own (fails open — a breaker bug must never itself trigger a false alert)', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ connected: true, reconnectRequired: false, tokenExpired: false }) });
  const restore = stub('../lib/qbRateLimitBreaker', { getState: async () => { throw new Error('breaker DB unreachable'); }, isCoolingDown: () => false });
  try {
    const result = await checkQbHealth({ id: 'quickbooks-integration' }, 'http://unused:3000');
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.details.circuit_breaker_state, null);
  } finally { delete global.fetch; restore(); }
});

// ── checkQbSyncScheduler: a DIFFERENT failure class from checkQbHealth —
// the scheduler not making attempts at all, never attempts that are
// failing (which checkQbHealth's breaker-awareness already covers).

function stubSyncStatus(overrides) {
  return stub('../lib/qbSyncStatus', {
    getQbSyncStatus: async () => ({
      estimate_sync: { available: true, ever_run: true, last_successful_sync_at: null, last_attempted_at: new Date().toISOString(), summary: null },
      inbound_reconcile: { available: true, ever_run: true, last_successful_sync_at: null, last_attempted_at: new Date().toISOString(), summary: null },
      ...overrides,
    }),
  });
}

function stubCronEnabled(enabled) {
  return stub('../lib/qbSyncCronConfig', { isEstimateSyncCronEnabled: () => enabled });
}

test('checkQbSyncScheduler: both crons ticked recently -> healthy', async () => {
  const restoreCron = stubCronEnabled(true);
  const restoreStatus = stubSyncStatus({});
  try {
    const result = await checkQbSyncScheduler({ id: 'quickbooks-sync-scheduler' });
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.error, null);
  } finally { restoreCron(); restoreStatus(); }
});

test('checkQbSyncScheduler: QB_SYNC_CRON_ENABLED=false -> healthy (a deliberate operator choice, never a false alarm)', async () => {
  const restoreCron = stubCronEnabled(false);
  try {
    const result = await checkQbSyncScheduler({ id: 'quickbooks-sync-scheduler' });
    assert.strictEqual(result.healthy, true);
    assert.strictEqual(result.details.reason, 'cron_disabled');
  } finally { restoreCron(); }
});

test('checkQbSyncScheduler: last_attempted_at older than the threshold for a previously-running cron -> unhealthy, names which one went silent (the real "scheduler died" shape)', async () => {
  const restoreCron = stubCronEnabled(true);
  const staleTs = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago, past the 3h default threshold
  const restoreStatus = stubSyncStatus({
    estimate_sync: { available: true, ever_run: true, last_successful_sync_at: staleTs, last_attempted_at: staleTs, summary: null },
  });
  try {
    const result = await checkQbSyncScheduler({ id: 'quickbooks-sync-scheduler' });
    assert.strictEqual(result.healthy, false);
    assert.match(result.error, /estimate_sync/);
    assert.match(result.error, /scheduler may not be executing/i);
  } finally { restoreCron(); restoreStatus(); }
});

test('checkQbSyncScheduler: the real sustained-429 incident shape — last_attempted_at stays FRESH (the cron keeps ticking) even though every attempt fails -> healthy (not a duplicate alert; checkQbHealth\'s breaker-awareness already covers this)', async () => {
  const restoreCron = stubCronEnabled(true);
  const restoreStatus = stubSyncStatus({}); // default fixture: both last_attempted_at fresh, last_successful_sync_at null/stale
  try {
    const result = await checkQbSyncScheduler({ id: 'quickbooks-sync-scheduler' });
    assert.strictEqual(result.healthy, true, 'a fresh last_attempted_at with no successful sync is a DIFFERENT, already-covered signal — this check must never duplicate that alert');
  } finally { restoreCron(); restoreStatus(); }
});

test('checkQbSyncScheduler: a brand-new install that has never ticked yet (ever_run: false) is never a false alarm', async () => {
  const restoreCron = stubCronEnabled(true);
  const restoreStatus = stubSyncStatus({
    estimate_sync: { available: true, ever_run: false, last_successful_sync_at: null, last_attempted_at: null, summary: null },
    inbound_reconcile: { available: true, ever_run: false, last_successful_sync_at: null, last_attempted_at: null, summary: null },
  });
  try {
    const result = await checkQbSyncScheduler({ id: 'quickbooks-sync-scheduler' });
    assert.strictEqual(result.healthy, true);
  } finally { restoreCron(); restoreStatus(); }
});

test('checkQbSyncScheduler: a sync_cursors read failure is reported distinctly, never silently treated as staleness', async () => {
  const restoreCron = stubCronEnabled(true);
  const restoreStatus = stubSyncStatus({
    estimate_sync: { available: false, error: 'cursor_unavailable' },
  });
  try {
    const result = await checkQbSyncScheduler({ id: 'quickbooks-sync-scheduler' });
    assert.strictEqual(result.healthy, false);
    assert.match(result.error, /unavailable/);
  } finally { restoreCron(); restoreStatus(); }
});
