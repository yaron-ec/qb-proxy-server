/* eslint-disable no-undef */
'use strict';

/**
 * monitoringAlertDispatcher.test.js — CRM reliability fix pass.
 *
 * Two confirmed production bugs in lib/monitoring/alertDispatcher.js, both
 * fixed here:
 *
 *  1. The existing MONITOR_ALERT_EMAIL_TO (critical-only) email path called
 *     `emailService.sendEmail({ to, subject, body })` — a method that has
 *     NEVER existed on lib/emailService.js's export (the real, only export
 *     is `send({ to, subject, htmlBody, idempotencyKey })`). Every call
 *     threw "emailService.sendEmail is not a function", silently caught and
 *     logged as a non-fatal delivery failure — so even an operator who DID
 *     set MONITOR_ALERT_EMAIL_TO was never actually emailed.
 *
 *  2. There was no path at all routing a monitoring alert through this
 *     codebase's existing staff-broadcast infrastructure
 *     (notificationRecipients.getAllStaffRecipients() narrowed by
 *     notificationPreferences.filterRecipientsForCategory(...,
 *     CATEGORIES.SYSTEM_FAILURE)) — the SAME mechanism every other
 *     CRM-generated staff email already uses, including Michelle's
 *     single-category exclusion. warning/critical/info (recovery) alerts
 *     never reached any human inbox through this path; only Slack (never
 *     configured in production — ALERT_SLACK_WEBHOOK_URL is unset) and
 *     Railway's own structured logs did.
 *
 * Both fixes are purely additive to the existing Railway-log and Slack
 * channels — neither is touched or gated by this change. No Slack/paid
 * service was introduced (per explicit instruction).
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

// knownGoodBaseline.js (lazy-required by buildAlertPayload) hits db/client
// and serviceInventory — stub db/client only; serviceInventory is real data
// (pure), no need to stub it.
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: async () => ({ rows: [] }) },
};

delete require.cache[require.resolve('../lib/monitoring/alertDispatcher')];
const { dispatchMonitoringAlert, sanitize } = require('../lib/monitoring/alertDispatcher');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

test('sanitize() stays pure/DB-free (no behavior change)', () => {
  assert.strictEqual(sanitize('Bearer abc123'), 'Bearer [REDACTED]');
});

test('dispatchMonitoringAlert: MONITOR_ALERT_EMAIL_TO critical path calls the REAL emailService.send (not the nonexistent sendEmail), with htmlBody and idempotencyKey', async () => {
  const calls = [];
  const restoreEmail = stub('../lib/emailService', {
    send: async (args) => { calls.push(args); return { ok: true }; },
  });
  // No staff recipients configured for this test -> the additive staff path no-ops.
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => [] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (c) => c,
  });
  try {
    await withEnv({ MONITOR_ALERT_EMAIL_TO: 'oncall@example.com', ALERT_SLACK_WEBHOOK_URL: undefined }, async () => {
      await dispatchMonitoringAlert({ serviceId: 'qb-proxy-server', level: 'critical', errorSummary: 'boom' });
    });
    assert.strictEqual(calls.length, 1, 'emailService.send must actually be called — this is exactly what silently failed before the fix');
    assert.strictEqual(calls[0].to, 'oncall@example.com');
    assert.ok(calls[0].htmlBody && calls[0].htmlBody.includes('boom'), 'htmlBody must be a real, non-empty field (the old code passed "body", which send() does not accept)');
    assert.ok(calls[0].idempotencyKey, 'idempotencyKey is required by emailService.send and must be supplied');
    assert.match(calls[0].subject, /CRITICAL/);
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('dispatchMonitoringAlert: a warning-level alert reaches staff via notificationPreferences.SYSTEM_FAILURE, even though MONITOR_ALERT_EMAIL_TO (critical-only) does not fire', async () => {
  const calls = [];
  const restoreEmail = stub('../lib/emailService', {
    send: async (args) => { calls.push(args); return { ok: true }; },
  });
  const restoreRecipients = stub('../lib/notificationRecipients', {
    getAllStaffRecipients: async () => ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'],
  });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    // Michelle's real seeded single-category policy: excluded from SYSTEM_FAILURE.
    filterRecipientsForCategory: async (candidates) => candidates.filter((e) => e.toLowerCase() !== 'michelle@ecconstructiongroup.com'),
  });
  try {
    await withEnv({ MONITOR_ALERT_EMAIL_TO: undefined, ALERT_SLACK_WEBHOOK_URL: undefined }, async () => {
      await dispatchMonitoringAlert({ serviceId: 'handoff-integration', level: 'warning', errorSummary: 'Handoff not connected' });
    });
    assert.strictEqual(calls.length, 1, 'a warning-level alert must still reach staff — this path never existed before the fix');
    assert.deepStrictEqual(calls[0].to, ['yaron@ecconstructiongroup.com'], 'Michelle must be excluded via the same existing mechanism as every other staff broadcast');
    assert.match(calls[0].subject, /WARNING/);
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('dispatchMonitoringAlert: an info-level RECOVERY alert also reaches staff (verifies recovery notifications are not silently dropped)', async () => {
  const calls = [];
  const restoreEmail = stub('../lib/emailService', {
    send: async (args) => { calls.push(args); return { ok: true }; },
  });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (c) => c,
  });
  try {
    await withEnv({ MONITOR_ALERT_EMAIL_TO: undefined, ALERT_SLACK_WEBHOOK_URL: undefined }, async () => {
      await dispatchMonitoringAlert({ serviceId: 'qb-proxy-server', level: 'info', errorSummary: 'Service recovered — incident resolved' });
    });
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].subject, /RECOVERED/);
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('dispatchMonitoringAlert: zero staff recipients after filtering -> no email attempted, never throws', async () => {
  const calls = [];
  const restoreEmail = stub('../lib/emailService', { send: async (args) => { calls.push(args); } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['michelle@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async () => [],
  });
  try {
    await withEnv({ MONITOR_ALERT_EMAIL_TO: undefined, ALERT_SLACK_WEBHOOK_URL: undefined }, async () => {
      const result = await dispatchMonitoringAlert({ serviceId: 'qb-proxy-server', level: 'warning', errorSummary: 'x' });
      assert.ok(result);
    });
    assert.strictEqual(calls.length, 0);
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

test('dispatchMonitoringAlert: a staff-email failure is non-fatal — the function still returns the payload', async () => {
  const restoreEmail = stub('../lib/emailService', { send: async () => { throw new Error('smtp down'); } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (c) => c,
  });
  try {
    await withEnv({ MONITOR_ALERT_EMAIL_TO: undefined, ALERT_SLACK_WEBHOOK_URL: undefined }, async () => {
      const result = await dispatchMonitoringAlert({ serviceId: 'qb-proxy-server', level: 'critical', errorSummary: 'x' });
      assert.strictEqual(result.SERVICE_ID, 'qb-proxy-server');
    });
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});
