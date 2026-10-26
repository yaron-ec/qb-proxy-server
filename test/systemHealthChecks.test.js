/* eslint-disable no-undef */
'use strict';

/**
 * systemHealthChecks.test.js — CRM System Health real-integration-audit pass.
 * Proves the evidence-based 6-state model (lib/systemHealthChecks.js):
 *   - credential_present is always computed from real stored/env evidence,
 *     never fabricated;
 *   - a live_check is only ever attempted when verify:true is passed, and
 *     every one of them is a stubbed version of an already-existing,
 *     already-proven-safe read-only call (never a real network request in
 *     this test file);
 *   - deriveState()'s 6-state machine (DISABLED, NOT_CONFIGURED, CONFIGURED,
 *     CONNECTED, DEGRADED, DISCONNECTED) is applied identically regardless
 *     of which integration produced the evidence;
 *   - a DISABLED-looking module whose flag has NO real enforcement
 *     (gmail/sms/website_intake) is never forced to DISABLED by the flag
 *     alone — only genuine credential absence does that.
 */
const test = require('node:test');
const assert = require('node:assert');

// ── Stub db/client + companyConfig BEFORE requiring the module under test,
// since systemHealthChecks.js requires both at its top level. ──────────────
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
  exports: { getCompanyConfig: async () => ({ enabled_modules: enabledModulesImpl }) },
};

delete require.cache[require.resolve('../lib/systemHealthChecks')];
const {
  deriveState, getIntegrationHealth, MODULE_FLAG_ENFORCED,
  checkQuickBooks, checkGmail, checkGoogleCalendar, checkGoogleContacts,
  checkSignNow, checkHandoff, checkHandoffEstimatesSync, checkTwilio, checkMeta, checkWebsiteIntake,
} = require('../lib/systemHealthChecks');

// Helper: stub a lazily-`require()`d module (one required inside a function
// body, not at systemHealthChecks.js's top level) for the duration of a test.
function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

// ── deriveState() — the one state machine, tested in isolation ────────────
test('deriveState: DISABLED only when the flag is both enforced and off', () => {
  assert.strictEqual(deriveState({ moduleEnabled: false, flagEnforced: true, result: { credential_present: true, live_check: { ok: true, degraded: false } } }), 'DISABLED');
  // Flag not enforced (known gap, e.g. gmail/sms/website_intake): the module
  // being "off" in Company Settings must NEVER report DISABLED — only real
  // credential absence does.
  assert.strictEqual(deriveState({ moduleEnabled: false, flagEnforced: false, result: { credential_present: true, live_check: null } }), 'CONFIGURED');
});

test('deriveState: NOT_CONFIGURED when no credential evidence exists', () => {
  assert.strictEqual(deriveState({ moduleEnabled: true, flagEnforced: true, result: { credential_present: false, live_check: null } }), 'NOT_CONFIGURED');
});

test('deriveState: CONFIGURED when credential present but no live check was run', () => {
  assert.strictEqual(deriveState({ moduleEnabled: true, flagEnforced: true, result: { credential_present: true, live_check: null } }), 'CONFIGURED');
});

test('deriveState: CONNECTED / DEGRADED / DISCONNECTED map from live_check.ok/degraded', () => {
  const base = { moduleEnabled: true, flagEnforced: true };
  assert.strictEqual(deriveState({ ...base, result: { credential_present: true, live_check: { ok: true, degraded: false } } }), 'CONNECTED');
  assert.strictEqual(deriveState({ ...base, result: { credential_present: true, live_check: { ok: true, degraded: true } } }), 'DEGRADED');
  assert.strictEqual(deriveState({ ...base, result: { credential_present: true, live_check: { ok: false, degraded: false } } }), 'DISCONNECTED');
});

// ── QuickBooks ──────────────────────────────────────────────────────────
test('checkQuickBooks: no persisted tokens -> NOT_CONFIGURED shape, never calls verifyConnection', async () => {
  const restore = stub('../lib/qbTokenStore', {
    loadPersistedTokens: async () => null,
    credentialStatus: async () => { throw new Error('should not be called'); },
  });
  try {
    const result = await checkQuickBooks({ verify: true });
    assert.strictEqual(result.credential_present, false);
    assert.strictEqual(result.live_check, null);
  } finally { restore(); }
});

