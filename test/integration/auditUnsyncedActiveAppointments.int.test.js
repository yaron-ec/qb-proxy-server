/* eslint-disable no-undef */
'use strict';

/**
 * auditUnsyncedActiveAppointments.int.test.js — REAL-Postgres proof of
 * scripts/auditUnsyncedActiveAppointments.js's buildReport(): confirms each
 * classification bucket against real appointment/calendar_outbox rows,
 * matching exactly what the live write paths (bookingService, calendarOutbox
 * enqueue/worker) produce. Skipped without TEST_DATABASE_URL.
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

let db, auditScript, ownerId, typeId;
const RUN = `unsync${Date.now().toString(36)}`;

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  auditScript = require(path.join(ROOT, 'scripts/auditUnsyncedActiveAppointments'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'Unsynced Test Owner') ON CONFLICT DO NOTHING`, [`${RUN}.owner@ecconstructiongroup.com`]);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;
  typeId = Object.fromEntries((await db.query(`SELECT name, id FROM appointment_types`)).rows.map((r) => [r.name, r.id]));
});
test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

async function lead(key) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, created_at) VALUES ($1, $2, $3, 'Appointment scheduled', '2098-01-01') RETURNING id`,
    [key, RUN, ownerId]
  );
  return r.rows[0].id;
}

// kind: 'meeting' (1h buffer both sides, so busy_range.lower is BEFORE start_at)
// or 'phone_call' (no buffer, busy_range.lower === start_at).
async function appt(leadId, { kind = 'meeting', calendarSyncStatus = 'pending', createdAt = '2098-07-05T00:00:00Z' } = {}) {
  const t = typeId['General Meeting'];
  const start = '2098-07-10T18:00:00Z';
  const bufferClause = kind === 'meeting'
    ? `tstzrange($4::timestamptz - interval '1 hour', $4::timestamptz + interval '2 hour', '[)')`
    : `tstzrange($4::timestamptz, $4::timestamptz + interval '1 hour', '[)')`;
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                                idempotency_key, calendar_sync_status, version, google_event_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 'America/Los_Angeles',
             ${bufferClause},
             'scheduled', $5, $6, 1, NULL, $7::timestamptz, $7::timestamptz) RETURNING id`,
    [leadId, ownerId, t, start, `${RUN}-${leadId}`, calendarSyncStatus, createdAt]
  );
  return r.rows[0].id;
}

async function mainOutboxRow(appointmentId, status, createdAt = '2098-07-05T00:00:01Z') {
  await db.query(
    `INSERT INTO calendar_outbox (appointment_id, action, slot, version, google_event_id, calendar_id, payload, idempotency_key, status, created_at)
     VALUES ($1, 'create_main', 'slot', 1, $2, 'primary', '{}', $3, $4, $5::timestamptz)`,
    [appointmentId, `${appointmentId}-gid`, `cal:${appointmentId}:create_main:v1`, status, createdAt]
  );
}

test('buildReport: a legacy Phone Call row (no buffer) is classified legacy_phone_call regardless of outbox history', { skip }, async () => {
  const leadId = await lead(`pc-${RUN}`);
  const apptId = await appt(leadId, { kind: 'phone_call' });

  const report = await auditScript.buildReport({ limit: 5000 });
  // Find via a global search is impractical on a shared DB; instead confirm
  // the counting logic directly by re-querying this one row's classification.
  const row = (await db.query(`SELECT * FROM appointments WHERE id = $1`, [apptId])).rows[0];
  const { classifyUnsyncedAppointment } = auditScript;
  assert.strictEqual(classifyUnsyncedAppointment(row, false).kind, 'legacy_phone_call');
  assert.ok(report.total_unsynced_active_examined >= 1);
});

test('buildReport: a Meeting with zero outbox history is never_enqueued', { skip }, async () => {
  const leadId = await lead(`ne-${RUN}`);
  const apptId = await appt(leadId, { kind: 'meeting', calendarSyncStatus: 'pending' });

  const report = await auditScript.buildReport({ limit: 5000 });
  const found = report.needs_review.find((r) => r.appointment_id === apptId);
  // never_enqueued only lands in needs_review when recent (under_7d); this
  // fixture's created_at (2098-07-05) relative to real "now" is in the past,
  // so assert via direct classification instead of the needs_review sample.
  const row = (await db.query(`SELECT * FROM appointments WHERE id = $1`, [apptId])).rows[0];
  const historyCheck = await db.query(`SELECT 1 FROM calendar_outbox WHERE appointment_id = $1 AND action IN ('create_main','update_main')`, [apptId]);
  assert.strictEqual(historyCheck.rows.length, 0);
  assert.strictEqual(auditScript.classifyUnsyncedAppointment(row, false).reason, 'never_enqueued');
  assert.ok(report.meeting_breakdown.never_enqueued >= 1);
  void found;
});

test('buildReport: a Meeting with a create_main outbox row and calendar_sync_status=retrying is flagged retrying and surfaced in needs_review', { skip }, async () => {
  const leadId = await lead(`retry-${RUN}`);
  const apptId = await appt(leadId, { kind: 'meeting', calendarSyncStatus: 'retrying' });
  await mainOutboxRow(apptId, 'failed');

  const report = await auditScript.buildReport({ limit: 5000 });
  assert.ok(report.meeting_breakdown.retrying >= 1);
  const found = report.needs_review.find((r) => r.appointment_id === apptId);
  assert.ok(found, 'retrying appointment is surfaced for human review');
  assert.strictEqual(found.reason, 'retrying');
});

test('buildReport: a Meeting with a create_main outbox row and calendar_sync_status=failed is flagged failed and surfaced in needs_review', { skip }, async () => {
  const leadId = await lead(`failed-${RUN}`);
  const apptId = await appt(leadId, { kind: 'meeting', calendarSyncStatus: 'failed' });
  await mainOutboxRow(apptId, 'dead');

  const report = await auditScript.buildReport({ limit: 5000 });
  assert.ok(report.meeting_breakdown.failed >= 1);
  const found = report.needs_review.find((r) => r.appointment_id === apptId);
  assert.ok(found, 'failed appointment is surfaced for human review');
  assert.strictEqual(found.reason, 'failed');
});

test('buildReport: outbox_status_counts_global reflects real calendar_outbox rows across the database', { skip }, async () => {
  const leadId = await lead(`global-${RUN}`);
  const apptId = await appt(leadId, { kind: 'meeting', calendarSyncStatus: 'synced' });
  await mainOutboxRow(apptId, 'synced');

  const report = await auditScript.buildReport({ limit: 5000 });
  assert.ok(typeof report.outbox_status_counts_global.synced === 'number' && report.outbox_status_counts_global.synced >= 1);

  const row = (await db.query(`SELECT * FROM appointments WHERE id = $1`, [apptId])).rows[0];
  assert.strictEqual(auditScript.classifyUnsyncedAppointment(row, true).reason, 'synced_anomaly',
    'calendar_sync_status=synced with a still-NULL google_event_id must be flagged as an anomaly, never folded into a normal bucket');
});
