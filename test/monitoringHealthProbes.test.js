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
} = require('../lib/monitoring/healthProbes');

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
test('checkWebsiteIntakeSilence: module disabled -> healthy (skip)', async () => {
  enabledModulesImpl = { website_intake: false };
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 1000 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.moduleEnabled, false);
});

test('checkWebsiteIntakeSilence: enabled but zero receipts ever -> healthy (never alarms a not-yet-launched install)', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ last_at: null, total: 0 }] });
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 1000 });
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.details.total, 0);
});

test('checkWebsiteIntakeSilence: enabled, recent receipt -> healthy', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ last_at: new Date().toISOString(), total: 5 }] });
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 60 * 60 * 1000 });
  assert.strictEqual(result.healthy, true);
});

test('checkWebsiteIntakeSilence: enabled, last receipt older than maxSilenceMs -> unhealthy, names the webhook secret', async () => {
  enabledModulesImpl = { website_intake: true };
  queryImpl = async () => ({ rows: [{ last_at: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), total: 5 }] });
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 60 * 60 * 1000 });
  assert.strictEqual(result.healthy, false);
  assert.match(result.error, /WEBSITE_LEAD_WEBHOOK_SECRET/);
});