test('checkQuickBooks: tokens present, verify:false -> CONFIGURED shape, no live call attempted', async () => {
  const restore = stub('../lib/qbTokenStore', {
    loadPersistedTokens: async () => ({ access_token: 'x', refresh_token: 'y' }),
    credentialStatus: async () => ({ status: 'active' }),
  });
  try {
    const result = await checkQuickBooks({ verify: false });
    assert.strictEqual(result.credential_present, true);
    assert.strictEqual(result.live_check, null);
  } finally { restore(); }
});

test('checkQuickBooks: verify:true + reconnectRequired -> DISCONNECTED-shaped live_check', async () => {
  const restoreStore = stub('../lib/qbTokenStore', {
    loadPersistedTokens: async () => ({ access_token: 'x' }),
    credentialStatus: async () => ({ status: 'revoked' }),
  });
  const restoreMgr = stub('../lib/qbTokenManager', {
    verifyConnection: async () => ({ ok: false, reconnectRequired: true }),
  });
  try {
    const result = await checkQuickBooks({ verify: true });
    assert.strictEqual(result.live_check.ok, false);
    assert.strictEqual(result.live_check.degraded, false);
    assert.match(result.live_check.message, /reconnect/i);
  } finally { restoreStore(); restoreMgr(); }
});

test('checkQuickBooks: verify:true + ok -> CONNECTED-shaped live_check', async () => {
  const restoreStore = stub('../lib/qbTokenStore', {
    loadPersistedTokens: async () => ({ access_token: 'x' }),
    credentialStatus: async () => ({ status: 'active' }),
  });
  const restoreMgr = stub('../lib/qbTokenManager', {
    verifyConnection: async () => ({ ok: true, reconnectRequired: false }),
  });
  try {
    const result = await checkQuickBooks({ verify: true });
    assert.strictEqual(result.live_check.ok, true);
    assert.strictEqual(result.live_check.degraded, false);
  } finally { restoreStore(); restoreMgr(); }
});

test('checkQuickBooks: verify:true + non-ok, non-reconnect HTTP status -> DEGRADED-shaped (transient)', async () => {
  const restoreStore = stub('../lib/qbTokenStore', {
    loadPersistedTokens: async () => ({ access_token: 'x' }),
    credentialStatus: async () => ({ status: 'active' }),
  });
  const restoreMgr = stub('../lib/qbTokenManager', {
    verifyConnection: async () => ({ ok: false, status: 503, reconnectRequired: false }),
  });
  try {
    const result = await checkQuickBooks({ verify: true });
    assert.strictEqual(result.live_check.ok, false);
    assert.strictEqual(result.live_check.degraded, true);
  } finally { restoreStore(); restoreMgr(); }
});

// ── Gmail ───────────────────────────────────────────────────────────────
test('checkGmail: no refresh token -> NOT_CONFIGURED shape', async () => {
  const restore = stub('../lib/gmailCredentialStore', { loadGmailCredential: async () => null });
  try {
    const result = await checkGmail({ verify: true });
    assert.strictEqual(result.credential_present, false);
  } finally { restore(); }
});

test('checkGmail: verify:true + profile fetch succeeds -> CONNECTED-shaped', async () => {
  const restoreCred = stub('../lib/gmailCredentialStore', { loadGmailCredential: async () => ({ refresh_token: 'rt' }) });
  class FakeGmailCredentialsError extends Error {}
  const restoreSender = stub('../lib/gmailSender', {
    refreshAccessToken: async () => 'tok',
    GmailCredentialsError: FakeGmailCredentialsError,
  });
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ emailAddress: 'a@b.com' }) });
  try {
    const result = await checkGmail({ verify: true });
    assert.strictEqual(result.live_check.ok, true);
    assert.strictEqual(result.live_check.degraded, false);
  } finally { restoreCred(); restoreSender(); global.fetch = origFetch; }
});

test('checkGmail: verify:true + GmailCredentialsError -> DISCONNECTED-shaped (never degraded)', async () => {
  class FakeGmailCredentialsError extends Error {}
  const restoreCred = stub('../lib/gmailCredentialStore', { loadGmailCredential: async () => ({ refresh_token: 'rt' }) });
  const restoreSender = stub('../lib/gmailSender', {
    refreshAccessToken: async () => { throw new FakeGmailCredentialsError('revoked'); },
    GmailCredentialsError: FakeGmailCredentialsError,
  });
  try {
    const result = await checkGmail({ verify: true });
    assert.strictEqual(result.live_check.ok, false);
    assert.strictEqual(result.live_check.degraded, false);
  } finally { restoreCred(); restoreSender(); }
});

