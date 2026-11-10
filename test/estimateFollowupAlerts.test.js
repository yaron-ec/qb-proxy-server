/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupAlerts.test.js — pure unit coverage (no DB, no real
 * email) for lib/estimateFollowupAlerts.js: proves it only ever fires for a
 * genuine failure or config-blocked tick ("no noise for ordinary
 * non-eligible leads"), reuses the SYSTEM_FAILURE staff-broadcast category,
 * and never throws back into a caller's tick.
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

function freshModule() {
  delete require.cache[require.resolve('../lib/estimateFollowupAlerts')];
  return require('../lib/estimateFollowupAlerts');
}

test('notifyAutomationFailures: an ordinary tick (no failures, not config-blocked) never sends anything', async () => {
  let sendCalled = false;
  const restoreEmail = stub('../lib/emailService', { send: async () => { sendCalled = true; } });
  try {
    const m = freshModule();
    const result = await m.notifyAutomationFailures({ processed: 5, sent: 5, skipped: 0, failed: 0, configBlocked: false });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'nothing_to_report');
    assert.strictEqual(sendCalled, false);
  } finally { restoreEmail(); }
});

test('notifyAutomationFailures: fires exactly once when failed > 0, to the SYSTEM_FAILURE-filtered staff list', async () => {
  const sent = [];
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['admin@example.com', 'michelle@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (candidates, category) => {
      assert.strictEqual(category, 'system_failure');
      return candidates.filter((c) => c !== 'michelle@ecconstructiongroup.com');
    },
  });
  const restoreEmail = stub('../lib/emailService', { send: async (opts) => { sent.push(opts); } });
  try {
    const m = freshModule();
    const result = await m.notifyAutomationFailures({ processed: 10, sent: 7, failed: 3, configBlocked: false, errors: ['lead x step 2: boom'] });
    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.recipients, 1);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].to, ['admin@example.com']);
    assert.match(sent[0].subject, /FAILURES/);
    assert.match(sent[0].subject, /3 failed/);
    assert.ok(sent[0].idempotencyKey.startsWith('estimate-followup-alert:'));
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); }
});

test('notifyAutomationFailures: fires for a configBlocked tick even with zero failed steps', async () => {
  const sent = [];
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['admin@example.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async (candidates) => candidates,
  });
  const restoreEmail = stub('../lib/emailService', { send: async (opts) => { sent.push(opts); } });
  try {
    const m = freshModule();
    const result = await m.notifyAutomationFailures({ processed: 0, sent: 0, failed: 0, configBlocked: true, configBlockedReason: 'no business address configured' });
    assert.strictEqual(result.sent, true);
    assert.match(sent[0].subject, /BLOCKED/);
    assert.match(sent[0].htmlBody, /no business address configured/);
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); }
});

test('notifyAutomationFailures: zero recipients after category filtering (e.g. everyone opted out) -> no send, no throw', async () => {
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['michelle@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SYSTEM_FAILURE: 'system_failure' },
    filterRecipientsForCategory: async () => [],
  });
  let sendCalled = false;
  const restoreEmail = stub('../lib/emailService', { send: async () => { sendCalled = true; } });
  try {
    const m = freshModule();
    const result = await m.notifyAutomationFailures({ failed: 2 });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'no_recipients');
    assert.strictEqual(sendCalled, false);
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); }
});

test('notifyAutomationFailures: a thrown error anywhere in the path is swallowed — never throws back to the caller', async () => {
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => { throw new Error('db down'); } });
  try {
    const m = freshModule();
    const result = await m.notifyAutomationFailures({ failed: 1 });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'send_failed');
    assert.match(result.error, /db down/);
  } finally { restoreRecipients(); }
});

test('notifyAutomationFailures: null/undefined summary never sends', async () => {
  const m = freshModule();
  assert.deepStrictEqual(await m.notifyAutomationFailures(null), { sent: false, reason: 'nothing_to_report' });
  assert.deepStrictEqual(await m.notifyAutomationFailures(undefined), { sent: false, reason: 'nothing_to_report' });
});
