/* eslint-disable no-undef */
'use strict';

/**
 * smsReplyNotify.test.js — rep notification + the mandatory Yaron SMS
 * forward on an inbound customer reply (lib/smsReplyNotify.js).
 *
 * The highest-stakes case here is the Yaron-forward loop guard: this
 * codebase already hardcodes "(310) 310-4108" in several customer-facing
 * email templates as EC's PUBLISHED OFFICE NUMBER (lib/reminderEngine.js,
 * lib/actionRouter.js, lib/phoneCallReminders.js) — NOT confirmed to be
 * Yaron's own SMS-capable phone, and NOT confirmed to differ from whatever
 * TWILIO_FROM is configured to in production. These tests prove the guard
 * actually refuses to forward when the configured destination matches the
 * outbound sender number, rather than assuming the operator got it right.
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

test('automation disabled (SMS_AUTOMATED_REMINDERS_ENABLED unset) -> notifyAssignedRep is a no-op', async () => {
  delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  const res = await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM1' });
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'automation_disabled');
});

test('notifyAssignedRep: resolves the REAL owner via the owners FK join, never a guessed email', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
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
  } finally { restore(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('notifyAssignedRep: lead has no owner assigned -> no-op, never invents a recipient', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [{ id: 'lead-1', first_name: 'Sarah', owner_email: null, owner_name: null }] });
  try {
    const res = await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM1' });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'no_owner_assigned');
  } finally { delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('notifyAssignedRep: idempotency key is derived from the Twilio MessageSid (a webhook retry reuses the same key)', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [{ id: 'lead-1', first_name: 'Sarah', owner_email: 'mike@x.com', owner_name: 'Mike' }] });
  let capturedKey = null;
  const restore = stub('../lib/emailService', {
    send: async ({ idempotencyKey }) => { capturedKey = idempotencyKey; return { gmailMessageId: 'g1' }; },
  });
  try {
    await smsReplyNotify.notifyAssignedRep({ leadId: 'lead-1', body: 'hi', messageSid: 'SM-UNIQUE-1' });
    assert.strictEqual(capturedKey, 'sms-inbound-notify-rep:SM-UNIQUE-1');
  } finally { restore(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('notifyUnmatchedForReview: routed through the "activity" notification category (so Michelle\'s single-category policy correctly excludes her via the existing mechanism)', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
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
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

// ── Yaron forward: the mandatory, safety-critical piece ────────────────────
test('forwardToYaronBestEffort: SMS_REPLY_FORWARD_TO unset -> refuses, never a hardcoded fallback destination', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  delete process.env.SMS_REPLY_FORWARD_TO;
  const res = await smsReplyNotify.forwardToYaronBestEffort({ customerName: 'Sarah', repName: 'Mike', body: 'hi' });
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'not_configured');
  delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
});

test('forwardToYaronBestEffort: LOOP GUARD — refuses when the destination matches the outbound customer-SMS sender number', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  process.env.SMS_REPLY_FORWARD_TO = '+13103104108';
  const restore = stub('../lib/smsClient', {
    getCredentials: () => ({ from: '+13103104108', messagingServiceSid: null }),
    sendMessage: async () => { throw new Error('must never be called — loop guard should refuse first'); },
  });
  try {
    const res = await smsReplyNotify.forwardToYaronBestEffort({ customerName: 'Sarah', repName: 'Mike', body: 'hi' });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'destination_equals_sender');
  } finally { restore(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; delete process.env.SMS_REPLY_FORWARD_TO; }
});

test('forwardToYaronBestEffort: a genuinely different destination number sends successfully with the mandated message shape', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  process.env.SMS_REPLY_FORWARD_TO = '+13105551234';
  let sentArgs = null;
  const restore = stub('../lib/smsClient', {
    getCredentials: () => ({ from: '+13103104108', messagingServiceSid: null }),
    sendMessage: async (args) => { sentArgs = args; return { ok: true, sid: 'SM-forward-1' }; },
  });
  try {
    const res = await smsReplyNotify.forwardToYaronBestEffort({ customerName: 'Sarah Martinez', repName: 'Mike', body: 'Can we move our appointment to 3 PM?' });
    assert.strictEqual(res.sent, true);
    assert.strictEqual(sentArgs.to, '+13105551234');
    assert.match(sentArgs.body, /EC CRM — New Customer Reply/);
    assert.match(sentArgs.body, /Customer: Sarah Martinez/);
    assert.match(sentArgs.body, /Sales Rep: Mike/);
    assert.match(sentArgs.body, /Message: Can we move our appointment to 3 PM\?/);
  } finally { restore(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; delete process.env.SMS_REPLY_FORWARD_TO; }
});

test('forwardToYaronBestEffort: unknown rep -> "Unassigned", never an invented name', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  process.env.SMS_REPLY_FORWARD_TO = '+13105551234';
  let sentArgs = null;
  const restore = stub('../lib/smsClient', {
    getCredentials: () => ({ from: '+13103104108', messagingServiceSid: null }),
    sendMessage: async (args) => { sentArgs = args; return { ok: true, sid: 'SM1' }; },
  });
  try {
    await smsReplyNotify.forwardToYaronBestEffort({ customerName: null, repName: null, body: 'hi' });
    assert.match(sentArgs.body, /Sales Rep: Unassigned/);
    assert.match(sentArgs.body, /Customer: Unknown/);
  } finally { restore(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; delete process.env.SMS_REPLY_FORWARD_TO; }
});

test('forwardToYaronBestEffort: a Twilio-level rejection is reported, never thrown', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  process.env.SMS_REPLY_FORWARD_TO = '+13105551234';
  const restore = stub('../lib/smsClient', {
    getCredentials: () => ({ from: '+13103104108', messagingServiceSid: null }),
    sendMessage: async () => ({ ok: false, errorMessage: 'invalid number' }),
  });
  try {
    const res = await smsReplyNotify.forwardToYaronBestEffort({ customerName: 'Sarah', repName: 'Mike', body: 'hi' });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'invalid number');
  } finally { restore(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; delete process.env.SMS_REPLY_FORWARD_TO; }
});