// ── Google Calendar ─────────────────────────────────────────────────────
test('checkGoogleCalendar: missing GOOGLE_SERVICE_ACCOUNT_KEY -> NOT_CONFIGURED shape', async () => {
  await withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: undefined }, async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const result = await checkGoogleCalendar({ verify: true });
    assert.strictEqual(result.credential_present, false);
    assert.ok(result.missing_env.includes('GOOGLE_SERVICE_ACCOUNT_KEY'));
  });
});

test('checkGoogleCalendar: key present + verify:true + listEvents succeeds -> CONNECTED-shaped', async () => {
  const restore = stub('../lib/booking/googleCalendarClient', { listEvents: async () => [] });
  try {
    await withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: '{"fake":true}' }, async () => {
      const result = await checkGoogleCalendar({ verify: true });
      assert.strictEqual(result.credential_present, true);
      assert.strictEqual(result.live_check.ok, true);
    });
  } finally { restore(); }
});

// ── Google Contacts ─────────────────────────────────────────────────────
test('checkGoogleContacts: GOOGLE_CONTACTS_SUB unset -> CONFIGURED but supports_live_check:false (honest cannot-verify)', async () => {
  await withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: '{"fake":true}', GOOGLE_CONTACTS_SUB: undefined }, async () => {
    delete process.env.GOOGLE_CONTACTS_SUB;
    const result = await checkGoogleContacts({ verify: true });
    assert.strictEqual(result.credential_present, true);
    assert.strictEqual(result.supports_live_check, false);
    assert.strictEqual(result.live_check, null);
  });
});

test('checkGoogleContacts: GOOGLE_CONTACTS_SUB set + verify:true -> attempts a live People API call', async () => {
  const restore = stub('../lib/googleContactsClient', { getAccessToken: async (sub) => `tok-for-${sub}` });
  const origFetch = global.fetch;
  let calledWithAuth = null;
  global.fetch = async (url, opts) => { calledWithAuth = opts.headers.Authorization; return { ok: true, json: async () => ({}) }; };
  try {
    await withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: '{"fake":true}', GOOGLE_CONTACTS_SUB: 'ops@example.com' }, async () => {
      const result = await checkGoogleContacts({ verify: true });
      assert.strictEqual(result.live_check.ok, true);
      assert.strictEqual(calledWithAuth, 'Bearer tok-for-ops@example.com');
    });
  } finally { restore(); global.fetch = origFetch; }
});

test('checkGoogleContacts: sync_evidence reports outbox backlog/dead-letter/last-synced independent of credential state', async () => {
  queryImpl = async (sql) => {
    assert.match(sql, /google_contacts_outbox/);
    return { rows: [{ pending: '3', dead: '1', last_synced_at: '2026-01-01T00:00:00Z' }] };
  };
  await withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: undefined, GOOGLE_CONTACTS_SUB: undefined }, async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY; delete process.env.GOOGLE_CONTACTS_SUB;
    // Even with NO credential at all (service account key missing), real
    // outbox history is still genuine evidence and must still be reported.
    const result = await checkGoogleContacts({ verify: false });
    assert.strictEqual(result.credential_present, false);
    assert.deepStrictEqual(result.sync_evidence, { pending_count: 3, dead_count: 1, last_synced_at: '2026-01-01T00:00:00Z' });
  });
});

test('checkGoogleContacts: sync_evidence never crashes the check when the outbox query fails', async () => {
  queryImpl = async () => { throw new Error('db hiccup'); };
  await withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: '{"fake":true}', GOOGLE_CONTACTS_SUB: undefined }, async () => {
    delete process.env.GOOGLE_CONTACTS_SUB;
    const result = await checkGoogleContacts({ verify: false });
    assert.strictEqual(result.credential_present, true);
    assert.strictEqual(result.sync_evidence, null);
  });
});

// ── SignNow ─────────────────────────────────────────────────────────────
test('checkSignNow: getAuthMethod "none" -> NOT_CONFIGURED shape', async () => {
  const restore = stub('../lib/signnowClient', { getAuthMethod: () => 'none' });
  try {
    const result = await checkSignNow({ verify: true });
    assert.strictEqual(result.credential_present, false);
  } finally { restore(); }
});

