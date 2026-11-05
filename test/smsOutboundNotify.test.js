/* eslint-disable no-undef */
'use strict';

/**
 * smsOutboundNotify.test.js — EMAIL notifications for OUTBOUND customer SMS
 * (lib/smsOutboundNotify.js: notifySmsSent / notifySmsDeliveryFailure),
 * built November 2026 after a production incident (lead Manuel Manalo —
 * two automated reminder SMS sends failed delivery with Twilio error 30006
 * and no admin was ever notified).
 *
 * Each function is gated by its OWN independent switch
 * (SMS_SENT_NOTIFICATIONS_ENABLED / SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED)
 * — deliberately decoupled from each other and from every other SMS kill
 * switch, mirroring lib/smsReplyNotify.js's established "decoupled gate"
 * convention (see its own test file for the identical pattern).
 */
const test = require('node:test');
const assert = require('node:assert');

let queryImpl = async () => { throw new Error('unexpected query in test'); };
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (...a) => queryImpl(...a) } };

delete require.cache[require.resolve('../lib/smsOutboundNotify')];
const smsOutboundNotify = require('../lib/smsOutboundNotify');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function leadRow(overrides = {}) {
  return { first_name: 'Manuel', last_name: 'Manalo', ...overrides };
}

// ── smsAuthorLabel ──────────────────────────────────────────────────────

test('smsAuthorLabel: mirrors crm-frontend/src/lib/smsActivityAdapter.js#smsAuthorLabel exactly for every known sent_by shape', () => {
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel(null), 'System');
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel('system:booking_confirmation'), 'Automated — Booking Confirmation');
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel('system:reminder_12h'), 'Automated — 12h Reminder');
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel('system:reminder_12h_deferred'), 'Automated — 12h Reminder (deferred)');
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel('system:reminder_2h'), 'Automated — 2h Reminder');
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel('system:reminder_2h_deferred'), 'Automated — 2h Reminder (deferred)');
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel('system:something_else'), 'Automated');
  assert.strictEqual(smsOutboundNotify.smsAuthorLabel('rep@ecconstructiongroup.com'), 'rep@ecconstructiongroup.com');
});

// ── notifySmsSent ────────────────────────────────────────────────────────

test('notifySmsSent: disabled by default (SMS_SENT_NOTIFICATIONS_ENABLED unset) -> no-op', async () => {
  delete process.env.SMS_SENT_NOTIFICATIONS_ENABLED;
  const res = await smsOutboundNotify.notifySmsSent({ leadId: 'lead-1', messageRow: { id: 'm1', twilio_sid: 'SM1', status: 'queued', sent_by: 'rep@x.com', created_at: new Date() } });
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'sms_sent_notifications_disabled');
});

test('decoupled gate: SMS_AUTOMATED_REMINDERS_ENABLED=true alone does NOT enable the sent notification', async () => {
  delete process.env.SMS_SENT_NOTIFICATIONS_ENABLED;
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    const res = await smsOutboundNotify.notifySmsSent({ leadId: 'lead-1', messageRow: { id: 'm1', twilio_sid: 'SM1', status: 'queued' } });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'sms_sent_notifications_disabled');
  } finally { delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('notifySmsSent: enabled -> emails staff filtered through CATEGORIES.SMS_SENT, body describes acceptance not delivery', async () => {
  process.env.SMS_SENT_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [leadRow()] });
  let filteredCategory = null;
  const restoreRecipients = stub('../lib/notificationRecipients', {
    getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com', 'michelle@ecconstructiongroup.com'],
  });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SMS_SENT: 'sms_sent', SMS_DELIVERY_FAILURE: 'sms_delivery_failure' },
    filterRecipientsForCategory: async (list, category) => { filteredCategory = category; return list.filter((e) => e !== 'michelle@ecconstructiongroup.com'); },
  });
  const sentTo = [];
  let sentBody = null;
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ to, htmlBody }) => { sentTo.push(to); sentBody = htmlBody; return { gmailMessageId: 'g1' }; },
  });
  try {
    const res = await smsOutboundNotify.notifySmsSent({
      leadId: 'lead-1',
      messageRow: { id: 'm1', twilio_sid: 'SM-UNIQUE-1', status: 'queued', sent_by: 'system:reminder_12h', created_at: new Date('2026-11-05T08:02:00Z') },
    });
    assert.strictEqual(filteredCategory, 'sms_sent');
    assert.strictEqual(res.sent, true);
    assert.deepStrictEqual(sentTo, ['yaron@ecconstructiongroup.com']);
    assert.match(sentBody, /Manuel Manalo/);
    assert.match(sentBody, /accepted by Twilio for sending/i);
    assert.doesNotMatch(sentBody, /was delivered/i);
    assert.match(sentBody, /Automated — 12h Reminder/);
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_SENT_NOTIFICATIONS_ENABLED; }
});

