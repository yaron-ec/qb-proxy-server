/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupReplyNotify.test.js — pure unit coverage (no DB, no real
 * email) for lib/estimateFollowupReplyNotify.js: mirrors lib/smsReplyNotify.js's
 * own test conventions. Proves: the decoupled notifications-enabled gate,
 * the real-owner-via-FK resolution (never a heuristic), the staff-broadcast
 * fallback when no owner is assigned, and that this module is EMAIL ONLY —
 * it never references any SMS/Twilio mechanism.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshModule() {
  delete require.cache[require.resolve('../lib/estimateFollowupReplyNotify')];
  return require('../lib/estimateFollowupReplyNotify');
}

test('replyNotificationsEnabled reflects ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED exactly', () => {
  const prev = process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED;
  try {
    delete process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED;
    assert.strictEqual(freshModule().replyNotificationsEnabled(), false);
    process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
    assert.strictEqual(freshModule().replyNotificationsEnabled(), true);
    process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'false';
    assert.strictEqual(freshModule().replyNotificationsEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED;
    else process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = prev;
  }
});

test('notifyReplyDetected is a no-op when the gate is disabled — never calls db or email', async () => {
  delete process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED;
  let dbCalled = false, emailCalled = false;
  const restoreDb = stub('../db/client', { query: async () => { dbCalled = true; return { rows: [] }; } });
  const restoreEmail = stub('../lib/emailService', { send: async () => { emailCalled = true; } });
  try {
    const m = freshModule();
    const result = await m.notifyReplyDetected({ sequence: { lead_id: 'lead-1' }, fromAddr: 'a@x.com', subject: 's', messageId: 'm1' });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'reply_notifications_disabled');
    assert.strictEqual(dbCalled, false);
    assert.strictEqual(emailCalled, false);
  } finally { restoreDb(); restoreEmail(); }
});

test('notifyReplyDetected: an assigned owner is emailed directly, never category-filtered', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
  const sent = [];
  const restoreDb = stub('../db/client', {
    query: async () => ({ rows: [{ id: 'lead-1', first_name: 'Jane', last_name: 'Doe', owner_email: 'rep@example.com', owner_name: 'Rep Name' }] }),
  });
  const restoreEmail = stub('../lib/emailService', { send: async (msg) => { sent.push(msg); return { gmailMessageId: 'gm-1' }; } });
  try {
    const m = freshModule();
    const result = await m.notifyReplyDetected({ sequence: { lead_id: 'lead-1' }, fromAddr: 'jane@example.com', subject: 'Re: your estimate', messageId: 'msg-abc' });
    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.to, 'rep@example.com');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'rep@example.com');
    assert.ok(sent[0].subject.includes('Jane Doe'));
    assert.strictEqual(sent[0].idempotencyKey, 'estimate-followup-reply-notify:msg-abc');
  } finally { restoreDb(); restoreEmail(); process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'false'; }
});

test('notifyReplyDetected: no owner assigned broadcasts to staff via the ACTIVITY category, never silently drops', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
  const sent = [];
  const restoreDb = stub('../db/client', {
    query: async () => ({ rows: [{ id: 'lead-1', first_name: 'Jane', last_name: 'Doe', owner_email: null, owner_name: null }] }),
  });
  const restoreEmail = stub('../lib/emailService', { send: async (msg) => { sent.push(msg); return { gmailMessageId: 'gm-1' }; } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['staffA@example.com', 'staffB@example.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { ACTIVITY: 'activity' },
    filterRecipientsForCategory: async (candidates, category) => {
      assert.strictEqual(category, 'activity');
      return candidates.filter((c) => c !== 'staffB@example.com'); // simulate staffB having disabled it
    },
  });
  try {
    const m = freshModule();
    const result = await m.notifyReplyDetected({ sequence: { lead_id: 'lead-1' }, fromAddr: 'jane@example.com', subject: 'Re: your estimate', messageId: 'msg-xyz' });
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'staffA@example.com');
  } finally { restoreDb(); restoreEmail(); restoreRecipients(); restorePrefs(); process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'false'; }
});

test('notifyReplyDetected: zero staff recipients after filtering never attempts a send', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
  let emailCalled = false;
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [{ id: 'lead-1', first_name: 'Jane', owner_email: null }] }) });
  const restoreEmail = stub('../lib/emailService', { send: async () => { emailCalled = true; } });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => [] });
  const restorePrefs = stub('../lib/notificationPreferences', { CATEGORIES: { ACTIVITY: 'activity' }, filterRecipientsForCategory: async () => [] });
  try {
    const m = freshModule();
    const result = await m.notifyReplyDetected({ sequence: { lead_id: 'lead-1' }, fromAddr: 'jane@example.com', subject: 's', messageId: 'm2' });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'no_staff_recipients');
    assert.strictEqual(emailCalled, false);
  } finally { restoreDb(); restoreEmail(); restoreRecipients(); restorePrefs(); process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'false'; }
});

test('notifyReplyDetected: a missing/not-found lead never throws, reports a reason', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [] }) });
  try {
    const m = freshModule();
    const result = await m.notifyReplyDetected({ sequence: { lead_id: 'nonexistent' }, fromAddr: 'a@x.com', subject: 's', messageId: 'm3' });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'lead_not_found');
  } finally { restoreDb(); process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'false'; }
});

test('notifyReplyDetected: a db failure is caught and reported, never thrown', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
  const restoreDb = stub('../db/client', { query: async () => { throw new Error('connection reset'); } });
  try {
    const m = freshModule();
    const result = await m.notifyReplyDetected({ sequence: { lead_id: 'lead-1' }, fromAddr: 'a@x.com', subject: 's', messageId: 'm4' });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'connection reset');
  } finally { restoreDb(); process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'false'; }
});

test('source-level guard: lib/estimateFollowupReplyNotify.js references no SMS/Twilio mechanism — email only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'estimateFollowupReplyNotify.js'), 'utf8');
  assert.doesNotMatch(src, /twilio|smsClient|smsService|SMS_REPLY_FORWARD_TO/i);
});
