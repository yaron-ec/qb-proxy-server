/* eslint-disable no-undef */
'use strict';

/**
 * appointmentRescheduleCalendarSync.int.test.js — real-Postgres proof for
 * the November 2026 "John John" production bug report (a rescheduled
 * appointment not correctly synchronizing with Google Calendar and
 * customer reminders).
 *
 * ROOT CAUSE (confirmed against production data, not guessed): the real
 * `appointments` row for that lead was never touched — zero
 * calendar_outbox rows beyond the original creation existed, proving
 * lib/booking/bookingService.js#rescheduleAppointment was never invoked at
 * all. The new, intended date had only ever been written to
 * leads.follow_up_date/time (a rep used the Follow-Up field instead of the
 * Appointment editor's Reschedule control) — an independent field that,
 * per CLAUDE.md's own "Appointment vs Follow-Up" rule, never moves,
 * cancels, or creates an appointment. So the ACTUAL reschedule/calendar
 * sync code path (routes/leads.js PUT /:id/appointment ->
 * bookingService.rescheduleAppointment -> calendarOutbox -> the worker ->
 * reminder projection) was never exercised by the reported incident, and
 * had, in fact, no dedicated integration test anywhere in this suite
 * before this file — this closes that gap end to end, covering every
 * scenario requested in the bug report's item 7.
 *
 * Google Calendar is an in-memory fake at the
 * lib/booking/googleCalendarClient boundary (same convention as
 * test/integration/phoneCallCalendarReminder.int.test.js /
 * calendarAttendeesIgnoreEmailPreferences.int.test.js); everything else is
 * real (HTTP routes -> bookingService -> calendar_outbox -> the real
 * worker claim/process function -> reminder projection ->
 * lib/crmRepository.listEligibleLeads(), the exact function the reminder
 * engine itself reads from).
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

// ── Fake Google Calendar (supports a scripted transient failure on insert
// AND update, so the retry/idempotent-event-id scenario can be proven) ────
const google = {
  events: new Map(), calls: [], failNextInsert: 0, failNextUpdate: 0,
  reset() { this.events.clear(); this.calls = []; this.failNextInsert = 0; this.failNextUpdate = 0; },
};
const gClient = {
  getAccessToken: async () => 'fake-token',
  createOrUpdateEvent: async (_t, _c, body) => {
    if (google.failNextInsert > 0) { google.failNextInsert--; throw new Error('Calendar insert 503: backend error'); }
    google.calls.push(['insert', body.id]);
    google.events.set(body.id, { ...body, status: 'confirmed' });
    return { id: body.id };
  },
  updateEvent: async (_t, _c, id, body) => {
    if (google.failNextUpdate > 0) { google.failNextUpdate--; throw new Error('Calendar update 503: backend error'); }
    google.calls.push(['put', id]);
    google.events.set(id, { ...body, id, status: body.status || 'confirmed' });
    return { id };
  },
  cancelEvent: async (_t, _c, id) => {
    google.calls.push(['delete', id]);
    const e = google.events.get(id);
    if (e) e.status = 'cancelled';
    return { ok: true };
  },
  getEvent: async (_t, _c, id) => {
    const e = google.events.get(id);
    return e && e.status !== 'cancelled' ? { exists: true, event: e } : { exists: false, reason: 'missing' };
  },
  listByExt: async () => [],
  listEvents: async () => [], // no live conflict checking needed — the test picks disjoint free days
};
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = { id: gPath, filename: gPath, loaded: true, exports: gClient };
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../../lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
}

let base, server, db, token, outbox, crmRepository, pickDay;
async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-forwarded-for': `10.11.0.${1 + Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
async function drain() {
  for (let i = 0; i < 30; i++) if (!(await outbox.claimAndProcess(db.pool, 'reschedule-test-worker', { batchSize: 50 })).claimed) return;
}
function mainEventFor(apptId) {
  return [...google.events.values()].find((e) => e.extendedProperties?.private?.ec_appointment_id === apptId && e.extendedProperties?.private?.ec_kind === 'main');
}
function travelEventFor(apptId) {
  return [...google.events.values()].find((e) => e.extendedProperties?.private?.ec_appointment_id === apptId && e.extendedProperties?.private?.ec_kind === 'travel');
}
let seq = 0;
const randomPhone = () => `${200 + Math.floor(Math.random() * 600)}${200 + Math.floor(Math.random() * 600)}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
async function createLead() {
  seq++;
  const r = await api('POST', '/api/v1/leads', {
    first_name: 'Resched', last_name: `Sync${seq}${Date.now() % 1000000}`, phone: randomPhone(),
    assigned_rep: 'Yaron Drilevich', project_type: 'Kitchen', source: 'Referral',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}
async function activeAppointment(leadId) {
  return (await db.query(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
}
async function eligibleRow(lead) {
  const rows = await crmRepository.listEligibleLeads();
  return rows.find((r) => r.id === (lead.external_ref || lead.id));
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  outbox = require('../../lib/booking/calendarOutbox');
  crmRepository = require('../../lib/crmRepository');
  await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  require('../../lib/companyConfig').invalidate();
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  token = require('../../lib/authService').issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a2', email: 'yaron@ecconstructiongroup.com', role: 'admin' });

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});
test.beforeEach(() => { if (!skip) google.reset(); });

// ── 1. Reschedule to another day ───────────────────────────────────────────
test('1. Rescheduling to another day: old appointment is cancelled (calendar events removed), new one is created, and listEligibleLeads reflects the NEW date only', { skip }, async () => {
  const lead = await createLead();
  const day1 = pickDay();
  const book = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day1, appointment_time: '09:00', appointment_type: 'Meeting' });
  assert.strictEqual(book.status, 200, JSON.stringify(book.body));
  await drain();
  const original = await activeAppointment(lead.id);
  const originalMain = mainEventFor(original.id);
  const originalTravel = travelEventFor(original.id);
  assert.ok(originalMain && originalMain.status !== 'cancelled', 'original main event exists and is live');
  assert.ok(originalTravel && originalTravel.status !== 'cancelled', 'original travel event exists and is live');

  const day2 = pickDay();
  const reschedule = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day2, appointment_time: '14:00', appointment_type: 'Meeting' });
  assert.strictEqual(reschedule.status, 200, JSON.stringify(reschedule.body));
  await drain();

  // Old row flipped to 'rescheduled', never deleted (DB-immutable history).
  const oldRow = (await db.query('SELECT status FROM appointments WHERE id = $1', [original.id])).rows[0];
  assert.strictEqual(oldRow.status, 'rescheduled');
  // Its calendar events are now cancelled — "removes obsolete events safely".
  assert.strictEqual(mainEventFor(original.id).status, 'cancelled', 'old main event was cancelled, not left stale');
  assert.strictEqual(travelEventFor(original.id).status, 'cancelled', 'old travel event was cancelled, not left stale');

  const next = await activeAppointment(lead.id);
  assert.notStrictEqual(next.id, original.id, 'a NEW appointment row was created, not the old one mutated in place');
  assert.strictEqual(next.timezone, 'America/Los_Angeles');
  const newMain = mainEventFor(next.id);
  assert.ok(newMain && newMain.status !== 'cancelled', 'new main event was created and is live');
  assert.ok(travelEventFor(next.id), 'new travel event was created (a real Site Visit always gets travel buffer)');

  // Reminder-aware: the ONE source the reminder engine reads reflects the NEW date only.
  const row = await eligibleRow(lead);
  assert.ok(row, 'lead is still eligible');
  assert.strictEqual(row.appointment_date, day2, 'listEligibleLeads reflects the NEW appointment date');
  assert.strictEqual(row.appointment_time, '14:00', 'listEligibleLeads reflects the NEW appointment time');
});

// ── 2. Multiple successive reschedules ─────────────────────────────────────
test('2. Multiple successive reschedules: every intermediate appointment is superseded+cancelled, only the FINAL one is active, and reminders track the final date', { skip }, async () => {
  const lead = await createLead();
  const day1 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day1, appointment_time: '09:00', appointment_type: 'Meeting' });
  await drain();
  const a1 = await activeAppointment(lead.id);

  const day2 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day2, appointment_time: '10:00', appointment_type: 'Meeting' });
  await drain();
  const a2 = await activeAppointment(lead.id);

  const day3 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day3, appointment_time: '11:00', appointment_type: 'Meeting' });
  await drain();
  const a3 = await activeAppointment(lead.id);

  assert.strictEqual(new Set([a1.id, a2.id, a3.id]).size, 3, 'three distinct appointment rows exist (immutable history)');
  const rows = (await db.query('SELECT id, status FROM appointments WHERE lead_id = $1', [lead.id])).rows;
  assert.strictEqual(rows.find((r) => r.id === a1.id).status, 'rescheduled');
  assert.strictEqual(rows.find((r) => r.id === a2.id).status, 'rescheduled');
  assert.strictEqual(rows.find((r) => r.id === a3.id).status, 'scheduled');

  // Never a duplicate active main event left behind across all three bookings.
  const liveMains = [...google.events.values()].filter((e) => e.extendedProperties?.private?.ec_kind === 'main' && e.status !== 'cancelled');
  assert.strictEqual(liveMains.length, 1, 'exactly ONE live main event exists after two reschedules — no duplicates');
  assert.ok(mainEventFor(a3.id), 'the one live main event belongs to the FINAL appointment');
  assert.strictEqual(mainEventFor(a1.id).status, 'cancelled');
  assert.strictEqual(mainEventFor(a2.id).status, 'cancelled');

  const row = await eligibleRow(lead);
  assert.strictEqual(row.appointment_date, day3, 'reminders track the FINAL date, never an intermediate one');
});

// ── 3. Travel block cancellation ───────────────────────────────────────────
test('3. A reschedule cancels the OLD travel block and creates a correct NEW one', { skip }, async () => {
  const lead = await createLead();
  const day1 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day1, appointment_time: '09:00', appointment_type: 'Meeting' });
  await drain();
  const original = await activeAppointment(lead.id);
  assert.ok(original.google_travel_event_id, 'original booking got a travel event');

  const day2 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day2, appointment_time: '13:00', appointment_type: 'Meeting' });
  await drain();
  const next = await activeAppointment(lead.id);

  assert.strictEqual(travelEventFor(original.id).status, 'cancelled', 'old travel block removed');
  assert.ok(next.google_travel_event_id, 'new appointment has its own travel event');
  assert.notStrictEqual(next.google_travel_event_id, original.google_travel_event_id, 'the new travel event is a distinct event, not a mutated old one');
});

// ── 4. Calendar API failure + retry, duplicate-event prevention ───────────
test('4. A transient Google failure on the new slot is retried by the worker and never produces a duplicate event', { skip }, async () => {
  const lead = await createLead();
  const day1 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day1, appointment_time: '09:00', appointment_type: 'Meeting' });
  await drain();

  const day2 = pickDay();
  google.failNextInsert = 2; // create_main AND create_travel each fail once
  const reschedule = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day2, appointment_time: '15:00', appointment_type: 'Meeting' });
  assert.strictEqual(reschedule.status, 200, JSON.stringify(reschedule.body)); // the HTTP request itself succeeds — the failure is only in the async worker
  await drain(); // first pass: at least one of create_main/create_travel fails and is marked for retry with backoff

  const next = await activeAppointment(lead.id);
  // Force the retry past its backoff window and drain again — same deterministic idempotency_key/google_event_id either way.
  await db.query(`UPDATE calendar_outbox SET next_attempt_at = NOW() WHERE appointment_id = $1 AND status = 'failed'`, [next.id]);
  await drain();

  const mainsForNext = [...google.events.values()].filter((e) => e.extendedProperties?.private?.ec_appointment_id === next.id && e.extendedProperties?.private?.ec_kind === 'main');
  assert.strictEqual(mainsForNext.length, 1, 'the retried create never produced a second, duplicate main event');
  const insertCallsForMain = google.calls.filter((c) => c[0] === 'insert' && c[1] === mainsForNext[0].id);
  assert.strictEqual(insertCallsForMain.length, 1, 'Google only ever actually received ONE successful insert call for this event id (the deterministic id makes a retry idempotent even if Google had seen a failed partial attempt)');
});

// ── 5. Concurrent outbox processing is idempotent (no double-send) ────────
test('5. Two workers claiming the SAME pending outbox rows concurrently never both process the same row', { skip }, async () => {
  const lead = await createLead();
  const day1 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day1, appointment_time: '09:00', appointment_type: 'Meeting' });
  // Deliberately do NOT drain yet — two rows (create_main, create_travel) are pending.
  const [r1, r2] = await Promise.all([
    outbox.claimAndProcess(db.pool, 'worker-a', { batchSize: 50 }),
    outbox.claimAndProcess(db.pool, 'worker-b', { batchSize: 50 }),
  ]);
  await drain();
  // SKIP LOCKED guarantees no row is claimed by both — total successful inserts == total outbox rows, never more.
  const outboxRows = (await db.query(`SELECT co.action, co.status FROM calendar_outbox co JOIN appointments a ON a.id = co.appointment_id WHERE a.lead_id = $1`, [lead.id])).rows;
  assert.strictEqual(outboxRows.length, 2);
  assert.ok(outboxRows.every((r) => r.status === 'synced'), 'both rows ended up synced exactly once each');
  const insertsForLead = google.calls.filter((c) => c[0] === 'insert').length;
  assert.strictEqual(insertsForLead, 2, 'exactly one insert per outbox row — concurrency never caused a duplicate');
  assert.ok(r1.claimed || r2.claimed, 'at least one concurrent caller actually claimed work');
});

// ── 6. Stale reminder suppression across the FULL claim lifecycle ─────────
test('6. A reminder_claims row already SENT for the old date is never re-picked-up, and the new date gets its own fresh eligibility', { skip }, async () => {
  const lead = await createLead();
  const day1 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day1, appointment_time: '09:00', appointment_type: 'Meeting' });
  await drain();

  // Simulate a reminder having already fired for the OLD date, as would happen in production.
  const rid = lead.external_ref || lead.id;
  await db.query(
    `INSERT INTO reminder_claims (reminder_key, lead_id, appointment_date, reminder_window, status, owner, lease_expires_at)
     VALUES ($1, $2, $3, '24h', 'sent', 'test:1', NOW())`,
    [`reminder:${rid}:24h:${day1}`, rid, day1]
  );

  const day2 = pickDay();
  await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day2, appointment_time: '16:00', appointment_type: 'Meeting' });
  await drain();

  // The old claim row is untouched (immutable history of what was actually sent) ...
  const oldClaim = (await db.query(`SELECT status, appointment_date FROM reminder_claims WHERE reminder_key = $1`, [`reminder:${rid}:24h:${day1}`])).rows[0];
  assert.strictEqual(oldClaim.status, 'sent');
  // ... but the live projection the engine actually reads from reflects ONLY the new date, so
  // the engine can never again compute a reminder window against the superseded date.
  const row = await eligibleRow(lead);
  assert.strictEqual(row.appointment_date, day2);
  assert.notStrictEqual(row.appointment_date, day1);

  await db.query('DELETE FROM reminder_claims WHERE reminder_key = $1', [`reminder:${rid}:24h:${day1}`]);
});