test('checkSignNow: configured + verify:true + checkConnection connected -> CONNECTED-shaped', async () => {
  const restore = stub('../lib/signnowClient', {
    getAuthMethod: () => 'api_key',
    checkConnection: async () => ({ connected: true, environment: 'sandbox', email: 'ops@example.com' }),
  });
  try {
    const result = await checkSignNow({ verify: true });
    assert.strictEqual(result.credential_source, 'env');
    assert.strictEqual(result.live_check.ok, true);
    assert.strictEqual(result.live_check.detail.environment, 'sandbox');
  } finally { restore(); }
});

test('checkSignNow: configured + verify:true + checkConnection not connected -> DISCONNECTED-shaped', async () => {
  const restore = stub('../lib/signnowClient', {
    getAuthMethod: () => 'password_grant',
    checkConnection: async () => ({ connected: false, message: 'Reconnect required' }),
  });
  try {
    const result = await checkSignNow({ verify: true });
    assert.strictEqual(result.credential_source, 'database');
    assert.strictEqual(result.live_check.ok, false);
    assert.strictEqual(result.live_check.degraded, false);
  } finally { restore(); }
});

// ── Handoff ─────────────────────────────────────────────────────────────
test('checkHandoff: getApiKey throws (no key anywhere) -> NOT_CONFIGURED shape', async () => {
  const restore = stub('../lib/handoffClient', {
    getApiKey: async () => { throw new Error('OFFICIAL_API_KEY_REQUIRED'); },
  });
  try {
    const result = await checkHandoff({ verify: true });
    assert.strictEqual(result.credential_present, false);
  } finally { restore(); }
});

test('checkHandoff: key present + verify:true + checkAuth connected -> CONNECTED-shaped', async () => {
  const restore = stub('../lib/handoffClient', {
    getApiKey: async () => 'key-123',
    checkAuth: async () => ({ connected: true }),
  });
  try {
    const result = await checkHandoff({ verify: true });
    assert.strictEqual(result.live_check.ok, true);
    assert.strictEqual(result.live_check.degraded, false);
  } finally { restore(); }
});

test('checkHandoff: key present + verify:true + checkAuth connected-with-warning -> DEGRADED-shaped', async () => {
  const restore = stub('../lib/handoffClient', {
    getApiKey: async () => 'key-123',
    checkAuth: async () => ({ connected: true, warning: 'rate limited' }),
  });
  try {
    const result = await checkHandoff({ verify: true });
    assert.strictEqual(result.live_check.ok, true);
    assert.strictEqual(result.live_check.degraded, true);
  } finally { restore(); }
});

test('checkHandoff: key present + verify:true + checkAuth invalid_key -> DISCONNECTED-shaped', async () => {
  const restore = stub('../lib/handoffClient', {
    getApiKey: async () => 'key-123',
    checkAuth: async () => ({ connected: false, reason: 'invalid_key' }),
  });
  try {
    const result = await checkHandoff({ verify: true });
    assert.strictEqual(result.live_check.ok, false);
    assert.strictEqual(result.live_check.degraded, false);
  } finally { restore(); }
});

// ── Twilio (sms) ─────────────────────────────────────────────────────────
test('checkTwilio: missing env vars -> NOT_CONFIGURED shape, never calls Twilio', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined }, async () => {
    delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM;
    const origFetch = global.fetch;
    global.fetch = async () => { throw new Error('must never be called'); };
    try {
      const result = await checkTwilio({ verify: true });
      assert.strictEqual(result.credential_present, false);
    } finally { global.fetch = origFetch; }
  });
});

test('checkTwilio: verify:true + 401 -> DISCONNECTED-shaped (never degraded)', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ status: 401, ok: false });
  try {
    await withEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15555550100' }, async () => {
      const result = await checkTwilio({ verify: true });
      assert.strictEqual(result.live_check.ok, false);
      assert.strictEqual(result.live_check.degraded, false);
    });
  } finally { global.fetch = origFetch; }
});

test('checkTwilio: verify:true + active account -> CONNECTED-shaped, uses a read-only Account-fetch (never sends SMS)', async () => {
  const origFetch = global.fetch;
  let calledUrl = null;
  global.fetch = async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ status: 'active' }) }; };
  try {
    await withEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15555550100' }, async () => {
      const result = await checkTwilio({ verify: true });
      assert.strictEqual(result.live_check.ok, true);
      assert.match(calledUrl, /\/Accounts\/AC1\.json$/);
      assert.doesNotMatch(calledUrl, /Messages/);
    });
  } finally { global.fetch = origFetch; }
});

