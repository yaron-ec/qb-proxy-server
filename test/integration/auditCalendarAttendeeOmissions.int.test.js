/* eslint-disable no-undef */
'use strict';

/**
 * auditCalendarAttendeeOmissions.int.test.js — REAL-Postgres proof of
 * scripts/auditCalendarAttendeeOmissions.js: the report-first / --apply-gated
 * restoration tool for appointments whose last-sent Google Calendar main
 * event is missing a currently-configured staff attendee (the historical
 * fallout of the Michelle missing-calendar-events incident — see
 * lib/booking/calendarOutbox.js's header "PERMANENT RULE" for the root
 * cause, already fixed for all FUTURE creates/updates).
 *
 * Seeds a historical calendar_outbox artifact directly via SQL (reproducing
 * exactly what the pre-fix code would have written: a create_main payload
 * whose attendees list is missing a configured staff recipient), then runs
 * the real script as a separate process: report → apply → idempotent re-run.
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const MICHELLE = 'michelle@ecconstructiongroup.com';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, ownerId, typeId, googleModulesState;
const RUN = `omit${Date.now().toString(36)}`;

function runScript(extra = []) {
  const out = execFileSync(process.execPath, ['scripts/auditCalendarAttendeeOmissions.js', '--json', ...extra],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return JSON.parse(out.slice(out.indexOf('{')));
}
const host = () => new URL(DB_URL).hostname;

async function lead(key) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, created_at)
     VALUES ($1, $2, $3, 'Appointment scheduled', '2097-01-01') RETURNING id`,
    [key, RUN, ownerId]
  );
  return r.rows[0].id;
}

// Seeds an appointment + a create_main calendar_outbox row whose payload's
// attendees are missing MICHELLE — exactly the historical artifact the
// pre-fix code would have produced.
async function apptWithOmittedAttendee(leadId, { attendees } = {}) {
  const t = typeId['General Meeting'];
  const start = '2097-07-01T18:00:00Z';
  const a = (await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                                idempotency_key, calendar_sync_status, version, google_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 'America/Los_Angeles',
             tstzrange($4::timestamptz - interval '1 hour', $4::timestamptz + interval '2 hour', '[)'),
             'scheduled', $5, 'synced', 1, $6) RETURNING id, version`,
    [leadId, ownerId, t, start, `${RUN}-${leadId}`, `${RUN}-${leadId}-gevent`]
  )).rows[0];
  const payload = {
    id: `${RUN}-${leadId}-gevent`,
    summary: 'Meeting with Test',
    attendees: (attendees || ['yaron@ecconstructiongroup.com']).map((email) => ({ email })),
    extendedProperties: { private: { ec_appointment_id: a.id, ec_version: '1', ec_kind: 'main' } },
  };
  await db.query(
    `INSERT INTO calendar_outbox (appointment_id, action, slot, version, google_event_id, calendar_id, payload, idempotency_key, status)
     VALUES ($1, 'create_main', $2, 1, $3, 'primary', $4, $5, 'synced')`,
    [a.id, `${RUN}-slot-${leadId}`, `${RUN}-${leadId}-gevent`, JSON.stringify(payload), `cal:${a.id}:slot:create_main:v1`]
  );
  return a;
}

const apptRow = async (id) => (await db.query(`SELECT status, version FROM appointments WHERE id = $1`, [id])).rows[0];
// Same semantic the script itself uses: the most recent create_main/update_main
// row (never cancel_main, whose payload is always NULL) — the fixture's
// arbitrary google_event_id never matches buildOperation's deterministic one,
// so enqueueUpdate's "id changed" branch enqueues a cancel_main + create_main
// pair in the SAME transaction (identical NOW()-based created_at for both).
const latestOutboxPayload = async (apptId) => (await db.query(
  `SELECT payload FROM calendar_outbox WHERE appointment_id = $1 AND action IN ('create_main', 'update_main')
   ORDER BY created_at DESC LIMIT 1`, [apptId]
)).rows[0].payload;

let notifRecipientsState = null;

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('omit.test@ecconstructiongroup.com', 'Omit Test') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'omit.test@ecconstructiongroup.com'`)).rows[0].id;
  typeId = Object.fromEntries((await db.query(`SELECT name, id FROM appointment_types`)).rows.map((r) => [r.name, r.id]));

  // enqueueUpdate (used by --apply) is gated on google_calendar being
  // enabled — guarantee that first (also guarantees a company_settings row exists).
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db, ['google_calendar']);

  // Guarantee Michelle is a configured staff recipient for this test run,
  // same precondition-setup pattern as calendarAttendeesIgnoreEmailPreferences.int.test.js.
  const existing = (await db.query('SELECT id, notification_recipients FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  const nr = (existing && existing.notification_recipients) || { to: [], cc: [] };
  const hasMichelle = (nr.to || []).includes(MICHELLE) || (nr.cc || []).includes(MICHELLE);
  if (existing && !hasMichelle) {
    notifRecipientsState = { id: existing.id, previous: nr };
    const merged = { to: nr.to || [], cc: Array.from(new Set([...(nr.cc || []), MICHELLE])) };
    await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2', [JSON.stringify(merged), existing.id]);
  }
  require('../../lib/companyConfig').invalidate();
});
test.after(async () => {
  if (skip) return;
  if (notifRecipientsState) {
    await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2', [JSON.stringify(notifRecipientsState.previous), notifRecipientsState.id]);
  }
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});

test('report-only mode flags an active appointment whose last-sent attendees are missing a configured staff recipient, and changes nothing', { skip }, async () => {
  const leadId = await lead(`report-${RUN}`);
  const appt = await apptWithOmittedAttendee(leadId); // attendees = [yaron] only, michelle missing

  const report = runScript();
  assert.strictEqual(report.mode, 'report-only');
  assert.ok(report.configured_staff_recipients.includes(MICHELLE), 'precondition: michelle is a configured staff recipient');
  const rec = report.records.find((r) => r.appointment_id === appt.id);
  assert.ok(rec, 'the appointment is flagged');
  assert.ok(rec.missing_staff.includes(MICHELLE), 'michelle is identified as the missing attendee');

  // Nothing changed.
  const after = await apptRow(appt.id);
  assert.strictEqual(after.version, 1);
});

test('an appointment whose last-sent attendees already include every configured staff recipient is never flagged', { skip }, async () => {
  const leadId = await lead(`ok-${RUN}`);
  const appt = await apptWithOmittedAttendee(leadId, { attendees: ['yaron@ecconstructiongroup.com', MICHELLE] });

  const report = runScript();
  assert.ok(!report.records.some((r) => r.appointment_id === appt.id), 'already-correct appointment is not flagged');
});

test('--apply without --confirm-host refuses and changes nothing', { skip }, async () => {
  const leadId = await lead(`refuse-${RUN}`);
  const appt = await apptWithOmittedAttendee(leadId);
  assert.throws(() => runScript(['--apply']), /confirm-host/);
  assert.strictEqual((await apptRow(appt.id)).version, 1);
});

test('--apply enqueues a corrective update_main whose attendees now include the previously-missing staff member, through the canonical bookingService version-bump path', { skip }, async () => {
  const leadId = await lead(`apply-${RUN}`);
  const appt = await apptWithOmittedAttendee(leadId);

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  const rec = report.records.find((r) => r.appointment_id === appt.id);
  assert.ok(rec, 'flagged in the apply report');
  assert.strictEqual(rec.apply_result.ok, true, JSON.stringify(rec.apply_result));

  const after = await apptRow(appt.id);
  assert.strictEqual(after.version, 2, 'version bumped by the canonical enqueueUpdate path, not a raw UPDATE');

  const payload = await latestOutboxPayload(appt.id);
  const attendeeEmails = payload.attendees.map((a) => a.email);
  assert.ok(attendeeEmails.includes(MICHELLE), 'the corrective update_main payload now includes the previously-missing staff member');
  assert.ok(attendeeEmails.includes('yaron@ecconstructiongroup.com'), 'the previously-present attendee is preserved');
});

test('idempotent re-run: after a successful --apply, running again finds nothing left to correct for the same appointment', { skip }, async () => {
  const leadId = await lead(`idempotent-${RUN}`);
  const appt = await apptWithOmittedAttendee(leadId);

  const first = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(first.records.some((r) => r.appointment_id === appt.id));

  const second = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(!second.records.some((r) => r.appointment_id === appt.id), 'second run finds nothing — no duplicate corrective update');
});
