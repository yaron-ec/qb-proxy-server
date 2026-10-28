/* eslint-disable no-undef */
'use strict';

/**
 * qbTokenManagerReconnectAlert.test.js — lib/qbTokenManager.js's
 * `notifyReconnectRequired` REAL implementation (not stubbed).
 *
 * October 2026 QuickBooks reliability audit finding: every test in
 * test/qbTokenManager.test.js replaces `notifyReconnectRequired` entirely via
 * `_setDeps` (it only asserts that it WAS called, with what args) — so none
 * of them ever executed this function's actual body. That body destructured
 * a nonexistent `ALERT_RECIPIENTS` export off lib/captureAlerts.js (which
 * only ever exported `sendNewLeadAlert`), so a genuine QuickBooks
 * reconnect-required condition has most likely NEVER actually sent this
 * email in production — the TypeError was silently swallowed by this
 * function's own try/catch, leaving only a `[qb-token] reconnect alert
 * unavailable` warning in server logs.
 *
 * This file requires a FRESH copy of qbTokenManager and only overrides
 * `pool`/`clientId`/`clientSecret`/`sleep`/`fetch` via `_setDeps` — leaving
 * `notifyReconnectRequired` as the module's real, default implementation —
 * so a revocation reached through the normal `getValidTokens` path actually
 * exercises the fixed code.
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

let persisted = null;
const store = {
  loadPersistedTokens: async () => (persisted ? { ...persisted } : null),
  savePersistedTokens: async (_env, t) => { persisted = { ...t }; return 'postgres'; },
  markRevoked: async () => {},
  markError: async () => {},
  markUsed: async () => {},
};
const storePath = require.resolve('../lib/qbTokenStore');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: store };

delete require.cache[require.resolve('../lib/qbTokenManager')];
const mgr = require('../lib/qbTokenManager');

const pool = {
  connect: async () => ({
    query: async () => ({ rows: [] }),
    release() {},
  }),
};

mgr._setDeps({
  pool: () => pool,
  clientId: () => 'id',
  clientSecret: () => 'secret',
  sleep: async () => {},
  fetch: async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Token invalid or expired' }),
  }),
  // Deliberately NOT overriding notifyReconnectRequired — this suite tests
  // the real implementation.
});

const expiredRevocableTokens = () => ({
  access_token: 'old', refresh_token: 'rt-old', realm_id: 'R1',
  expires_at: new Date(Date.now() - 60000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
});

test.beforeEach(() => { persisted = expiredRevocableTokens(); delete process.env.CRM_PUBLIC_URL; });

test('notifyReconnectRequired: resolves recipients via notificationRecipients + notificationPreferences (the captureAlerts.js pattern), never a nonexistent ALERT_RECIPIENTS export', async () => {
  const sent = [];
  let filteredCategory = null;
  const restoreEmail = stub('../lib/emailService', { send: async (opts) => { sent.push(opts); return { ok: true }; } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com', 'michelle@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (list, category) => {
      filteredCategory = category;
      // Simulate Michelle's single-category (NEW_LEAD-only) policy excluding her.
      return list.filter((e) => e !== 'michelle@ecconstructiongroup.com');
    },
  });
  try {
    await assert.rejects(mgr.getValidTokens('production'), (e) => e.reconnectRequired === true);
    assert.strictEqual(filteredCategory, 'system_failure');
    assert.strictEqual(sent.length, 1, 'exactly one recipient after filtering — not the unfiltered two, and not zero');
    assert.strictEqual(sent[0].to, 'yaron@ecconstructiongroup.com');
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('notifyReconnectRequired: the email links to /integrations specifically, as a valid absolute HTTPS URL, via lib/crmUrl.js', async () => {
  const sent = [];
  const restoreEmail = stub('../lib/emailService', { send: async (opts) => { sent.push(opts); return { ok: true }; } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (list) => list,
  });
  try {
    await assert.rejects(mgr.getValidTokens('production'), (e) => e.reconnectRequired === true);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].htmlBody, /href="https:\/\/crm\.ecconstructiongroup\.com\/integrations"/);
    assert.doesNotMatch(sent[0].htmlBody, /href="http:\/\/\//, 'must never be scheme + empty host');
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('notifyReconnectRequired: never includes a token, client secret, or any credential value in the email body', async () => {
  const sent = [];
  const restoreEmail = stub('../lib/emailService', { send: async (opts) => { sent.push(opts); return { ok: true }; } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (list) => list,
  });
  try {
    await assert.rejects(mgr.getValidTokens('production'), (e) => e.reconnectRequired === true);
    const body = sent[0].htmlBody;
    assert.doesNotMatch(body, /rt-old|old\b/, 'must never include the refresh/access token values');
    assert.doesNotMatch(body, /secret/i, 'must never mention the client secret');
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('notifyReconnectRequired: idempotency key still dedups per credential per day per recipient (unchanged mechanism)', async () => {
  const keys = [];
  const restoreEmail = stub('../lib/emailService', { send: async (opts) => { keys.push(opts.idempotencyKey); return { ok: true }; } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (list) => list,
  });
  try {
    await assert.rejects(mgr.getValidTokens('production'), (e) => e.reconnectRequired === true);
    assert.match(keys[0], /^qb-reconnect-required:production:R1:\d{4}-\d{2}-\d{2}:yaron@ecconstructiongroup\.com$/);
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('notifyReconnectRequired: zero staff recipients configured -> no email attempted, never throws', async () => {
  const sent = [];
  const restoreEmail = stub('../lib/emailService', { send: async (opts) => { sent.push(opts); return { ok: true }; } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => [] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (list) => list,
  });
  try {
    await assert.rejects(mgr.getValidTokens('production'), (e) => e.reconnectRequired === true);
    assert.strictEqual(sent.length, 0);
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('notifyReconnectRequired: a failure resolving recipients/sending is swallowed (best-effort) and never surfaces as a second error from getValidTokens', async () => {
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => { throw new Error('db down'); } });
  try {
    // The ORIGINAL ReconnectRequiredError must still be the one thrown — a
    // notification failure must never mask or replace it.
    await assert.rejects(mgr.getValidTokens('production'), (e) => e.reconnectRequired === true && /RECONNECT_REQUIRED/.test(e.message));
  } finally { restoreRecipients(); }
});
