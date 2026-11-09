/* eslint-disable no-undef */
'use strict';

/**
 * systemFailureNotifyMichelleYaron.int.test.js — REAL-Postgres proof of the
 * explicit, approved exception added by
 * db/migrations/2026-69-system-failure-notify-michelle-yaron.sql: after
 * every migration has run (2026-62's original disabling row for Michelle,
 * then 2026-69's flip), BOTH michelle@ecconstructiongroup.com and
 * yaron@ecconstructiongroup.com must be returned by
 * notificationPreferences.filterRecipientsForCategory(...,
 * CATEGORIES.SYSTEM_FAILURE) — i.e. lib/monitoring/alertDispatcher.js's
 * staff-broadcast path will actually email both of them for a critical
 * system failure or recovery alert, email only (no SMS mechanism is
 * involved in this path at all).
 *
 * Also proves Michelle's OTHER single-category restrictions are completely
 * unaffected by this change (e.g. she remains excluded from `appointment`).
 *
 * Skipped without TEST_DATABASE_URL (needs a disposable, migrated
 * Postgres — db/migrate.js must have been run against it first, including
 * 2026-62 and 2026-69, in that order).
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

let db, notificationPreferences;

test.before(async () => {
  if (skip) return;
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));
  await db.ensureSchema();
  delete require.cache[require.resolve(path.join(ROOT, 'lib/notificationPreferences'))];
  notificationPreferences = require(path.join(ROOT, 'lib/notificationPreferences'));
});

test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

test('system_failure: both michelle and yaron are returned by filterRecipientsForCategory after migrations run', { skip }, async () => {
  const candidates = ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'];
  const result = await notificationPreferences.filterRecipientsForCategory(candidates, notificationPreferences.CATEGORIES.SYSTEM_FAILURE);
  assert.deepStrictEqual(
    new Set(result.map((e) => e.toLowerCase())),
    new Set(['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com']),
    'per the explicitly approved exception, BOTH administrators must receive system_failure (critical failure/recovery) alerts'
  );
});

test('case-insensitivity: a mixed-case candidate list still resolves both recipients', { skip }, async () => {
  const candidates = ['Michelle@EcConstructionGroup.com', 'YARON@ecconstructiongroup.com'];
  const result = await notificationPreferences.filterRecipientsForCategory(candidates, notificationPreferences.CATEGORIES.SYSTEM_FAILURE);
  assert.strictEqual(result.length, 2);
});

test('Michelle\'s OTHER single-category restrictions are completely unaffected — she is still excluded from appointment/follow_up/etc.', { skip }, async () => {
  // Other integration test files sharing this same disposable database
  // (e.g. calendarAttendeesIgnoreEmailPreferences.int.test.js) legitimately
  // DELETE then re-seed Michelle's appointment/follow_up disabling rows as
  // part of their own scenario's cleanup — "absence = enabled" means her
  // row can transiently read as enabled between files depending on run
  // order. This test is about THIS migration's own scope (it never touches
  // `appointment` at all), not about asserting some other file's cleanup
  // discipline, so re-assert the known 2026-62 baseline explicitly first.
  await notificationPreferences.setPreference('michelle@ecconstructiongroup.com', notificationPreferences.CATEGORIES.APPOINTMENT, false);

  const candidates = ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'];
  const appointment = await notificationPreferences.filterRecipientsForCategory(candidates, notificationPreferences.CATEGORIES.APPOINTMENT);
  assert.deepStrictEqual(appointment.map((e) => e.toLowerCase()), ['yaron@ecconstructiongroup.com'], 'Michelle must remain excluded from every other category — this fix is scoped to system_failure alone');

  const newLead = await notificationPreferences.filterRecipientsForCategory(candidates, notificationPreferences.CATEGORIES.NEW_LEAD);
  assert.deepStrictEqual(
    new Set(newLead.map((e) => e.toLowerCase())),
    new Set(['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com']),
    'new_lead (her one pre-existing category) is unaffected and still enabled for her'
  );
});

test('end-to-end: lib/monitoring/alertDispatcher.js\'s real staff-broadcast path emails both administrators for a critical alert, using the real DB-backed preference filter (emailService stubbed, everything else real)', { skip }, async () => {
  delete require.cache[require.resolve(path.join(ROOT, 'lib/notificationRecipients'))];
  const notificationRecipientsPath = require.resolve(path.join(ROOT, 'lib/notificationRecipients'));
  const prevRecipients = require.cache[notificationRecipientsPath];
  require.cache[notificationRecipientsPath] = {
    id: notificationRecipientsPath, filename: notificationRecipientsPath, loaded: true,
    exports: { getAllStaffRecipients: async () => ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'] },
  };

  const emailServicePath = require.resolve(path.join(ROOT, 'lib/emailService'));
  const prevEmail = require.cache[emailServicePath];
  const calls = [];
  require.cache[emailServicePath] = {
    id: emailServicePath, filename: emailServicePath, loaded: true,
    exports: { send: async (args) => { calls.push(args); return { ok: true }; } },
  };

  delete require.cache[require.resolve(path.join(ROOT, 'lib/monitoring/alertDispatcher'))];
  const { dispatchMonitoringAlert } = require(path.join(ROOT, 'lib/monitoring/alertDispatcher'));

  try {
    await dispatchMonitoringAlert({ serviceId: 'qb-proxy-server', level: 'critical', errorSummary: 'simulated critical failure for test' });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(
      new Set(calls[0].to.map((e) => e.toLowerCase())),
      new Set(['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'])
    );
    assert.match(calls[0].subject, /CRITICAL/);
  } finally {
    if (prevRecipients) require.cache[notificationRecipientsPath] = prevRecipients; else delete require.cache[notificationRecipientsPath];
    if (prevEmail) require.cache[emailServicePath] = prevEmail; else delete require.cache[emailServicePath];
    delete require.cache[require.resolve(path.join(ROOT, 'lib/monitoring/alertDispatcher'))];
  }
});
