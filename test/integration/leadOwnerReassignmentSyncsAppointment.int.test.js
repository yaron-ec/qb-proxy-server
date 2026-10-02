/* eslint-disable no-undef */
'use strict';

/**
 * leadOwnerReassignmentSyncsAppointment.int.test.js — REAL-Postgres proof for
 * a HIGH-CONFIDENCE defect found in the system-wide stability audit:
 * PUT /api/v1/leads/:id (the canonical "Edit Lead" endpoint, which Lead
 * Detail's "Owner" field uses — see LeadDetailModern.ownerChange.test.jsx)
 * updated leads.owner_id but never touched the lead's active appointment's
 * owner_id, and never re-synced its Google Calendar event.
 *
 * Concrete failure this reproduced: a lead has an active Appointment under
 * Owner A. An admin reassigns the lead to Owner B via Edit Lead. Before the
 * fix: appointments.owner_id still pointed at Owner A, so Owner B's
 * availability never blocked the slot (double-booking risk) and Owner A's
 * availability stayed blocked for a lead no longer theirs.
 *
 * FIX: PUT /:id now calls the canonical lib/booking/bookingService.js#
 * updateAppointment path (conflict-checked, logs an owner_changed
 * appointment_event, refreshes the Google Calendar attendee) when the
 * lead's owner actually changes and it has an active appointment — never
 * writing to `appointments` directly.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const TZ = 'America/Los_Angeles';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('lib/booking/googleCalendarClient', {
    getAccessToken: async () => 'fake', createOrUpdateEvent: async (_t, _c, b) => ({ id: b.id }),
    updateEvent: async (_t, _c, id) => ({ id }), cancelEvent: async () => ({ ok: true }),
    getEvent: async () => ({ exists: false }), listByExt: async () => [], listEvents: async () => [],
  });
  stub('lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
  stub('lib/googleContactsOutbox', { enqueueContactSync: async () => {} });
}

let base, server, db, token, ownerAId, ownerBId, seededCompanySettingsId;
async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-forwarded-for': `10.6.1.${1 + Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

// Pacific wall-clock date/time `minutes` from now.
function laIn(minutes) {
  const d = new Date(Date.now() + minutes * 60000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const seeded = await db.query(
    `INSERT INTO company_settings (company_name) VALUES ('EC Construction Group') ON CONFLICT DO NOTHING RETURNING id`
  );
  seededCompanySettingsId = seeded.rows[0] ? seeded.rows[0].id : null;
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('owner-a-reassign-test@example.com', 'Owner A ReassignTest') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('owner-b-reassign-test@example.com', 'Owner B ReassignTest') ON CONFLICT DO NOTHING`);
  ownerAId = (await db.query(`SELECT id FROM owners WHERE email = 'owner-a-reassign-test@example.com'`)).rows[0].id;
  ownerBId = (await db.query(`SELECT id FROM owners WHERE email = 'owner-b-reassign-test@example.com'`)).rows[0].id;
  await cancelOwnAppointments();
  token = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000b1', email: 'admin-reassign-test@example.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

async function cancelOwnAppointments() {
  await db.query(`UPDATE appointments SET status = 'cancelled'
                   WHERE status IN ('scheduled', 'confirmed')
                     AND lead_id IN (SELECT id FROM leads WHERE last_name LIKE 'ReassignTest%')`);
}

test.after(async () => {
  if (skip) return;
  // appointments/appointment_events are immutable (no physical DELETE — see
  // db/migrations/2026-08-crm-booking-core.sql's trigger and
  // db/migrations/2026-26-lead-delete-fk-fixes.sql's doc comment), so, same
  // as phoneCallFollowUp.int.test.js's own cleanup, we only cancel the
  // appointment and delete the leads (appointments.lead_id -> SET NULL);
  // the two test owner rows are intentionally left in place (ON CONFLICT DO
  // NOTHING on creation, same pattern other int tests use) since the
  // immutable appointment rows still reference them.
  await cancelOwnAppointments();
  await db.query(`DELETE FROM leads WHERE last_name LIKE 'ReassignTest%'`);
  if (seededCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [seededCompanySettingsId]);
  server.close();
  await db.pool.end();
});

test('reassigning a lead\'s owner via PUT /:id repoints its active appointment\'s owner and frees/blocks the right calendars', { skip }, async () => {
  const { getAvailability } = require(path.join(ROOT, 'lib/booking/availabilityService'));
  const slot = laIn(6 * 60); // 6 hours out — safely inside business hours regardless of time-of-day run

  // 1. Create a lead owned by Owner A.
  const tag = `ReassignTest${Date.now() % 1e7}`;
  const createRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, status, owner_id, source)
     VALUES ('Pat', $1, $2, $3, 'New', $4, 'Referral') RETURNING id`,
    [tag, `${tag.toLowerCase()}@example.com`, `213${String(Date.now() % 1e7).padStart(7, '0')}`, ownerAId]
  );
  const leadId = createRes.rows[0].id;

  // 2. Book an active appointment for it — createAppointmentForLead books
  // under the LEAD's current owner_id (Owner A).
  const book = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: slot.date, appointment_time: slot.time, appointment_type: 'Meeting' });
  assert.strictEqual(book.status, 200, JSON.stringify(book.body));
  const apptBefore = (await db.query(`SELECT id, owner_id, version FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  assert.strictEqual(String(apptBefore.owner_id), String(ownerAId), 'appointment initially books under the lead\'s current owner (Owner A)');

  const avA_before = await getAvailability({ owner_id: ownerAId, date: slot.date, timezone: TZ, duration_minutes: 60 });
  const avB_before = await getAvailability({ owner_id: ownerBId, date: slot.date, timezone: TZ, duration_minutes: 60 });
  assert.ok(avA_before.busy_windows.length > 0, 'Owner A is busy at the booked slot before reassignment');
  assert.deepStrictEqual(avB_before.busy_windows, [], 'Owner B has nothing booked yet');

  // 3. Reassign the LEAD to Owner B via the real Edit Lead endpoint.
  const reassign = await api('PUT', `/api/v1/leads/${leadId}`, { owner_id: ownerBId });
  assert.strictEqual(reassign.status, 200, JSON.stringify(reassign.body));
  assert.strictEqual(String(reassign.body.lead.owner_id), String(ownerBId), 'lead.owner_id is now Owner B (response)');

  // 4. REGRESSION: the appointment's owner_id must now be Owner B too — not
  // left pointing at Owner A.
  const apptAfter = (await db.query(`SELECT id, owner_id, version FROM appointments WHERE id = $1`, [apptBefore.id])).rows[0];
  assert.strictEqual(String(apptAfter.owner_id), String(ownerBId), 'REGRESSION: appointment.owner_id must follow the lead\'s new owner, not stay on the old one');
  assert.ok(Number(apptAfter.version) > Number(apptBefore.version), 'the appointment row was actually updated (version bumped) through bookingService, not left untouched');

  // 5. An appointment_events "owner_changed" row proves this went through
  // the canonical bookingService.updateAppointment path (never a raw
  // `UPDATE appointments` from routes/leads.js).
  const ownerChangedEvent = (await db.query(
    `SELECT previous_values, new_values FROM appointment_events WHERE appointment_id = $1 AND action = 'owner_changed' ORDER BY created_at DESC LIMIT 1`,
    [apptBefore.id]
  )).rows[0];
  assert.ok(ownerChangedEvent, 'an owner_changed appointment_event was recorded');
  assert.strictEqual(String(ownerChangedEvent.new_values.owner_id), String(ownerBId));

  // 6. Availability must have moved with it: Owner A is free again at that
  // slot (no more stale block for a lead no longer theirs); Owner B is now
  // correctly blocked (closing the double-booking risk).
  const avA_after = await getAvailability({ owner_id: ownerAId, date: slot.date, timezone: TZ, duration_minutes: 60 });
  const avB_after = await getAvailability({ owner_id: ownerBId, date: slot.date, timezone: TZ, duration_minutes: 60 });
  assert.deepStrictEqual(avA_after.busy_windows, [], 'REGRESSION: Owner A must be freed once the appointment moves to Owner B');
  assert.ok(avB_after.busy_windows.length > 0, 'REGRESSION: Owner B must now be blocked at the reassigned appointment\'s slot');
});