// ── checkTwilio's webhook_config / recency / delivery_failures — October
// 2026 inbound-SMS incident diagnostics. Inbound-webhook evidence must be
// reported even when outbound credentials are entirely missing (DB-only,
// no outbound call), mirroring checkWebsiteIntake's established pattern.
test('checkTwilio: webhook_config reports the dedicated TWILIO_WEBHOOK_BASE_URL (not the frontend-URL fallback) when set', async () => {
  const restoreSmsService = stub('../lib/smsService', {
    getInboundWebhookHealth: async () => ({
      recency: { last_lead_received_at: '2026-10-24T12:00:00.000Z', total_leads_received: 3 },
      delivery_failures: { recent_24h: 0, total: 0, last_rejected_at: null },
    }),
  });
  try {
    await withEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined, TWILIO_WEBHOOK_BASE_URL: 'https://qb-proxy-server-production.up.railway.app' }, async () => {
      delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM;
      const result = await checkTwilio({ verify: false });
      assert.strictEqual(result.webhook_config.base_url_source, 'TWILIO_WEBHOOK_BASE_URL');
      assert.strictEqual(result.webhook_config.inbound_webhook_url, 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/inbound');
      assert.strictEqual(result.webhook_config.status_webhook_url, 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/status');
      assert.strictEqual(result.recency.total_leads_received, 3);
      assert.strictEqual(result.delivery_failures.total, 0);
    });
  } finally {
    restoreSmsService();
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
  }
});

test('checkTwilio: webhook_config visibly flags the CRM_PUBLIC_URL fallback (the exact misconfiguration behind the October 2026 incident) rather than reporting it as correct', async () => {
  const restoreSmsService = stub('../lib/smsService', {
    getInboundWebhookHealth: async () => ({
      recency: { last_lead_received_at: null, total_leads_received: 0 },
      delivery_failures: { recent_24h: 2, total: 5, last_rejected_at: '2026-10-24T12:00:00.000Z' },
    }),
  });
  try {
    await withEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined, TWILIO_WEBHOOK_BASE_URL: undefined, CRM_PUBLIC_URL: 'https://crm.ecconstructiongroup.com' }, async () => {
      delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM; delete process.env.TWILIO_WEBHOOK_BASE_URL;
      const result = await checkTwilio({ verify: false });
      assert.strictEqual(result.webhook_config.base_url_source, 'CRM_PUBLIC_URL_fallback');
      assert.strictEqual(result.webhook_config.inbound_webhook_url, 'https://crm.ecconstructiongroup.com/api/v1/sms-webhook/inbound');
      assert.strictEqual(result.delivery_failures.total, 5, 'rejection evidence must surface even when inbound has never succeeded');
      assert.strictEqual(result.recency.total_leads_received, 0);
    });
  } finally {
    restoreSmsService();
    delete process.env.CRM_PUBLIC_URL;
  }
});

test('checkTwilio: a failing inbound-health lookup degrades gracefully (recency/delivery_failures null), never crashes the whole check', async () => {
  const restoreSmsService = stub('../lib/smsService', {
    getInboundWebhookHealth: async () => { throw new Error('db hiccup'); },
  });
  try {
    await withEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined }, async () => {
      delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM;
      const result = await checkTwilio({ verify: false });
      assert.strictEqual(result.recency, null);
      assert.strictEqual(result.delivery_failures, null);
      assert.ok(result.webhook_config, 'webhook_config itself has no DB dependency and must still be reported');
    });
  } finally { restoreSmsService(); }
});

// ── notification_config — October 2026 production report: an inbound SMS
// reply was received and matched correctly, but neither the assigned rep nor
// Yaron received a notification. Surfaces the TWO independent gates
// (SMS_REPLY_NOTIFICATIONS_ENABLED, SMS_REPLY_FORWARD_TO) without ever
// exposing the configured forward-to number itself.
test('checkTwilio: notification_config reports both reply-notification gates as off by default, with no destination leaked', async () => {
  const restoreSmsService = stub('../lib/smsService', { getInboundWebhookHealth: async () => ({ recency: null, delivery_failures: null }) });
  try {
    await withEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined, SMS_REPLY_NOTIFICATIONS_ENABLED: undefined, SMS_REPLY_FORWARD_TO: undefined }, async () => {
      delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM;
      delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; delete process.env.SMS_REPLY_FORWARD_TO;
      const result = await checkTwilio({ verify: false });
      assert.strictEqual(result.notification_config.reply_notifications_enabled, false);
      assert.strictEqual(result.notification_config.yaron_forward_configured, false);
      assert.ok(!JSON.stringify(result).includes('+1'), 'never leak a configured phone number, even as a stray value');
    });
  } finally { restoreSmsService(); }
});

