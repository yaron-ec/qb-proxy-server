/* eslint-disable no-undef */
'use strict';

/**
 * reminderEngineActivityWrite.int.test.js — REAL-Postgres regression proof
 * for a production defect in lib/reminderEngine.js's own REMINDER_SENT
 * activity write (step 5 of processReminders, immediately after a
 * successful Gmail send is marked `sent` in reminder_claims).
 *
 * ROOT CAUSE: the inline write used `require('./db/client')` — correct for
 * a file living directly in the repo root, but lib/reminderEngine.js lives
 * one directory down (lib/), so Node resolved this against
 * lib/db/client.js, which does not exist. Production logs confirmed this
 * live: "[engine] Activity write failed (non-blocking): Cannot find module
 * './db/client'" — reproduced exactly 3 times, once per real send tick.
 * The reminder email/SMS itself still sent correctly (this write is
 * documented as best-effort, never the send gate), but no "Reminder sent"
 * activity row ever appeared on the lead's CRM timeline for a real send.
 *
 * A unit test stubbing db/client cannot catch this class of bug — the stub
 * replaces the require cache entry regardless of path, so a wrong relative
 * path would resolve to the same stub either way. Only a real require()
 * resolved against the real file tree (this file requires
 * lib/reminderEngine.js from its real on-disk location, exactly as
 * server.js/reminderWorker.js do) can prove the path itself is correct.
 *
 * This test calls the now-exported lib/reminderEngine.js#writeReminderSentActivity
 * directly — the real function processReminders() calls on every successful
 * send — rather than driving the full Gmail-entangled processReminders()
 * loop end to end (CLAUDE.md already documents that loop as "entangled
 * with a live Gmail token refresh and can't be driven standalone", the same
 * reason test/reminderEngineQuietHoursDeferral.test.js stays source-level).
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
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Reminder Engine Activity Test Owner') RETURNING id`,
    [`owner-reminder-engine-activity-${stamp}@test.example`]
  );
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('ReminderEngine', 'TestLead', $1, '5553335555', 'Referral', 'New', $2)
     RETURNING id`,
    [`reminder-engine-activity-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  leadId = rows[0].id;
});

test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

test('writeReminderSentActivity resolves require("../db/client") correctly and inserts the activity row (regression for the ./db/client path bug)', { skip }, async () => {
  await reminderEngine.writeReminderSentActivity(leadId, '12h', false);

  const { rows } = await db.query(
    `SELECT type, content, author, source, metadata, created_at FROM activities
     WHERE lead_id = $1 AND content = $2`,
    [leadId, 'Reminder sent: 12h']
  );
  assert.strictEqual(rows.length, 1, 'the REMINDER_SENT activity row must actually be persisted — this is exactly what silently failed in production');
  assert.strictEqual(rows[0].type, 'note');
  assert.strictEqual(rows[0].author, 'system');
  assert.strictEqual(rows[0].source, 'manual');
  assert.ok(rows[0].created_at, 'created_at must be auto-populated');
  const meta = rows[0].metadata;
  assert.strictEqual(meta.reminder_key, '12h');
  assert.strictEqual(meta.customer_skipped_no_email, false);
  assert.ok(meta.sent_at, 'metadata must record sent_at');
});

test('writeReminderSentActivity records customer_skipped_no_email correctly and defaults reminder_key label when omitted', { skip }, async () => {
  await reminderEngine.writeReminderSentActivity(leadId, null, true);

  const { rows } = await db.query(
    `SELECT content, metadata FROM activities WHERE lead_id = $1 AND content = $2`,
    [leadId, 'Reminder sent: appointment']
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].metadata.customer_skipped_no_email, true);
  assert.strictEqual(rows[0].metadata.reminder_key, null);
});

test('writeReminderSentActivity never throws even if the insert fails (best-effort, never the send gate)', { skip }, async () => {
  // An invalid (non-existent) lead_id: activities.lead_id is a real FK, so
  // this INSERT will fail — writeReminderSentActivity must swallow it, since
  // this write is documented (lib/reminderEngine.js's own header) as
  // best-effort and must never block or fail the caller (the reminder is
  // already durably 'sent' in reminder_claims regardless of this outcome).
  await assert.doesNotReject(reminderEngine.writeReminderSentActivity('00000000-0000-0000-0000-000000000000', '2h', false));
});
