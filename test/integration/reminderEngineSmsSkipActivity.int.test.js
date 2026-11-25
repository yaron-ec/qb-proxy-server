/* eslint-disable no-undef */
'use strict';

/**
 * reminderEngineSmsSkipActivity.int.test.js — REAL-Postgres proof for the
 * SMS-skip activity-visibility fix (John Dominguez production finding,
 * November 24 2026 — see test/reminderEngineSmsSkipActivity.test.js's own
 * header for the full root-cause writeup, confirmed directly from real
 * Railway production logs: both his 12h and 2h automated SMS reminders
 * were correctly skipped for `no_consent`, with zero Twilio call made and
 * zero trace left on the lead).
 *
 * Proves the real INSERT succeeds against the real `activities` table
 * shape (not just a stubbed query), and that it coexists correctly with
 * the pre-existing EMAIL reminder's own "Reminder sent" note — i.e. a lead
 * with BOTH an email success and an SMS skip ends up with two visibly
 * distinct, correctly-labeled activity rows, never one confused for the
 * other.
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

let db, reminderEngine, leadId;

test.before(async () => {
  if (skip) return;
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));
  delete require.cache[require.resolve(path.join(ROOT, 'lib/reminderEngine'))];
  reminderEngine = require(path.join(ROOT, 'lib/reminderEngine'));

  const stamp = Date.now();
  const ownerRes = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'SMS Skip Activity Test Owner') RETURNING id`,
    [`owner-sms-skip-activity-${stamp}@test.example`]
  );
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id, sms_consent)
     VALUES ('John', 'Dominguez-Test', $1, '5553338888', 'Referral', 'Appointment scheduled', $2, false)
     RETURNING id`,
    [`sms-skip-activity-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  leadId = rows[0].id;
});

test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

test('writeSmsSkippedActivity inserts a real, correctly-shaped activity row for a no_consent skip (the exact John Dominguez shape)', { skip }, async () => {
  await reminderEngine.writeSmsSkippedActivity(leadId, '12h', 'no_consent');

  const { rows } = await db.query(
    `SELECT type, content, author, source, metadata, created_at FROM activities
     WHERE lead_id = $1 AND content = $2`,
    [leadId, 'Automated SMS reminder (12h) was not sent — no SMS consent on file']
  );
  assert.strictEqual(rows.length, 1, 'the skip activity must actually be persisted — this is exactly the visibility gap the production report found');
  assert.strictEqual(rows[0].type, 'note');
  assert.strictEqual(rows[0].author, 'system');
  assert.strictEqual(rows[0].source, 'manual');
  assert.ok(rows[0].created_at);
  assert.strictEqual(rows[0].metadata.channel, 'sms');
  assert.strictEqual(rows[0].metadata.reminder_key, '12h');
  assert.strictEqual(rows[0].metadata.skip_reason, 'no_consent');
});

test('a lead with BOTH an email success and an SMS skip shows two visibly distinct activity rows, never conflated', { skip }, async () => {
  await reminderEngine.writeReminderSentActivity(leadId, '2h', false);
  await reminderEngine.writeSmsSkippedActivity(leadId, '2h', 'no_consent');

  const { rows } = await db.query(
    `SELECT content, metadata FROM activities WHERE lead_id = $1 AND metadata->>'reminder_key' = '2h' ORDER BY created_at`,
    [leadId]
  );
  assert.strictEqual(rows.length, 2, 'both the email-sent note and the SMS-skip note must exist as separate rows');
  const emailRow = rows.find((r) => r.content === 'Reminder sent: 2h');
  const smsRow = rows.find((r) => r.content.startsWith('Automated SMS reminder'));
  assert.ok(emailRow, 'the pre-existing EMAIL reminder-sent note must be unaffected by this fix');
  assert.ok(smsRow, 'the new SMS-skip note must exist alongside it, not instead of it');
  assert.notStrictEqual(emailRow.metadata.channel, 'sms');
  assert.strictEqual(smsRow.metadata.channel, 'sms');
});

test('writeSmsSkippedActivity never throws on a nonexistent lead_id (best-effort against a real FK violation)', { skip }, async () => {
  await assert.doesNotReject(reminderEngine.writeSmsSkippedActivity('00000000-0000-0000-0000-000000000000', '12h', 'no_consent'));
});