test('checkTwilio: notification_config reflects both gates once set, still never exposing the destination value', async () => {
  const restoreSmsService = stub('../lib/smsService', { getInboundWebhookHealth: async () => ({ recency: null, delivery_failures: null }) });
  try {
    await withEnv({
      TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined,
      SMS_REPLY_NOTIFICATIONS_ENABLED: 'true', SMS_REPLY_FORWARD_TO: '+13105551234',
    }, async () => {
      delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM;
      const result = await checkTwilio({ verify: false });
      assert.strictEqual(result.notification_config.reply_notifications_enabled, true);
      assert.strictEqual(result.notification_config.yaron_forward_configured, true);
      assert.ok(!JSON.stringify(result).includes('3105551234'), 'the configured destination number itself must never appear in the report');
    });
  } finally { restoreSmsService(); delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; delete process.env.SMS_REPLY_FORWARD_TO; }
});

test('checkTwilio: notification_config distinguishes "forward configured but gate disabled" from "forward not configured at all"', async () => {
  const restoreSmsService = stub('../lib/smsService', { getInboundWebhookHealth: async () => ({ recency: null, delivery_failures: null }) });
  try {
    await withEnv({
      TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined,
      SMS_REPLY_NOTIFICATIONS_ENABLED: undefined, SMS_REPLY_FORWARD_TO: '+13105551234',
    }, async () => {
      delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM;
      delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED;
      const result = await checkTwilio({ verify: false });
      assert.strictEqual(result.notification_config.reply_notifications_enabled, false);
      assert.strictEqual(result.notification_config.yaron_forward_configured, true, 'the number IS set, even though the gate is off');
    });
  } finally { restoreSmsService(); delete process.env.SMS_REPLY_FORWARD_TO; }
});

// ── Meta / Website Intake (inbound-webhook-only, DB recency signal) ──────
test('checkMeta: missing META_APP_SECRET -> NOT_CONFIGURED, supports_live_check:false, no DB query attempted', async () => {
  queryImpl = async () => { throw new Error('must never query when not configured'); };
  await withEnv({ META_APP_SECRET: undefined }, async () => {
    delete process.env.META_APP_SECRET;
    const result = await checkMeta({ verify: true });
    assert.strictEqual(result.credential_present, false);
    assert.strictEqual(result.supports_live_check, false);
  });
});

test('checkMeta: configured -> reports recency from a read-only leads query, no live_check possible', async () => {
  queryImpl = async (sql) => {
    assert.match(sql, /SELECT MAX\(created_at\)/);
    return { rows: [{ last_at: '2026-01-01T00:00:00Z', total: 3 }] };
  };
  await withEnv({ META_APP_SECRET: 'secret' }, async () => {
    const result = await checkMeta({ verify: true });
    assert.strictEqual(result.credential_present, true);
    assert.strictEqual(result.supports_live_check, false);
    assert.strictEqual(result.live_check, null);
    assert.strictEqual(result.recency.total_leads_received, 3);
  });
});

test('checkWebsiteIntake: configured -> reports recency from website_lead_receipts, never a live call', async () => {
  queryImpl = async (sql) => {
    assert.match(sql, /website_lead_receipts/);
    return { rows: [{ last_at: null, total: 0 }] };
  };
  await withEnv({ WEBSITE_LEAD_WEBHOOK_SECRET: 'secret' }, async () => {
    const result = await checkWebsiteIntake({ verify: true });
    assert.strictEqual(result.credential_present, true);
    assert.strictEqual(result.recency.total_leads_received, 0);
  });
});

test('checkWebsiteIntake: end_to_end.verified is false and honest when nothing has ever been received', async () => {
  queryImpl = async () => ({ rows: [{ last_at: null, total: 0 }] });
  await withEnv({ WEBSITE_LEAD_WEBHOOK_SECRET: 'secret' }, async () => {
    const result = await checkWebsiteIntake({ verify: false });
    assert.strictEqual(result.end_to_end.verified, false);
    assert.match(result.end_to_end.message, /ever been received/);
    assert.match(result.end_to_end.manual_check, /test-flagged payload/);
  });
});

