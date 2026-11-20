/* eslint-disable no-undef */
'use strict';

/**
 * customerReminderChannelControls.int.test.js — real-Postgres proof of CRM
 * repair item 10 (November 2026): "Customer Reminders" previously only
 * ever stopped EMAIL reminders — the automated SMS reminder sends (booking
 * confirmation, 12h/2h window reminders) never checked it at all, confirmed
 * by direct code read of lib/booking/bookingService.js and
 * lib/reminderEngine.js (both only ever checked lead.sms_consent /
 * feature-activation flags). The Lead Detail UI text itself was honest
 * about what it actually did; the fix adds a real, independent SMS control
 * and makes Master stop both channels, per the explicit requirement.
 *
 * Covers EVERY combination of the three booleans
 * (customer_reminders_disabled=Master, customer_sms_reminders_disabled)
 * against the ONE central SMS choke point (lib/smsService.js#sendSms),
 * proving:
 *   - An automated-reminder-sourced send (sentBy in REMINDER_SMS_SENDERS)
 *     is blocked whenever Master OR the SMS-specific flag is true.
 *   - A MANUAL send (sentBy = a rep's own email) is NEVER blocked by
 *     either flag — the controls govern automated reminders only.
 *   - Re-enabling (flipping either flag back to false) immediately allows
 *     the next send — no backlog, no delayed catch-up, since this is a
 *     live check at send time, not a queue.
 *   - Twilio opt-out (STOP) still wins over everything, unconditionally,
 *     even when both reminder flags are false.
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

const BUSINESS_HOURS_MS = new Date('2099-06-15T20:00:00Z').getTime(); // ~1pm Pacific, inside quiet-hours window

let db, smsService, ownerId, leadId;
let sendCounter = 0;

const fakeTwilio = {
  sendMessage: async () => ({ ok: true, sid: `SM-crc-${Date.now()}-${++sendCounter}`, status: 'queued', errorCode: null, errorMessage: null }),
  verifyTwilioSignature: () => true,
  missingConfig: () => [],
  getCredentials: () => ({ accountSid: 'ACtest', authToken: 'test', messagingServiceSid: null, from: '+15550001111' }),
  webhookBaseUrl: () => 'https://fake-backend.example.com',
  webhookBaseUrlSource: () => 'TWILIO_WEBHOOK_BASE_URL',
};

test.before(async () => {
  if (skip) return;
  const smsClientPath = require.resolve(path.join(ROOT, 'lib/smsClient'));
  require.cache[smsClientPath] = { id: smsClientPath, filename: smsClientPath, loaded: true, exports: fakeTwilio };

  db = require(path.join(ROOT, 'db/client'));
  smsService = require(path.join(ROOT, 'lib/smsService'));

  const stamp = Date.now();
  const ownerRes = await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'Channel Controls Owner') RETURNING id`, [`crc-owner-${stamp}@test.example`]);
  ownerId = ownerRes.rows[0].id;
  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, sms_consent)
     VALUES ('Channel', 'Controls', $1, 'Sold', '5551230099', true) RETURNING id`,
    [ownerId]
  );
  leadId = leadRes.rows[0].id;
});

test.after(async () => {
  if (skip) return;
  await db.query('DELETE FROM sms_messages WHERE lead_id = $1', [leadId]);
  await db.query('DELETE FROM leads WHERE id = $1', [leadId]);
  await db.query('DELETE FROM owners WHERE id = $1', [ownerId]);
  await db.pool.end();
});

async function setFlags({ master, sms }) {
  await db.query(
    `UPDATE leads SET customer_reminders_disabled = $1, customer_sms_reminders_disabled = $2 WHERE id = $3`,
    [master, sms, leadId]
  );
}

async function sendAs(sentBy, t) {
  t.mock.timers.enable({ apis: ['Date'], now: BUSINESS_HOURS_MS });
  try {
    await smsService.sendSms({ leadId, body: 'test message', sentBy, now: new Date(BUSINESS_HOURS_MS) });
    return { blocked: false };
  } catch (e) {
    return { blocked: true, code: e.code };
  } finally {
    t.mock.timers.reset();
  }
}

const REMINDER_SENDER = 'system:reminder_12h';
const MANUAL_SENDER = 'rep@ecconstructiongroup.com';

const MATRIX = [
  { master: false, sms: false, reminderBlocked: false },
  { master: true, sms: false, reminderBlocked: true, expectedCode: 'customer_reminders_disabled' },
  { master: false, sms: true, reminderBlocked: true, expectedCode: 'customer_sms_reminders_disabled' },
  { master: true, sms: true, reminderBlocked: true, expectedCode: 'customer_reminders_disabled' }, // Master checked first
];

test('every Master/SMS combination: an automated-reminder send is blocked exactly when expected, with the correct reason code', { skip }, async (t) => {
  for (const combo of MATRIX) {
    await setFlags(combo);
    const result = await sendAs(REMINDER_SENDER, t);
    assert.strictEqual(result.blocked, combo.reminderBlocked, `master=${combo.master} sms=${combo.sms}: expected blocked=${combo.reminderBlocked}`);
    if (combo.reminderBlocked) {
      assert.strictEqual(result.code, combo.expectedCode, `master=${combo.master} sms=${combo.sms}: wrong reason code`);
    }
  }
});

test('every Master/SMS combination: a MANUAL send (rep-initiated, not a reminder) is NEVER blocked by either flag', { skip }, async (t) => {
  for (const combo of MATRIX) {
    await setFlags(combo);
    const result = await sendAs(MANUAL_SENDER, t);
    assert.strictEqual(result.blocked, false, `master=${combo.master} sms=${combo.sms}: a manual send must never be blocked by the reminder controls`);
  }
});

test('re-enabling (flipping a flag back to false) immediately allows the next send — no backlog, no delayed catch-up', { skip }, async (t) => {
  await setFlags({ master: true, sms: false });
  const blocked = await sendAs(REMINDER_SENDER, t);
  assert.strictEqual(blocked.blocked, true);

  await setFlags({ master: false, sms: false });
  const allowed = await sendAs(REMINDER_SENDER, t);
  assert.strictEqual(allowed.blocked, false, 'the very next send after re-enabling must succeed immediately — this is a live check, never a queued backlog');
});

test('Twilio STOP opt-out still wins unconditionally, even when both reminder flags are false', { skip }, async (t) => {
  await setFlags({ master: false, sms: false });
  await smsService.recordOptOut('5551230099');
  try {
    const result = await sendAs(REMINDER_SENDER, t);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.code, 'recipient_opted_out', 'opt-out must be checked before, and independent of, the reminder-channel controls');
  } finally {
    await smsService.recordOptIn('5551230099');
  }
});
