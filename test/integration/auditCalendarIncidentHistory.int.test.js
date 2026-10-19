/* eslint-disable no-undef */
'use strict';

/**
 * auditCalendarIncidentHistory.int.test.js — REAL-Postgres proof of
 * scripts/auditCalendarIncidentHistory.js's buildReport(): the pure
 * read-only historical forensics tool for the Michelle calendar incident.
 * Seeds realistic historical shapes directly via SQL (appointment_events,
 * activities, calendar_outbox rows) matching exactly what the real write
 * paths (bookingService.cancelAppointment, routes/leads.js's terminal-lost
 * transition, calendarOutbox.enqueueCreate/enqueueUpdate) produce, then
 * proves buildReport() classifies each scenario correctly. Skipped without
 * TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const MICHELLE = 'michelle@ecconstructiongroup.com';
const YARON = 'yaron@ecconstructiongroup.com';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, auditScript, ownerId, typeId, notifRecipientsState;
const RUN = `hist${Date.now().toString(36)}`;
// Deliberately NOT the real 2026-10-16..20 incident window: "now" in this
// sandbox IS inside that window, so every OTHER test file's NOW()-stamped
// fixture appointments from this entire session would collide with it and
// blow past any reasonable LIMIT. An isolated far-future window proves the
// same logic without that pollution; the script's own real default (used in
// production) is unaffected — these constants only control this test file.
const SINCE = '2095-10-16';
const UNTIL = '2095-10-20';

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  auditScript = require(path.join(ROOT, 'scripts/auditCalendarIncidentHistory'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'History Test Owner') ON CONFLICT DO NOTHING`, [`${RUN}.owner@ecconstructiongroup.com`]);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;
  typeId = Object.fromEntries((await db.query(`SELECT name, id FROM appointment_types`)).rows.map((r) => [r.name, r.id]));

  const existing = (await db.query('SELECT id, notification_recipients FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  if (existing) {
    const nr = existing.notification_recipients || { to: [], cc: [] };
    const hasBoth = (nr.to || []).concat(nr.cc || []).map((e) => e.toLowerCase());
    if (!hasBoth.includes(MICHELLE) || !hasBoth.includes(YARON)) {
      notifRecipientsState = { id: existing.id, previous: nr };
      await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2',
        [JSON.stringify({ to: [YARON], cc: [MICHELLE] }), existing.id]);
    }
  } else {
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, notification_recipients) VALUES ($1, $2) RETURNING id`,
      [`Integration Test Co ${Date.now()}`, JSON.stringify({ to: [YARON], cc: [MICHELLE] })]
    );
    notifRecipientsState = { insertedId: ins.rows[0].id };
  }
  require('../../lib/companyConfig').invalidate();
});
test.after(async () => {
  if (skip) return;
  if (notifRecipientsState) {
    if (notifRecipientsState.insertedId) await db.query('DELETE FROM company_settings WHERE id = $1', [notifRecipientsState.insertedId]);
    else await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2', [JSON.stringify(notifRecipientsState.previous), notifRecipientsState.id]);
  }
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});

async function lead(key, status = 'Appointment scheduled') {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, created_at) VALUES ($1, $2, $3, $4, '2095-01-01') RETURNING id`,
    [key, RUN, ownerId, status]
  );
  return r.rows[0].id;
}
const WINDOW_TS = '2095-10-17T12:00:00Z'; // inside [SINCE, UNTIL)
async function appt(leadId, { status = 'scheduled', googleEventId = null, updatedAt = WINDOW_TS } = {}) {
  const t = typeId['General Meeting'];
  const start = '2095-07-01T18:00:00Z';
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                                idempotency_key, calendar_sync_status, version, google_event_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 'America/Los_Angeles',
             tstzrange($4::timestamptz - interval '1 hour', $4::timestamptz + interval '2 hour', '[)'),
             $5, $6, 'synced', 1, $7, $8::timestamptz, $8::timestamptz) RETURNING id`,
    [leadId, ownerId, t, start, status, `${RUN}-${leadId}`, googleEventId, updatedAt]
  );
  return r.rows[0].id;
}
async function outboxRow(appointmentId, action, attendeeEmails, createdAt) {
  const payload = action.startsWith('cancel') ? null : JSON.stringify({ attendees: attendeeEmails.map((email) => ({ email })) });
  await db.query(
    `INSERT INTO calendar_outbox (appointment_id, action, slot, version, google_event_id, calendar_id, payload, idempotency_key, status, created_at)
     VALUES ($1, $2, 'slot', 1, $3, 'primary', $4, $5, 'synced', $6::timestamptz)`,
    [appointmentId, action, `${appointmentId}-gid`, payload, `cal:${appointmentId}:${action}:${createdAt}`, createdAt]
  );
}
async function apptEvent(appointmentId, actor, action, createdAt) {
  await db.query(
    `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values, created_at)
     VALUES ($1, $2, $3, '{}', '{}', $4::timestamptz)`,
    [appointmentId, actor, action, createdAt]
  );
}
async function activity(leadId, content, createdAt) {
  await db.query(
    `INSERT INTO activities (lead_id, type, content, author, source, created_at) VALUES ($1, 'note', $2, $3, 'manual', $4::timestamptz)`,
    [leadId, content, 'yaron@ecconstructiongroup.com', createdAt]
  );
}

test('buildReport: coverage reports the TRUE total active-appointment count, independent of any --limit', { skip }, async () => {
  const leadId = await lead(`cov-${RUN}`);
  await appt(leadId, { status: 'scheduled', googleEventId: `${RUN}-cov-gid` });
  const report = await auditScript.buildReport({ since: SINCE, until: UNTIL, limit: 500 });
  assert.ok(report.coverage.total_active >= 1);
  assert.ok(report.coverage.total_active_synced >= 1);
});

test('buildReport: a cancelled appointment WITH a matching terminal-lost activity note is classified cancelled_terminal_lost (legitimate)', { skip }, async () => {
  const leadId = await lead(`tl-${RUN}`, 'Lost');
  const apptId = await appt(leadId, { status: 'cancelled', googleEventId: `${RUN}-tl-gid`, updatedAt: WINDOW_TS });
  await apptEvent(apptId, 'yaron@ecconstructiongroup.com', 'cancelled', WINDOW_TS);
  await activity(leadId, `Lead marked Lost: future reminders and follow-ups stopped; 1 active appointment(s) cancelled (Google Calendar event removal queued).`, WINDOW_TS);

  const report = await auditScript.buildReport({ since: SINCE, until: UNTIL, limit: 500 });
  const rec = report.records.find((r) => r.appointment_id === apptId);
  assert.ok(rec, 'appointment is in the window report');
  assert.strictEqual(rec.classification, 'cancelled_terminal_lost');
});

test('buildReport: a cancelled appointment WITHOUT a matching terminal-lost note is classified cancelled_needs_review', { skip }, async () => {
  const leadId = await lead(`nr-${RUN}`); // status stays 'Appointment scheduled' — not terminal-lost
  const apptId = await appt(leadId, { status: 'cancelled', googleEventId: `${RUN}-nr-gid`, updatedAt: WINDOW_TS });
  await apptEvent(apptId, 'yaron@ecconstructiongroup.com', 'cancelled', WINDOW_TS);

  const report = await auditScript.buildReport({ since: SINCE, until: UNTIL, limit: 500 });
  const rec = report.records.find((r) => r.appointment_id === apptId);
  assert.ok(rec);
  assert.strictEqual(rec.classification, 'cancelled_needs_review');
});

test('buildReport: a rescheduled (superseded) appointment is classified rescheduled_superseded, not confused with a cancellation', { skip }, async () => {
  const leadId = await lead(`resch-${RUN}`);
  const apptId = await appt(leadId, { status: 'rescheduled', googleEventId: `${RUN}-resch-gid`, updatedAt: WINDOW_TS });

  const report = await auditScript.buildReport({ since: SINCE, until: UNTIL, limit: 500 });
  const rec = report.records.find((r) => r.appointment_id === apptId);
  assert.ok(rec);
  assert.strictEqual(rec.classification, 'rescheduled_superseded');
});

test('buildReport: THE KEY FORENSIC CHECK — detects an appointment whose live-synced payload history shows Michelle present then silently dropped, while still active', { skip }, async () => {
  const leadId = await lead(`removed-${RUN}`);
  const apptId = await appt(leadId, { status: 'scheduled', googleEventId: `${RUN}-removed-gid`, updatedAt: WINDOW_TS });
  await outboxRow(apptId, 'create_main', [YARON, MICHELLE], '2026-10-16T09:00:00Z');
  await outboxRow(apptId, 'update_main', [YARON], '2026-10-17T09:00:00Z');

  const report = await auditScript.buildReport({ since: SINCE, until: UNTIL, limit: 500 });
  const rec = report.records.find((r) => r.appointment_id === apptId);
  assert.ok(rec, 'flagged in the window report');
  assert.strictEqual(rec.attendee_history[MICHELLE].unintended_removal, true);
  assert.strictEqual(rec.attendee_history[MICHELLE].currently_present, false);
  assert.ok(report.unintended_attendee_removal_count >= 1);
  assert.ok(report.records.some((r) => r.appointment_id === apptId));
});

test('buildReport: an appointment that never got a google_event_id at all is reported separately, distinctly from an attendee removal', { skip }, async () => {
  const leadId = await lead(`nosync-${RUN}`);
  const apptId = await appt(leadId, { status: 'scheduled', googleEventId: null, updatedAt: WINDOW_TS });

  const report = await auditScript.buildReport({ since: SINCE, until: UNTIL, limit: 500 });
  assert.ok(report.without_google_event_id.some((r) => r.appointment_id === apptId));
  const rec = report.records.find((r) => r.appointment_id === apptId);
  assert.strictEqual(rec.attendee_history, null, 'no attendee history to analyze when there was never a google_event_id');
});