test('checkWebsiteIntake: end_to_end.verified is true for a recent real receipt (within the proof window)', async () => {
  queryImpl = async () => ({ rows: [{ last_at: new Date().toISOString(), total: 7 }] });
  await withEnv({ WEBSITE_LEAD_WEBHOOK_SECRET: 'secret' }, async () => {
    const result = await checkWebsiteIntake({ verify: false });
    assert.strictEqual(result.end_to_end.verified, true);
    assert.match(result.end_to_end.message, /full pipeline/);
  });
});

test('checkWebsiteIntake: end_to_end.verified is false for a stale receipt outside the proof window', async () => {
  queryImpl = async () => ({ rows: [{ last_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), total: 7 }] });
  await withEnv({ WEBSITE_LEAD_WEBHOOK_SECRET: 'secret' }, async () => {
    const result = await checkWebsiteIntake({ verify: false });
    assert.strictEqual(result.end_to_end.verified, false);
    assert.match(result.end_to_end.message, /unconfirmed/);
  });
});

test('checkWebsiteIntake: delivery_failures reports rejected-attempt evidence independent of recency', async () => {
  // CRM PRODUCTION reliability audit: a rejection (bad/rotated secret,
  // module disabled) never reaches website_lead_receipts, so without this
  // field "0 total received" is indistinguishable from "the website has
  // been trying and failing the whole time." Two queries now run — recency
  // (website_lead_receipts) then rejections (website_lead_intake_rejections)
  // — distinguished here by table name so each returns its own real shape.
  queryImpl = async (sql) => {
    if (/website_lead_receipts/.test(sql)) return { rows: [{ last_at: null, total: 0 }] };
    if (/website_lead_intake_rejections/.test(sql)) return { rows: [{ recent_24h: 3, total: 11, last_at: '2026-01-02T00:00:00Z' }] };
    throw new Error('unexpected query: ' + sql);
  };
  await withEnv({ WEBSITE_LEAD_WEBHOOK_SECRET: 'secret' }, async () => {
    const result = await checkWebsiteIntake({ verify: false });
    assert.deepStrictEqual(result.delivery_failures, { recent_24h: 3, total: 11, last_rejected_at: '2026-01-02T00:00:00Z' });
  });
});

test('checkWebsiteIntake: delivery_failures is zeroed, never crashes, when the rejections query fails', async () => {
  queryImpl = async (sql) => {
    if (/website_lead_receipts/.test(sql)) return { rows: [{ last_at: null, total: 0 }] };
    throw new Error('db hiccup');
  };
  await withEnv({ WEBSITE_LEAD_WEBHOOK_SECRET: 'secret' }, async () => {
    const result = await checkWebsiteIntake({ verify: false });
    assert.strictEqual(result.delivery_failures, null);
  });
});

// ── Handoff Estimates via QuickBooks (SEPARATE from checkHandoff above) ──
// October 2026 Handoff audit: the production workflow is Handoff ->
// QuickBooks -> CRM (no direct Handoff API key, none intended). This check
// must report THAT pipeline's own evidence, completely independent of the
// unused Direct Handoff API credential checkHandoff reports on.
test('checkHandoffEstimatesSync: no sync_cursors row and zero handoff_estimates -> NOT_CONFIGURED shape', async () => {
  queryImpl = async () => ({ rows: [] });
  const result = await checkHandoffEstimatesSync({ verify: false });
  assert.strictEqual(result.credential_present, false);
  assert.strictEqual(result.live_check, null);
});

test('checkHandoffEstimatesSync: a recent successful cron run -> healthy live_check with match/unmatch counts', async () => {
  queryImpl = async (sql) => {
    if (/sync_cursors/.test(sql)) return { rows: [{ last_successful_sync_at: new Date().toISOString(), last_sync_summary: { imported: 2 } }] };
    if (/handoff_estimates/.test(sql)) return { rows: [{ total: 10, matched: 8, unmatched: 2, last_synced_at: new Date().toISOString() }] };
    throw new Error('unexpected query: ' + sql);
  };
  const result = await checkHandoffEstimatesSync({ verify: false });
  assert.strictEqual(result.credential_present, true);
  assert.strictEqual(result.live_check.ok, true);
  assert.strictEqual(result.live_check.degraded, false);
  assert.match(result.live_check.message, /completed/);
  assert.deepStrictEqual(result.recency, { total_estimates: 10, matched: 8, unmatched: 2, last_synced_at: result.recency.last_synced_at });
});

