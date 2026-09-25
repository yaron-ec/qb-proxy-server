/* eslint-disable no-undef */
'use strict';

/**
 * meetingFollowUp.int.test.js — REAL-Postgres regression test: a Follow-Up
 * of type 'Meeting' is STILL ONLY A FOLLOW-UP.
 *
 * Runs only when TEST_DATABASE_URL points at a DISPOSABLE, migrated database
 * (same harness as appointmentFollowUp.int.test.js); skipped otherwise:
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/crm_int \
 *     node --test test/integration/meetingFollowUp.int.test.js
 *
 * Proves, end to end through HTTP → routes → bookingService → calendar
 * outbox worker → reminder projection → availability → routing:
 *   Meeting can be selected/saved and survives reload; it creates zero
 *   appointments, zero Google Calendar events, zero travel events, blocks no
 *   slot, produces no customer appointment reminder and no driving stop; a
 *   real Appointment can be booked at the exact same time (and behaves
 *   exactly as before — buffered, blocking, main + travel events); a Phone
 *   Call follow-up remains non-blocking.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

// ── Fakes at the external-API boundaries (Google Calendar, Google Maps) ──────
const google = { events: new Map(), createCalls: 0 };
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      createOrUpdateEvent: async (_t, _cal, body) => {
        google.createCalls++;
        const existed = google.events.has(body.id) && google.events.get(body.id).status !== 'cancelled';
        google.events.set(body.id, { ...body, status: 'confirmed' });
        return { id: body.id, alreadyExisted: existed };
      },
      updateEvent: async (_t, _cal, id, body) => { google.events.set(id, { ...body, id, status: 'confirmed' }); return { id }; },
      cancelEvent: async (_t, _cal, id) => { const e = google.events.get(id); if (e) e.status = 'cancelled'; return { ok: true, alreadyGone: !e }; },
      getEvent: async (_t, _cal, id) => { const e = google.events.get(id); return e && e.status !== 'cancelled' ? { exists: true } : { exists: false, reason: 'missing' }; },
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };
  const mPath = require.resolve('../../lib/googleMapsClient');
  require.cache[mPath] = {
    id: mPath, filename: mPath, loaded: true,
    exports: {
      isConfigured: () => true,
      normalizeAddress: (a, c) => [a, c].filter(Boolean).join(', '),
      geocodeAddress: async () => null,
      computeRoute: async () => null,
    },
  };
}

let base, server, db, token, outbox, ownerId;
const ADMIN = { id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
let ipSeq = 1;

async function api(method, path, body, tok) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.1.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`,
      ...(tok === null ? {} : { authorization: 'Bearer ' + (tok || token) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

let seq = 0;
function capturePayload(extra) {
  seq++;
  return {
    first_name: 'Mtg', last_name: `FollowUp${seq}${Date.now() % 100000}`,
    phone: `555${String(2000000 + seq * 7919 + (Date.now() % 1000)).slice(-7)}`,
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich',
    property_address: '123 Main St', city: 'Los Angeles',
    ...extra,
  };
}

let dayOffset = Math.floor(Math.random() * 20000) * 3 + 1;
function uniqueDay() {
  dayOffset += 3;
  return new Date(Date.UTC(2033, 0, 5 + dayOffset)).toISOString().slice(0, 10);
}

async function drainOutbox() {
  for (let i = 0; i < 20; i++) {
    const r = await outbox.claimAndProcess(db.pool, 'int-test-worker', { batchSize: 50 });
    if (!r.claimed) return;
  }
}

async function getLead(id) {
  const r = await api('GET', `/api/v1/leads/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.lead;
}

async function counts(leadId) {
  const a = await db.query('SELECT count(*)::int AS n FROM appointments WHERE lead_id = $1', [leadId]);
  const o = await db.query(
    'SELECT count(*)::int AS n FROM calendar_outbox o JOIN appointments a ON a.id = o.appointment_id WHERE a.lead_id = $1', [leadId]);
  const apptIds = new Set((await db.query('SELECT id FROM appointments WHERE lead_id = $1', [leadId])).rows.map(r => r.id));
  const events = [...google.events.values()].filter(e => apptIds.has(e.extendedProperties?.private?.ec_appointment_id));
  return { appointments: a.rows[0].n, outbox: o.rows[0].n, events: events.length };
}

async function availability(date) {
  const { getAvailability } = require('../../lib/booking/availabilityService');
  return getAvailability({ owner_id: ownerId, date, timezone: 'America/Los_Angeles', duration_minutes: 60 });
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  outbox = require('../../lib/booking/calendarOutbox');
  const { issueAccessToken } = require('../../lib/authService');
  await db.query(
    `INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich')
     ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'yaron@ecconstructiongroup.com' ORDER BY created_at ASC LIMIT 1`)).rows[0].id;
  token = issueAccessToken(ADMIN);
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  app.use('/api/v1/routing', require('../../routes/routing'));
  app.use('/api/public/capture', require('../../routes/publicCapture'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await drainOutbox(); // start from an idle outbox (earlier runs against the same DB)
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

let leadId, day;

test('M1. Meeting follow-up can be saved (New Lead + Lead Detail PUT /:id/follow-up) and survives reload', { skip }, async () => {
  day = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({
    follow_up_date: day, follow_up_time: '11:00', follow_up_type: 'Meeting', follow_up_notes: 'Walk the site with the client',
  }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.appointment, null, 'a Meeting follow-up never books an appointment');
  leadId = r.body.lead.id;

  // Lead Detail: change it to a different type, then back to Meeting.
  const t = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_type: 'Text' });
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  const m = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, {
    follow_up_date: day, follow_up_time: '11:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  assert.strictEqual(m.body.lead.follow_up_type, 'Meeting');

  const lead = await getLead(leadId); // reload
  assert.strictEqual(lead.follow_up_type, 'Meeting');
  assert.strictEqual(lead.follow_up_date, day);
  assert.strictEqual(lead.follow_up_time, '11:00');
  assert.strictEqual(lead.follow_up_status, 'pending');
  assert.strictEqual(lead.appointment, null);
  assert.strictEqual(lead.appointment_date, null);
  assert.strictEqual(lead.appointment_type, null);
  assert.strictEqual(lead.google_event_id, null);
});

test('M2. Zero appointments, zero Google Calendar events, zero travel events', { skip }, async () => {
  await drainOutbox();
  assert.deepStrictEqual(await counts(leadId), { appointments: 0, outbox: 0, events: 0 });
  // No Google Calendar event (main or travel) mentions this lead at all.
  const { last_name } = (await db.query('SELECT last_name FROM leads WHERE id = $1', [leadId])).rows[0];
  const mentions = [...google.events.values()].filter(e => JSON.stringify(e).includes(last_name) || JSON.stringify(e).includes(leadId));
  assert.deepStrictEqual(mentions, []);
});

test('M3. No slot is blocked by the Meeting follow-up (no 1h buffer, no availability impact)', { skip }, async () => {
  const av = await availability(day);
  assert.deepStrictEqual(av.busy_windows, []);
  assert.deepStrictEqual(av.blocked_slots, []);
});

test('M4. No customer appointment reminder: the projection carries no appointment and the engine sees none', { skip }, async () => {
  const { getAppointmentMs } = require('../../lib/reminderEngine');
  const { getCallMs } = require('../../lib/phoneCallReminders');
  const rl = (await db.query(
    'SELECT * FROM reminder_leads WHERE id IN (SELECT COALESCE(external_ref, id::text) FROM leads WHERE id = $1)', [leadId])).rows[0];
  assert.ok(rl, 'the follow-up is projected into reminder_leads');
  assert.strictEqual(rl.follow_up_type, 'Meeting');
  assert.strictEqual(rl.appointment_date, null);
  assert.strictEqual(rl.appointment_type, null);
  assert.strictEqual(getAppointmentMs(rl), null, 'no appointment reminder windows');
  assert.strictEqual(getCallMs(rl), null, 'no phone-call reminder either');
  const claims = await db.query(
    `SELECT count(*)::int AS n FROM reminder_claims WHERE lead_id IN (SELECT COALESCE(external_ref, id::text) FROM leads WHERE id = $1)`, [leadId]);
  assert.strictEqual(claims.rows[0].n, 0);
});

test('M5. No driving stop: routing lists no appointment for a Meeting follow-up', { skip }, async () => {
  const r = await api('GET', `/api/v1/routing/daily-schedule?date=${day}&owner=all`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.appointments, []);
  assert.deepStrictEqual(r.body.schedule, []);
});

test('M6. A real Appointment can be booked at the exact same time; existing Appointment behavior is unchanged', { skip }, async () => {
  const r = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: day, appointment_time: '11:00', appointment_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const lead = await getLead(leadId);
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '11:00');
  assert.strictEqual(lead.appointment_type, 'Meeting');
  // The follow-up is untouched and still only a follow-up.
  assert.strictEqual(lead.follow_up_type, 'Meeting');
  assert.strictEqual(lead.follow_up_date, day);

  // Exactly one appointment, buffered 1h each side (Meeting behavior unchanged).
  const rows = (await db.query(
    `SELECT start_at, end_at, lower(busy_range) AS bs, upper(busy_range) AS be FROM appointments WHERE lead_id = $1`, [leadId])).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(new Date(rows[0].start_at) - new Date(rows[0].bs), 3600000);
  assert.strictEqual(new Date(rows[0].be) - new Date(rows[0].end_at), 3600000);

  // Google Calendar: main + travel for the APPOINTMENT only.
  await drainOutbox();
  const after = await getLead(leadId);
  assert.ok(after.google_event_id, 'appointment main event synced');
  assert.ok(after.google_travel_event_id, 'appointment travel event synced');

  // It (and only it) now blocks availability around 11:00.
  const av = await availability(day);
  assert.strictEqual(av.busy_windows.length, 1);
  assert.ok(av.blocked_slots.includes('11:00'));

  // A second appointment for the same owner overlapping it is still rejected.
  const other = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '11:30' }), null);
  assert.strictEqual(other.status, 409, JSON.stringify(other.body));

  // Routing now has exactly one stop — the appointment.
  const route = await api('GET', `/api/v1/routing/daily-schedule?date=${day}&owner=all`);
  assert.strictEqual(route.status, 200, JSON.stringify(route.body));
  const stops = (route.body.schedule || []).filter(s => s.id === leadId || s.lead_id === leadId);
  assert.strictEqual(stops.length, 1, JSON.stringify(route.body.schedule));
});

test('M7. A Phone Call follow-up remains non-blocking (no appointment, no calendar, no busy window)', { skip }, async () => {
  const d = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({
    follow_up_date: d, follow_up_time: '10:00', follow_up_type: 'Phone Call',
  }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  await drainOutbox();
  assert.deepStrictEqual(await counts(r.body.lead.id), { appointments: 0, outbox: 0, events: 0 });
  const av = await availability(d);
  assert.deepStrictEqual(av.blocked_slots, []);
  const booked = await api('POST', '/api/public/capture', capturePayload({ appointment_date: d, appointment_time: '10:00' }), null);
  assert.strictEqual(booked.status, 201, 'a real appointment books at the same time as the Phone Call follow-up');
});
