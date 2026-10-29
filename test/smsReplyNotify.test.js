/* eslint-disable no-undef */
'use strict';

/**
 * smsReplyNotify.test.js — EMAIL notification on an inbound customer SMS
 * reply (lib/smsReplyNotify.js: notifyAssignedRep / notifyUnmatchedForReview),
 * gated on its OWN SMS_REPLY_NOTIFICATIONS_ENABLED switch — deliberately
 * decoupled from SMS_AUTOMATED_REMINDERS_ENABLED (confirmation/reminder
 * sends) so testing or enabling one can never silently arm the other; see
 * the "decoupled gate" test below.
 *
 * November 2026 — the prior SMS-to-Yaron forward (forwardToYaronBestEffort)
 * has been RETIRED per a revised notification-design decision: inbound
 * replies now notify exclusively through the CRM's existing email
 * notification infrastructure, never a second outbound Twilio SMS. Its
 * tests (including the destination/sender loop guard) were removed along
 * with the function itself in lib/smsReplyNotify.js.
 */
const test = require('node:test');
const assert = require('node:assert');

let queryImpl = async () => { throw new Error('unexpected query in test'); };
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (...a) => queryImpl(...a) } };

delete require.cache[require.resolve('../lib/smsReplyNotify')];
const smsReplyNotify = require('../lib/smsReplyNotify');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

test('reply notifications disabled (SMS_REPLY_NOTIFICATIONS_ENABLED unset) -> notifyAssignedRep is a no-op', async () => {
  delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED;
  const res = await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM1' });
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'reply_notifications_disabled');
});

test('decoupled gate: SMS_AUTOMATED_REMINDERS_ENABLED=true alone does NOT enable reply notifications (this is a SEPARATE switch — the two must never be coupled again)', async () => {
  delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED;
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    const rep = await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM1' });
    assert.strictEqual(rep.sent, false);
    assert.strictEqual(rep.reason, 'reply_notifications_disabled');
  } finally {
    delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  }
});

test('forwardToYaronBestEffort no longer exists — the SMS-to-Yaron forward is retired, never re-exported', () => {
  assert.strictEqual(smsReplyNotify.forwardToYaronBestEffort, undefined);
});

test('decoupled gate: SMS_REPLY_NOTIFICATIONS_ENABLED=true alone (reminders switch untouched) is sufficient to enable notifyAssignedRep', async () => {
  delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [{ id: 'lead-1', first_name: 'Sarah', owner_email: 'mike@x.com', owner_name: 'Mike' }] });
  const restore = stub('../lib/emailService', { send: async () => ({ gmailMessageId: 'g1' }) });
  try {
    const res = await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM1' });
    assert.strictEqual(res.sent, true);
  } finally { restore(); delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; }
});

test('notifyAssignedRep: resolves the REAL owner via the owners FK join, never a guessed email', async () => {
  process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async (sql, params) => {
    assert.match(sql, /LEFT JOIN owners/);
    assert.strictEqual(params[0], 'lead-1');
    return { rows: [{ id: 'lead-1', first_name: 'Sarah', last_name: 'Martinez', owner_email: 'mike@ecconstructiongroup.com', owner_name: 'Mike' }] };
  };
  let sentTo = null, sentBody = null;
  const restore = stub('../lib/emailService', {
    send: async ({ to, htmlBody }) => { sentTo = to; sentBody = htmlBody; return { gmailMessageId: 'g1' }; },
  });
  try {
    const res = await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'Can we move to 3pm?', messageSid: 'SM1' });
    assert.strictEqual(res.sent, true);
    assert.strictEqual(sentTo, 'mike@ecconstructiongroup.com');
    assert.match(sentBody, /Sarah Martinez/);
    assert.match(sentBody, /Can we move to 3pm\?/);
  } finally { restore(); delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; }
});

test('notifyAssignedRep: the "Open this lead" link is ALWAYS a valid absolute URL, regardless of CRM_PUBLIC_URL and regardless of the deprecated crmPublicUrl argument (November 2026 malformed-link incident, lib/crmUrl.js)', async () => {
  process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';
  delete process.env.CRM_PUBLIC_URL;
  queryImpl = async () => ({ rows: [{ id: 'lead-9', first_name: 'Sarah', last_name: 'Martinez', owner_email: 'mike@ecconstructiongroup.com', owner_name: 'Mike' }] });
  let sentBody = null;
  const restore = stub('../lib/emailService', {
    send: async ({ htmlBody }) => { sentBody = htmlBody; return { gmailMessageId: 'g1' }; },
  });
  try {
    // Pass the OLD unsafe empty-string shape that used to omit the link
    // entirely — must now still produce a real, absolute link.
    await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-9', body: 'hi', messageSid: 'SM1', crmPublicUrl: '' });
    assert.match(sentBody, /href="https:\/\/crm\.ecconstructiongroup\.com\/leads\/lead-9"/);
    assert.doesNotMatch(sentBody, /href="http:\/\/\//, 'must never be scheme + empty host');
  } finally { restore(); delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; }
});

test('notifyAssignedRep: lead has no owner assigned -> no-op, never invents a recipient', async () => {
  process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [{ id: 'lead-1', first_name: 'Sarah', owner_email: null, owner_name: null }] });
  try {
    const res = await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM1' });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'no_owner_assigned');
  } finally { delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; }
});

test('notifyAssignedRep: idempotency key is derived from the Twilio MessageSid (a webhook retry reuses the same key)', async () => {
  process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [{ id: 'lead-1', first_name: 'Sarah', owner_email: 'mike@x.com', owner_name: 'Mike' }] });
  let capturedKey = null;
  const restore = stub('../lib/emailService', {
    send: async ({ idempotencyKey }) => { capturedKey = idempotencyKey; return { gmailMessageId: 'g1' }; },
  });
  try {
    await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM-UNIQUE-1' });
    assert.strictEqual(capturedKey, 'sms-inbound-notify-rep:SM-UNIQUE-1');
  } finally { restore(); delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; }
});

test('notifyUnmatchedForReview: routed through the "activity" notification category (so Michelle\'s single-category policy correctly excludes her via the existing mechanism)', async () => {
  process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';
  let filteredCategory = null;
  const restoreRecipients = stub('../lib/notificationRecipients', {
    getAllStaffRecipients: async () => ['mike@x.com', 'michelle@x.com'],
  });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { ACTIVITY: 'activity' },
    filterRecipientsForCategory: async (list, category) => { filteredCategory = category; return list.filter((e) => e !== 'michelle@x.com'); },
  });
  const sentTo = [];
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ to }) => { sentTo.push(to); return { gmailMessageId: 'g1' }; },
  });
  try {
    const res = await smsReplyNotify.notifyUnmatchedForReview({ body: 'hi', messageSid: 'SM1', fromNumber: '+15551234567', ambiguous: false });
    assert.strictEqual(filteredCategory, 'activity');
    assert.strictEqual(res.sent, true);
    assert.deepStrictEqual(sentTo, ['mike@x.com']);
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED; }
});