test('checkHandoffEstimatesSync: last successful sync over an hour ago -> degraded (cron may not be running)', async () => {
  const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  queryImpl = async (sql) => {
    if (/sync_cursors/.test(sql)) return { rows: [{ last_successful_sync_at: staleAt, last_sync_summary: null }] };
    if (/handoff_estimates/.test(sql)) return { rows: [{ total: 5, matched: 5, unmatched: 0, last_synced_at: staleAt }] };
    throw new Error('unexpected query: ' + sql);
  };
  const result = await checkHandoffEstimatesSync({ verify: false });
  assert.strictEqual(result.credential_present, true);
  assert.strictEqual(result.live_check.ok, false);
  assert.strictEqual(result.live_check.degraded, true);
  assert.match(result.live_check.message, /over an hour ago/);
});

test('checkHandoffEstimatesSync: queries failing entirely degrades gracefully, never crashes', async () => {
  queryImpl = async () => { throw new Error('db hiccup'); };
  const result = await checkHandoffEstimatesSync({ verify: false });
  assert.strictEqual(result.credential_present, false);
});

test('checkHandoffEstimatesSync: MODULE_FLAG_ENFORCED is false — never forced to DISABLED (no company_settings toggle of its own)', () => {
  assert.strictEqual(MODULE_FLAG_ENFORCED.handoff_estimates_sync, false);
});

// ── getIntegrationHealth: combinator-level guarantees ─────────────────────
test('checkQuickBooks: a failing credential lookup degrades gracefully to NOT_CONFIGURED, never a crash', async () => {
  // loadPersistedTokens throwing is caught by checkQuickBooks's OWN internal
  // defense (treat as absent) — proving the check degrades gracefully before
  // getIntegrationHealth's outer per-check isolation would ever need to engage.
  const restoreQb = stub('../lib/qbTokenStore', { loadPersistedTokens: async () => { throw new Error('boom'); } });
  try {
    const result = await checkQuickBooks({ verify: true });
    assert.strictEqual(result.credential_present, false);
    assert.strictEqual(result.live_check, null);
  } finally { restoreQb(); }
});

test('getIntegrationHealth: an uncaught throw from one check never breaks the others (outer per-check isolation)', async () => {
  enabledModulesImpl = { quickbooks: true, gmail: true, google_calendar: true, google_contacts: true, signnow: true, handoff: true, sms: true, meta: true, website_intake: true };
  // signnowClient.getAuthMethod() is called directly (unwrapped) at the top
  // of checkSignNow — a genuine, uncaught synchronous throw here is exactly
  // the case getIntegrationHealth's own try/catch around each check exists for.
  const restoreSignNow = stub('../lib/signnowClient', {
    getAuthMethod: () => { throw new Error('signnowClient module boom'); },
  });
  queryImpl = async () => ({ rows: [{ last_at: null, total: 0 }] });
  try {
    await withEnv({ META_APP_SECRET: 'secret', WEBSITE_LEAD_WEBHOOK_SECRET: 'secret' }, async () => {
      const health = await getIntegrationHealth({ verify: false });
      assert.ok(health.signnow, 'signnow entry still present despite its check throwing');
      assert.match(health.signnow.live_check.message, /Health check itself failed/);
      assert.ok(health.meta, 'an unrelated integration is unaffected by signnow throwing');
      assert.strictEqual(health.meta.state, 'CONFIGURED');
    });
  } finally { restoreSignNow(); }
});

test('getIntegrationHealth: module disabled with an enforced flag reports DISABLED regardless of credential evidence', async () => {
  enabledModulesImpl = { meta: false };
  queryImpl = async () => { throw new Error('should not be reached before the DISABLED short-circuit is asserted') ; };
  await withEnv({ META_APP_SECRET: 'secret' }, async () => {
    // Even though META_APP_SECRET is present, module_enabled:false + flag_enforced:true (meta) must win.
    queryImpl = async () => ({ rows: [{ last_at: null, total: 0 }] });
    const health = await getIntegrationHealth({ verify: false });
    assert.strictEqual(health.meta.state, 'DISABLED');
  });
});
