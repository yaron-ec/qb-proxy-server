/* eslint-disable no-undef */
'use strict';

/**
 * smsOutboundNotify.int.test.js — REAL-Postgres, end-to-end proof of the
 * November 2026 outbound-SMS-visibility work (lib/smsOutboundNotify.js),
 * built after a production incident where two automated reminder SMS sends
 * to lead Manuel Manalo failed delivery (Twilio error 30006) with no admin
 * ever notified.
 *
 * Proves, against the real lib/smsService.js#sendSms and
 * #handleStatusCallback (Twilio faked, Gmail/email bypassed via a stubbed
 * lib/smsOutboundNotify so call COUNTS are directly observable):
 *   - a successful send fires notifySmsSent exactly once
 *   - a genuine sent->failed transition fires notifySmsDeliveryFailure once
 *   - a REDELIVERED status callback (same twilio_sid, same terminal status
 *     again) never fires it a second time
 *   - a different-terminal-status correction (undelivered->failed) never
 *     fires it a second time either ("at most one alert per delivery
 *     failure")
 *   - the real notification_preferences table + the 2026-68 migration
 *     correctly exclude michelle@ecconstructiongroup.com from both new
 *     categories while leaving an unrestricted staff address (standing in
 *     for Yaron) included
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

const notifyCalls = { sent: [], failure: [] };

let db, leadId, ownerId;
const RUN = `smson${Date.now().toString(36)}`;

function stubModule(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));

  stubModule('lib/smsClient', {
    getCredentials: () => ({ from: '+15550001111' }),
    sendMessage: async () => ({ ok: true, sid: `SM-${RUN}-${Math.random().toString(36).slice(2)}`, status: 'queued', errorCode: null, errorMessage: null }),
  });

  stubModule('lib/smsOutboundNotify', {
    sentNotificationsEnabled: () => true,
    deliveryFailureNotificationsEnabled: () => true,
    smsAuthorLabel: (s) => s || 'System',
    notifySmsSent: async ({ leadId: lid, messageRow }) => { notifyCalls.sent.push({ leadId: lid, twilio_sid: messageRow.twilio_sid }); return { sent: true }; },
    notifySmsDeliveryFailure: async ({ messageRow }) => { notifyCalls.failure.push({ twilio_sid: messageRow.twilio_sid, status: messageRow.status }); return { sent: true }; },
  });

  delete require.cache[require.resolve(path.join(ROOT, 'lib/smsService'))];

  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Outbound Notify Test Owner', true) ON CONFLICT DO NOTHING`, [`${RUN}.owner@ecconstructiongroup.com`]);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;

  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, owner_id, sms_consent)
     VALUES ('Manuel', 'TestLead', $1, '3235551234', $2, true) RETURNING id`,
    [`${RUN}.lead@example.com`, ownerId]
  );
  leadId = leadRes.rows[0].id;
});

test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

test('sendSms: a successful Twilio accept fires notifySmsSent exactly once, with the real inserted row', { skip }, async () => {
  const smsService = require(path.join(ROOT, 'lib/smsService'));
  notifyCalls.sent.length = 0;
  const row = await smsService.sendSms({ leadId, body: 'Reminder: your appointment is tomorrow at 10am', sentBy: 'system:reminder_12h' });
  assert.strictEqual(notifyCalls.sent.length, 1);
  assert.strictEqual(notifyCalls.sent[0].leadId, leadId);
  assert.strictEqual(notifyCalls.sent[0].twilio_sid, row.twilio_sid);
});

test('handleStatusCallback: a genuine sent->failed transition fires notifySmsDeliveryFailure exactly once', { skip }, async () => {
  const smsService = require(path.join(ROOT, 'lib/smsService'));
  notifyCalls.failure.length = 0;
  const row = await smsService.sendSms({ leadId, body: 'test message 1', sentBy: 'system:reminder_2h' });

  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'failed', errorCode: '30006', errorMessage: 'Landline or unreachable carrier' });
  assert.strictEqual(notifyCalls.failure.length, 1);
  assert.strictEqual(notifyCalls.failure[0].twilio_sid, row.twilio_sid);
  assert.strictEqual(notifyCalls.failure[0].status, 'failed');
});

test('handleStatusCallback: a REDELIVERED callback for the same terminal status never fires a second alert', { skip }, async () => {
  const smsService = require(path.join(ROOT, 'lib/smsService'));
  notifyCalls.failure.length = 0;
  const row = await smsService.sendSms({ leadId, body: 'test message 2', sentBy: 'system:reminder_2h' });

  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'undelivered', errorCode: '30006' });
  assert.strictEqual(notifyCalls.failure.length, 1, 'first transition must fire');

  // Twilio redelivers the identical status-callback webhook.
  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'undelivered', errorCode: '30006' });
  assert.strictEqual(notifyCalls.failure.length, 1, 'a redelivered callback for an already-failed row must never fire a second alert');
});

test('handleStatusCallback: a different-terminal-status correction (undelivered->failed) never fires a second alert either — "at most one alert per delivery failure"', { skip }, async () => {
  const smsService = require(path.join(ROOT, 'lib/smsService'));
  notifyCalls.failure.length = 0;
  const row = await smsService.sendSms({ leadId, body: 'test message 3', sentBy: 'system:reminder_2h' });

  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'undelivered', errorCode: '30006' });
  assert.strictEqual(notifyCalls.failure.length, 1);

  // A later correction to a DIFFERENT terminal failure status for the SAME message.
  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'failed', errorCode: '30006' });
  assert.strictEqual(notifyCalls.failure.length, 1, 'a terminal-to-terminal correction must never produce a second alert');
});

test('handleStatusCallback: a non-terminal transition (sent -> delivered) never fires the failure alert', { skip }, async () => {
  const smsService = require(path.join(ROOT, 'lib/smsService'));
  notifyCalls.failure.length = 0;
  const row = await smsService.sendSms({ leadId, body: 'test message 4', sentBy: 'system:reminder_2h' });

  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'delivered' });
  assert.strictEqual(notifyCalls.failure.length, 0);
});

test('2026-68 migration + real filterRecipientsForCategory: michelle@ecconstructiongroup.com is excluded from sms_sent and sms_delivery_failure; an unrestricted staff address is kept', { skip }, async () => {
  const notificationPreferences = require(path.join(ROOT, 'lib/notificationPreferences'));
  const candidates = ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'];

  const sentRecipients = await notificationPreferences.filterRecipientsForCategory(candidates, notificationPreferences.CATEGORIES.SMS_SENT);
  assert.deepStrictEqual(sentRecipients, ['yaron@ecconstructiongroup.com']);

  const failureRecipients = await notificationPreferences.filterRecipientsForCategory(candidates, notificationPreferences.CATEGORIES.SMS_DELIVERY_FAILURE);
  assert.deepStrictEqual(failureRecipients, ['yaron@ecconstructiongroup.com']);
});

test('getOutboundDeliveryEvidence: reports real attempts/delivered/failed counts and recent error codes from the rows this run created', { skip }, async () => {
  const smsService = require(path.join(ROOT, 'lib/smsService'));
  const evidence = await smsService.getOutboundDeliveryEvidence();
  assert.strictEqual(evidence.available, true);
  assert.ok(evidence.attempts >= 5, `expected at least the 5 messages this file sent, got ${evidence.attempts}`);
  assert.ok(evidence.failed >= 3, `expected at least 3 failed/undelivered rows, got ${evidence.failed}`);
  const code30006 = evidence.recent_error_codes.find((e) => e.error_code === '30006');
  assert.ok(code30006 && code30006.count >= 3);
});