test('notifySmsSent: idempotency key is derived from the Twilio SID, per recipient (a duplicate call for the same message never double-sends)', async () => {
  process.env.SMS_SENT_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [leadRow()] });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SMS_SENT: 'sms_sent' },
    filterRecipientsForCategory: async (list) => list,
  });
  let capturedKey = null;
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ idempotencyKey }) => { capturedKey = idempotencyKey; return { gmailMessageId: 'g1' }; },
  });
  try {
    await smsOutboundNotify.notifySmsSent({ leadId: 'lead-1', messageRow: { id: 'm1', twilio_sid: 'SM-UNIQUE-2', status: 'queued' } });
    assert.strictEqual(capturedKey, 'sms-sent-notify:SM-UNIQUE-2:yaron@ecconstructiongroup.com');
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_SENT_NOTIFICATIONS_ENABLED; }
});

test('notifySmsSent: lead not found -> no-op, never guesses a name', async () => {
  process.env.SMS_SENT_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [] });
  try {
    const res = await smsOutboundNotify.notifySmsSent({ leadId: 'missing', messageRow: { id: 'm1', twilio_sid: 'SM1', status: 'queued' } });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'lead_not_found');
  } finally { delete process.env.SMS_SENT_NOTIFICATIONS_ENABLED; }
});

test('notifySmsSent: never throws, even when emailService.send rejects', async () => {
  process.env.SMS_SENT_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [leadRow()] });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', { CATEGORIES: { SMS_SENT: 'sms_sent' }, filterRecipientsForCategory: async (list) => list });
  const restoreEmail = stub('../lib/emailService', { send: async () => { throw new Error('gmail down'); } });
  try {
    const res = await smsOutboundNotify.notifySmsSent({ leadId: 'lead-1', messageRow: { id: 'm1', twilio_sid: 'SM1', status: 'queued' } });
    assert.strictEqual(res.sent, false);
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_SENT_NOTIFICATIONS_ENABLED; }
});

// ── notifySmsDeliveryFailure ─────────────────────────────────────────────

test('notifySmsDeliveryFailure: disabled by default -> no-op', async () => {
  delete process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED;
  const res = await smsOutboundNotify.notifySmsDeliveryFailure({ messageRow: { id: 'm1', lead_id: 'lead-1', twilio_sid: 'SM1', status: 'failed', error_code: '30006' } });
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'sms_delivery_failure_notifications_disabled');
});

test('decoupled gate: SMS_SENT_NOTIFICATIONS_ENABLED=true alone does NOT enable the delivery-failure alert', async () => {
  delete process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED;
  process.env.SMS_SENT_NOTIFICATIONS_ENABLED = 'true';
  try {
    const res = await smsOutboundNotify.notifySmsDeliveryFailure({ messageRow: { id: 'm1', lead_id: 'lead-1', twilio_sid: 'SM1', status: 'failed' } });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'sms_delivery_failure_notifications_disabled');
  } finally { delete process.env.SMS_SENT_NOTIFICATIONS_ENABLED; }
});

