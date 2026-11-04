/* eslint-disable no-undef */
'use strict';

/**
 * reminderDiagnosticsAppointment.int.test.js — REAL-Postgres regression
 * proof for a production defect in the new (PR #57) admin-only Appointment
 * Notification Diagnostics panel: clicking "Check" on any lead with a
 * scheduled appointment returned `reminder_diagnostics_failed` (HTTP 500).
 *
 * ROOT CAUSE: lib/reminderDeliveryDiagnostics.js#getAppointmentNotificationDiagnostics
 * selected two columns that do not exist on the tables it queried:
 *   - `leads.assigned_rep` — leads has no such column; ownership is via
 *     leads.owner_id (FK to owners), resolved everywhere else in this
 *     codebase (routes/leads.js#serializeLead) via a LEFT JOIN to owners,
 *     never a direct column.
 *   - `appointments.appointment_type` — appointments has no such column
 *     either; it stores appointment_type_id (FK to appointment_types),
 *     resolved to a human-readable name via a LEFT JOIN
 *     (lib/leadDiagnostic.js already does exactly this for the SAME table).
 *
 * The very first query (the leads lookup) threw on every single call,
 * not just leads with an appointment — but since this diagnostic logic was
 * never exercised against a real Postgres schema before this fix (every
 * existing test used a stubbed db/client.query returning canned rows, which
 * can never catch a column-doesn't-exist error), it shipped undetected
 * through PR #57's CI (which has no DATABASE_URL — see .github/workflows/ci.yml's
 * own header comment) and was only caught by a live production click.
 *
 * This file proves, against a REAL migrated Postgres schema (not mocks),
 * that the full HTTP route now succeeds for a lead with a genuine scheduled
 * appointment, and that the returned data is correct (assigned rep's real
 * display name, the real appointment type name, a non-null notifications
 * block). It is read-only throughout: no reminder/SMS/email is ever sent,
 * no consent or claim row is ever written by this test.
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
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

let base, server, db, adminToken, repToken, ownerId, ownerDisplayName, apptTypeId, apptTypeName;

async function api(method, p, body, tok) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(tok === null ? {} : { authorization: 'Bearer ' + (tok !== undefined ? tok : adminToken) }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  if (skip) return;
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1', require(path.join(ROOT, 'routes/reminderDiagnostics')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000da001', email: `admin-rd-${stamp}@test.example`, role: 'admin' });
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000da002', email: `rep-rd-${stamp}@test.example`, role: 'sales_rep' });

  ownerDisplayName = `Diag Rep ${stamp}`;
  const ownerRes = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, $2) RETURNING id`,
    [`owner-rd-${stamp}@test.example`, ownerDisplayName]
  );
  ownerId = ownerRes.rows[0].id;

  const typeRes = await db.query(`SELECT id, name FROM appointment_types WHERE is_active = true ORDER BY name LIMIT 1`);
  apptTypeId = typeRes.rows[0].id;
  apptTypeName = typeRes.rows[0].name;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('GET /leads/:id/reminder-diagnostics: a lead with a real scheduled appointment returns 200 with correct assigned_rep and appointment type (regression for the production reminder_diagnostics_failed 500)', { skip }, async () => {
  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, owner_id, sms_consent)
     VALUES ('Diag', 'WithAppt', 'diag-with-appt@test.example', '+13235550001', $1, false)
     RETURNING id`,
    [ownerId]
  );
  const leadId = leadRes.rows[0].id;

  const startAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
  await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'America/Los_Angeles', tstzrange($4, $5), 'scheduled', $6)`,
    [leadId, ownerId, apptTypeId, startAt.toISOString(), endAt.toISOString(), `int-test-${leadId}`]
  );

  const res = await api('GET', `/api/v1/leads/${leadId}/reminder-diagnostics`, undefined, adminToken);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.found, true);
  assert.strictEqual(res.body.lead.assigned_rep, ownerDisplayName);
  assert.strictEqual(res.body.appointment.type, apptTypeName);
  assert.strictEqual(res.body.appointment.status, 'scheduled');
  assert.ok(res.body.notifications, 'notifications must be populated once an appointment date/time resolves');
  assert.ok(Array.isArray(res.body.notifications.email) && res.body.notifications.email.length === 5);
  assert.ok(Array.isArray(res.body.notifications.sms) && res.body.notifications.sms.length === 2);
});

test('GET /leads/:id/reminder-diagnostics: a lead with NO appointment still returns 200 with notifications: null (unaffected by the fix)', { skip }, async () => {
  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, owner_id, sms_consent)
     VALUES ('Diag', 'NoAppt', 'diag-no-appt@test.example', '+13235550002', $1, false)
     RETURNING id`,
    [ownerId]
  );
  const leadId = leadRes.rows[0].id;

  const res = await api('GET', `/api/v1/leads/${leadId}/reminder-diagnostics`, undefined, adminToken);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.found, true);
  assert.strictEqual(res.body.lead.assigned_rep, ownerDisplayName);
  assert.strictEqual(res.body.notifications, null);
  assert.ok(res.body.appointment.note);
});

test('GET /leads/:id/reminder-diagnostics: still 401 without a token and 403 for a non-admin, even on the now-fixed path', { skip }, async () => {
  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, owner_id, sms_consent)
     VALUES ('Diag', 'AuthCheck', 'diag-auth-check@test.example', '+13235550003', $1, false)
     RETURNING id`,
    [ownerId]
  );
  const leadId = leadRes.rows[0].id;

  assert.strictEqual((await api('GET', `/api/v1/leads/${leadId}/reminder-diagnostics`, undefined, null)).status, 401);
  assert.strictEqual((await api('GET', `/api/v1/leads/${leadId}/reminder-diagnostics`, undefined, repToken)).status, 403);
});
