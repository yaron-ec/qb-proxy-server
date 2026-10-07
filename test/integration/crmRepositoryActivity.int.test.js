/* eslint-disable no-undef */
'use strict';

/**
 * crmRepositoryActivity.int.test.js — REAL-Postgres regression proof.
 *
 * lib/crmRepository.js#writeReminderSentActivity previously inserted into
 * activities with a 'timestamp' column that has never existed on that
 * table (only created_at, which already defaults to NOW()). Every call
 * threw "column timestamp does not exist"; the caller
 * (lib/reminderEngine.js#flushActivityQueue) retried via
 * reminder_activity_queue up to 10 times, then gave up and silently
 * dropped the row — so a REMINDER_SENT activity has never actually
 * appeared on a lead's CRM timeline. Fixed by removing the nonexistent
 * column from the INSERT.
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

let db, crmRepository, leadId;

test.before(async () => {
  if (skip) return;
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));
  crmRepository = require(path.join(ROOT, 'lib/crmRepository'));

  const stamp = Date.now();
  const ownerRes = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Reminder Activity Test Owner') RETURNING id`,
    [`owner-reminder-activity-${stamp}@test.example`]
  );
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Reminder', 'TestLead', $1, '5553334444', 'Referral', 'New', $2)
     RETURNING id`,
    [`reminder-activity-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  leadId = rows[0].id;
});

test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

test('writeReminderSentActivity actually inserts a row (regression for nonexistent "timestamp" column)', { skip }, async () => {
  const ok = await crmRepository.writeReminderSentActivity({ leadId, reminderKey: 'TEST_KEY_123' });
  assert.strictEqual(ok, true);

  const { rows } = await db.query(
    `SELECT type, content, author, source, created_at FROM activities WHERE lead_id = $1 AND content = $2`,
    [leadId, 'REMINDER_SENT:TEST_KEY_123']
  );
  assert.strictEqual(rows.length, 1, 'the activity row must actually be persisted');
  assert.strictEqual(rows[0].type, 'note');
  assert.strictEqual(rows[0].author, 'System');
  assert.strictEqual(rows[0].source, 'manual');
  assert.ok(rows[0].created_at, 'created_at must be auto-populated (no separate timestamp column needed)');
});