test('notifySmsDeliveryFailure: enabled -> emails staff filtered through CATEGORIES.SMS_DELIVERY_FAILURE, includes error code/message type/status, never auto-resends', async () => {
  process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [leadRow()] });
  let filteredCategory = null;
  const restoreRecipients = stub('../lib/notificationRecipients', {
    getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com', 'michelle@ecconstructiongroup.com'],
  });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { SMS_DELIVERY_FAILURE: 'sms_delivery_failure' },
    filterRecipientsForCategory: async (list, category) => { filteredCategory = category; return list.filter((e) => e !== 'michelle@ecconstructiongroup.com'); },
  });
  const sentTo = [];
  let sentBody = null;
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ to, htmlBody }) => { sentTo.push(to); sentBody = htmlBody; return { gmailMessageId: 'g1' }; },
  });
  try {
    const res = await smsOutboundNotify.notifySmsDeliveryFailure({
      messageRow: { id: 'm1', lead_id: 'lead-1', twilio_sid: 'SM-FAIL-1', status: 'failed', error_code: '30006', error_message: 'Landline or unreachable carrier', sent_by: 'system:reminder_12h' },
    });
    assert.strictEqual(filteredCategory, 'sms_delivery_failure');
    assert.strictEqual(res.sent, true);
    assert.deepStrictEqual(sentTo, ['yaron@ecconstructiongroup.com']);
    assert.match(sentBody, /30006/);
    assert.match(sentBody, /Automated — 12h Reminder/);
    assert.match(sentBody, /failed/i);
    assert.match(sentBody, /not.*automatically resent/i);
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED; }
});

test('notifySmsDeliveryFailure: idempotency key is derived from the Twilio SID, per recipient', async () => {
  process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [leadRow()] });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', { CATEGORIES: { SMS_DELIVERY_FAILURE: 'sms_delivery_failure' }, filterRecipientsForCategory: async (list) => list });
  let capturedKey = null;
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ idempotencyKey }) => { capturedKey = idempotencyKey; return { gmailMessageId: 'g1' }; },
  });
  try {
    await smsOutboundNotify.notifySmsDeliveryFailure({ messageRow: { id: 'm1', lead_id: 'lead-1', twilio_sid: 'SM-FAIL-2', status: 'undelivered' } });
    assert.strictEqual(capturedKey, 'sms-delivery-failure-notify:SM-FAIL-2:yaron@ecconstructiongroup.com');
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED; }
});

test('notifySmsDeliveryFailure: never throws, even when emailService.send rejects', async () => {
  process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED = 'true';
  queryImpl = async () => ({ rows: [leadRow()] });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => ['yaron@ecconstructiongroup.com'] });
  const restorePrefs = stub('../lib/notificationPreferences', { CATEGORIES: { SMS_DELIVERY_FAILURE: 'sms_delivery_failure' }, filterRecipientsForCategory: async (list) => list });
  const restoreEmail = stub('../lib/emailService', { send: async () => { throw new Error('gmail down'); } });
  try {
    const res = await smsOutboundNotify.notifySmsDeliveryFailure({ messageRow: { id: 'm1', lead_id: 'lead-1', twilio_sid: 'SM1', status: 'failed' } });
    assert.strictEqual(res.sent, false);
  } finally { restoreRecipients(); restorePrefs(); restoreEmail(); delete process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED; }
});

// ── source-level wiring ──────────────────────────────────────────────────

test('source-level: lib/smsService.js#sendSms calls notifySmsSent only after a successful Twilio accept (after the result.ok check), never before', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../lib/smsService.js'), 'utf8');
  const okCheckIdx = source.indexOf(`if (!result.ok) throw Object.assign(new SmsError('twilio_rejected'`);
  const notifyIdx = source.indexOf("require('./smsOutboundNotify').notifySmsSent");
  assert.ok(okCheckIdx > -1, 'expected the twilio_rejected guard to still exist');
  assert.ok(notifyIdx > okCheckIdx, 'notifySmsSent must be called after the result.ok check, never before');
});

test('source-level: lib/smsService.js#handleStatusCallback only calls notifySmsDeliveryFailure on a genuine new transition into a terminal failure status', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../lib/smsService.js'), 'utf8');
  assert.match(source, /wasAlreadyFailed\s*=\s*TERMINAL_FAILURE_STATUSES\.has\(existing\.status\)/);
  assert.match(source, /isNowFailed\s*=\s*!!finalStatus\s*&&\s*TERMINAL_FAILURE_STATUSES\.has\(finalStatus\)/);
  assert.match(source, /if\s*\(updated\s*&&\s*!wasAlreadyFailed\s*&&\s*isNowFailed\)/);
});
