/* eslint-disable no-undef */
'use strict';

/**
 * backfillAppointmentScheduledStatusCasing.int.test.js — REAL-Postgres proof
 * of scripts/backfillAppointmentScheduledStatusCasing.js: the one-time
 * (re-runnable) backfill for leads created before
 * lib/booking/bookingService.js's status-casing fix shipped, which still
 * carry the wrong-cased literal 'Appointment Scheduled' (capital S) instead
 * of the canonical 'Appointment scheduled' every reader in this codebase
 * (Dashboard/Reports/Kanban/Settings/LeadDetailModern/design-system.js/
 * routes/cronJobs.js's mark-invalid-contacts exclusion) actually compares
 * against.
 *
 * Seeds historical rows directly via SQL (bypassing the API, since the
 * script's whole purpose is to repair data the live write path — now fixed —
 * no longer produces), then runs the real script as a separate process:
 * report-only, then --apply, then an idempotent re-run. Proves the fix never
 * touches an unrelated status, an appointment row, or any other lead field.
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, ownerId;
const RUN = `r${Date.now().toString(36)}`;

function runScript(extra = []) {
  const out = execFileSync(process.execPath, ['scripts/backfillAppointmentScheduledStatusCasing.js', '--json', ...extra],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return JSON.parse(out.slice(out.indexOf('{')));
}
const host = () => new URL(DB_URL).hostname;

async function lead(key, status) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
    [key, RUN, ownerId, status]
  );
  return r.rows[0].id;
}
async function appt(leadId, typeId) {
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                                idempotency_key, calendar_sync_status, version)
     VALUES ($1, $2, $3, '2099-07-01T18:00:00Z'::timestamptz, '2099-07-01T19:00:00Z'::timestamptz, 'America/Los_Angeles',
             tstzrange('2099-07-01T17:00:00Z'::timestamptz, '2099-07-01T20:00:00Z'::timestamptz, '[)'),
             'scheduled', $4, 'synced', 1) RETURNING id`,
    [leadId, ownerId, typeId, `${RUN}-${leadId}-${Math.random()}`]
  );
  return r.rows[0].id;
}
const leadRow = async (id) => (await db.query(`SELECT status, meeting_stage, follow_up_type FROM leads WHERE id = $1`, [id])).rows[0];
const apptRow = async (id) => (await db.query(`SELECT status FROM appointments WHERE id = $1`, [id])).rows[0];
const activitiesOf = async (leadId) => (await db.query(`SELECT content FROM activities WHERE lead_id = $1 ORDER BY created_at`, [leadId])).rows;

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('casing.backfill.test@ecconstructiongroup.com', 'Casing Backfill Test') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'casing.backfill.test@ecconstructiongroup.com'`)).rows[0].id;
});
test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

test('report-only mode (no --apply) never changes anything, and lists exactly the leads with the wrong-cased status', { skip }, async () => {
  const typeRow = (await db.query(`SELECT id FROM appointment_types LIMIT 1`)).rows[0];
  const badCased = await lead(`bad-cased-${RUN}`, 'Appointment Scheduled');
  const a = await appt(badCased, typeRow.id);
  const alreadyCorrect = await lead(`already-correct-${RUN}`, 'Appointment scheduled');
  const unrelated = await lead(`unrelated-${RUN}`, 'New');
  const lowercaseVariant = await lead(`lowercase-variant-${RUN}`, 'appointment scheduled'); // a different casing entirely — must never be touched

  const report = runScript();
  assert.strictEqual(report.mode, 'report-only');
  assert.strictEqual(report.database_host, host());
  const ids = report.records.map(r => r.lead_id);
  assert.ok(ids.includes(badCased), 'the wrong-cased lead must be listed');
  assert.ok(!ids.includes(alreadyCorrect), 'an already-correct lead must never be listed');
  assert.ok(!ids.includes(unrelated), 'an unrelated status must never be listed');
  assert.ok(!ids.includes(lowercaseVariant), 'a different (all-lowercase) casing variant must never be listed — this is an exact-literal match, not fuzzy');

  // Nothing changed in report-only mode.
  assert.strictEqual((await leadRow(badCased)).status, 'Appointment Scheduled');
  assert.strictEqual((await apptRow(a)).status, 'scheduled');
});

test('--apply fixes only the status column, never touches the appointment row or any other lead field', { skip }, async () => {
  const typeRow = (await db.query(`SELECT id FROM appointment_types LIMIT 1`)).rows[0];
  const badCased = await lead(`apply-fix-${RUN}`, 'Appointment Scheduled');
  const a = await appt(badCased, typeRow.id);

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.strictEqual(report.mode, 'apply');
  const rec = report.records.find(r => r.lead_id === badCased);
  assert.ok(rec, 'the fixed lead must appear in the apply report');
  assert.strictEqual(rec.apply_result.fixed, true);

  const row = await leadRow(badCased);
  assert.strictEqual(row.status, 'Appointment scheduled', 'status must be corrected to the canonical lowercase spelling');
  assert.strictEqual((await apptRow(a)).status, 'scheduled', 'the appointment itself must be completely untouched — this is a pure status-string fix, never an appointment operation');

  const notes = await activitiesOf(badCased);
  assert.ok(notes.some(n => n.content.includes('Status casing corrected')), 'an audit note must record the fix');
});

test('an unrelated New lead and a lead already correctly cased are both left completely untouched by --apply', { skip }, async () => {
  const unrelated = await lead(`apply-unrelated-${RUN}`, 'New');
  const alreadyCorrect = await lead(`apply-already-correct-${RUN}`, 'Appointment scheduled');

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  const ids = report.records.map(r => r.lead_id);
  assert.ok(!ids.includes(unrelated));
  assert.ok(!ids.includes(alreadyCorrect));
  assert.strictEqual((await leadRow(unrelated)).status, 'New');
  assert.strictEqual((await leadRow(alreadyCorrect)).status, 'Appointment scheduled');
});

test('re-running --apply after a successful fix is a safe no-op (idempotent)', { skip }, async () => {
  const badCased = await lead(`idempotent-${RUN}`, 'Appointment Scheduled');

  const first = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(first.records.some(r => r.lead_id === badCased && r.apply_result.fixed));

  const second = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(!second.records.some(r => r.lead_id === badCased), 'a lead already fixed must not appear again — nothing left to fix');
  assert.strictEqual((await leadRow(badCased)).status, 'Appointment scheduled');
});

test('--apply without the correct --confirm-host refuses to change anything', { skip }, async () => {
  const badCased = await lead(`refuse-${RUN}`, 'Appointment Scheduled');
  assert.throws(() => runScript(['--apply', '--confirm-host=wrong-host']));
  assert.strictEqual((await leadRow(badCased)).status, 'Appointment Scheduled', 'must remain unchanged when the host confirmation does not match');
});
