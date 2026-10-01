/* eslint-disable no-undef */
'use strict';

/**
 * phoneCallNeverAppointment.int.test.js — REAL-Postgres regression for the
 * canonical rule (production defect: a "Driving / Travel Time" block shown next
 * to a Phone Call):
 *
 *   A Phone Call (and a Meeting follow-up) is a CRM follow-up. It never becomes
 *   an appointments row, never blocks availability, never reserves the 1h
 *   buffer and never produces a Driving / Travel Time event. Only a real
 *   Appointment / Site Visit does — and a travel event only ever exists for an
 *   ACTIVE Site Visit (enforced when queued AND when the calendar worker runs).
 *
 * Cases A–J map to the required checks. Google Calendar is an in-memory fake at
 * the lib/booking/googleCalendarClient boundary; everything else is real
 * (routes → bookingService → calendar outbox → worker → reminder projection).
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const TZ = 'America/Los_Angeles';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

const google = { events: new Map(), reset() { this.events.clear(); } };
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      createOrUpdateEvent: async (_t, _c, body) => { google.events.set(body.id, { ...body, status: 'confirmed' }); return { id: body.id }; },
      updateEvent: async (_t, _c, id, body) => { google.events.set(id, { ...body, id, status: 'confirmed' }); return { id }; },
      cancelEvent: async (_t, _c, id) => { const e = google.events.get(id); if (e) e.status = 'cancelled'; return { ok: true }; },
      getEvent: async (_t, _c, id) => { const e = google.events.get(id); return e && e.status !== 'cancelled' ? { exists: true } : { exists: false, reason: 'missing' }; },
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../../lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
}

let base, server, db, token, outbox, ownerId, pickDay;
let ipSeq = 1;
async function api(method, path, body, tok) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.9.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`,
      ...(tok === null ? {} : { authorization: 'Bearer ' + (tok || token) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
const rnd = (lo, n) => lo + Math.floor(Math.random() * n);
const randomPhone = () => `${rnd(200, 800)}${rnd(200, 800)}${String(rnd(0, 10000)).padStart(4, '0')}`;
let seq = 0;
const payload = (extra) => ({
  first_name: 'Pc', last_name: `Rule${++seq}${Date.now() % 100000}`, phone: randomPhone(),
  project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich', ...extra,
});
async function capture(extra) {
  const r = await api('POST', '/api/public/capture', payload(extra), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.lead.id;
}
async function drain() {
  for (let i = 0; i < 20; i++) if (!(await outbox.claimAndProcess(db.pool, 'pc-rule-worker', { batchSize: 50 })).claimed) return;
}
async function parkForeignOutbox() {
  await db.query(`UPDATE calendar_outbox SET next_attempt_at = '2999-01-01' WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()`);
}
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const apptsOf = (leadId) => rows('SELECT * FROM appointments WHERE lead_id = $1 ORDER BY created_at', [leadId]);
const outboxOf = (leadId) => rows(
  'SELECT o.action, o.status, o.last_error, o.google_event_id FROM calendar_outbox o JOIN appointments a ON a.id = o.appointment_id WHERE a.lead_id = $1 ORDER BY o.created_at', [leadId]);
const activeGoogle = (apptIds, kind) => [...google.events.values()].filter(e => e.status !== 'cancelled'
  && apptIds.includes(e.extendedProperties.private.ec_appointment_id) && (!kind || e.extendedProperties.private.ec_kind === kind));
async function lead(id) { const r = await api('GET', `/api/v1/leads/${id}`); assert.strictEqual(r.status, 200); return r.body.lead; }

// A legacy Phone Call booking (pre-rule data): unbuffered row, synced to Google,
// optionally carrying an INVALID Driving / Travel Time artifact.
async function legacyPhoneCall(leadId, day, hhmm, { withTravel = false } = {}) {
  const { toUtcIso } = require('../../lib/booking/slotBlocking');
  const start = toUtcIso(day, hhmm, TZ);
  const type = (await rows("SELECT id FROM appointment_types WHERE name = 'Consultation'"))[0].id;
  const a = (await rows(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                               idempotency_key, calendar_sync_status, google_event_id, google_travel_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', $5,
             tstzrange($4::timestamptz, $4::timestamptz + interval '1 hour', '[)'), 'scheduled', $6, 'synced', $7, $8)
     RETURNING *`,
    [leadId, ownerId, type, start, TZ, `legacy-pc-${Date.now()}-${Math.random()}`, `legacymain${seq}${Date.now()}`,
      withTravel ? `legacytravel${seq}${Date.now()}` : null]))[0];
  const ext = (kind) => ({ private: { ec_appointment_id: a.id, ec_kind: kind } });
  google.events.set(a.google_event_id, { id: a.google_event_id, status: 'confirmed', summary: 'Phone Call with X', extendedProperties: ext('main') });
  if (withTravel) google.events.set(a.google_travel_event_id, { id: a.google_travel_event_id, status: 'confirmed', summary: 'Driving / Travel Time', extendedProperties: ext('travel') });
  return a;
}

let googleModulesState;

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  outbox = require('../../lib/booking/calendarOutbox');
  // PRODUCTIZATION: this file asserts real Site Visit main+travel Google
  // Calendar events — see ensureGoogleModulesEnabled.js.
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  require('../../lib/companyConfig').invalidate();
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  ownerId = (await rows(`SELECT id FROM owners WHERE email = 'yaron@ecconstructiongroup.com'`))[0].id;
  token = require('../../lib/authService').issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  app.use('/api/public/capture', require('../../routes/publicCapture'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  server.close();
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});
test.beforeEach(async () => { if (!skip) { google.reset(); await parkForeignOutbox(); } });

test('A/B/C/D. Phone Call at 10:00 → follow-up only (no row, no buffer, no travel); a Site Visit books at 10:00; call reminder kept', { skip }, async () => {
  const day = pickDay();
  // Phone Call requested as an "appointment" on capture → saved as the follow-up.
  const callLead = await capture({ appointment_date: day, appointment_time: '10:00', appointment_type: 'Phone Call' });
  const l = await lead(callLead);
  assert.deepStrictEqual([l.follow_up_date, l.follow_up_time, l.follow_up_type], [day, '10:00', 'Phone Call']);
  assert.strictEqual(l.appointment, null);
  assert.deepStrictEqual(await apptsOf(callLead), [], 'B/C: no appointments row → no buffer');
  assert.deepStrictEqual(await outboxOf(callLead), [], 'B: no Google event, no Driving / Travel Time');
  // A. A real Site Visit books at exactly the same time for the same owner.
  const visitLead = await capture({ appointment_date: day, appointment_time: '10:00' });
  assert.strictEqual((await apptsOf(visitLead)).length, 1);
  // D. The Phone Call keeps its legitimate customer reminder source.
  const { getCallMs } = require('../../lib/phoneCallReminders');
  const rl = (await rows('SELECT * FROM reminder_leads WHERE id = $1', [l.external_ref || l.id]))[0];
  const call = getCallMs(rl);
  assert.ok(call, 'the call reminder source survives');
  assert.deepStrictEqual([call.date, call.time], [day, '10:00']);
});

test('A2. PUT /appointment with appointment_type "Phone Call" saves the follow-up and never books; a Site Visit on the lead is untouched', { skip }, async () => {
  const day = pickDay();
  const id = await capture({ appointment_date: day, appointment_time: '14:00' });
  const visit = (await apptsOf(id))[0];
  const r = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '09:00', appointment_type: 'Phone Call' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.action, 'phone_call_saved_as_follow_up');
  assert.deepStrictEqual([r.body.lead.follow_up_date, r.body.lead.follow_up_time, r.body.lead.follow_up_type], [day, '09:00', 'Phone Call']);
  const after = await apptsOf(id);
  assert.deepStrictEqual(after.map(a => [a.id, a.status]), [[visit.id, 'scheduled']], 'the Site Visit is unchanged; no Phone Call row');
  // The call time stays bookable for a real appointment.
  await capture({ appointment_date: day, appointment_time: '09:00' });
});

test('E. Meeting follow-up → zero appointment row, zero calendar_outbox rows — but PERMANENT RULE: it now blocks availability like a real Appointment Meeting, and a DIFFERENT lead cannot double-book over it', { skip }, async () => {
  const day = pickDay();
  const id = await capture({ follow_up_date: day, follow_up_time: '11:00', follow_up_type: 'Meeting' });
  assert.deepStrictEqual(await apptsOf(id), [], 'still never an appointments row');
  assert.deepStrictEqual(await outboxOf(id), [], 'its calendar presence is reconciled via followUpReminders.js, never calendar_outbox');
  const { getAvailability } = require('../../lib/booking/availabilityService');
  const av = await getAvailability({ owner_id: ownerId, date: day, timezone: TZ, duration_minutes: 60 });
  for (const s of ['10:00', '10:30', '11:00', '11:30']) assert.ok(av.blocked_slots.includes(s), `${s} blocked`);
  assert.ok(!av.blocked_slots.includes('09:00') && !av.blocked_slots.includes('13:00'), 'boundaries stay free');
  // A DIFFERENT lead cannot book the same owner over it (write-path parity).
  const other = await api('POST', '/api/public/capture', payload({ appointment_date: day, appointment_time: '11:00' }), null);
  assert.strictEqual(other.status, 409, JSON.stringify(other.body));
  // Converting THIS SAME lead's own Meeting follow-up into a real appointment
  // at the exact same time is the expected flow, never a self-conflict.
  const own = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '11:00', appointment_type: 'Meeting' });
  assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  assert.strictEqual((await apptsOf(id)).length, 1);
});

test('F/G. Site Visit → main event + ONE Driving / Travel Time after it, 1h buffers, exact boundary rule', { skip }, async () => {
  const day = pickDay();
  const id = await capture({ appointment_date: day, appointment_time: '12:00' });
  const [a] = await apptsOf(id);
  const b = (await rows(`SELECT lower(busy_range) = start_at - interval '1 hour' AND upper(busy_range) = end_at + interval '1 hour' AS ok FROM appointments WHERE id = $1`, [a.id]))[0];
  assert.strictEqual(b.ok, true, 'buffer 1h before + duration + 1h after');
  await drain();
  const travel = activeGoogle([a.id], 'travel');
  assert.strictEqual(travel.length, 1);
  assert.strictEqual(travel[0].summary, 'Driving / Travel Time');
  assert.strictEqual(activeGoogle([a.id], 'main').length, 1);
  assert.match(activeGoogle([a.id], 'main')[0].summary, /^Meeting with /);
  const { toUtcIso } = require('../../lib/booking/slotBlocking');
  const { acquireOwnerLockAndCheckConflict } = require('../../lib/booking/appointmentWriter');
  const allows = async (hhmm) => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const s = new Date(toUtcIso(day, hhmm, TZ));
      await acquireOwnerLockAndCheckConflict(c, ownerId, s, new Date(s.getTime() + 3600000), null, false);
      return true;
    } catch (e) { if (e.code === 'SLOT_CONFLICT') return false; throw e; } finally { await c.query('ROLLBACK'); c.release(); }
  };
  assert.deepStrictEqual([await allows('13:59'), await allows('14:00'), await allows('10:01'), await allows('10:00')], [false, true, false, true]);
});

test('H. Reschedule / cancel a Site Visit leaves no orphan main or travel event', { skip }, async () => {
  const day = pickDay();
  const id = await capture({ appointment_date: day, appointment_time: '09:00' });
  await drain();
  const r = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '15:00', appointment_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await drain();
  const ids = (await apptsOf(id)).map(a => a.id);
  assert.strictEqual(activeGoogle(ids, 'main').length, 1);
  assert.strictEqual(activeGoogle(ids, 'travel').length, 1, 'exactly one travel event, at the new slot');
  const c = await api('PUT', `/api/v1/leads/${id}/appointment`, { cancel: true });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  await drain();
  assert.deepStrictEqual(activeGoogle(ids), [], 'cancel removes main + travel');
  const cur = (await apptsOf(id)).find(a => a.status === 'cancelled');
  assert.strictEqual(cur.google_travel_event_id, null, 'the cancelled travel event is unlinked');
});

test('H2. A legacy Phone Call booking (with an invalid travel artifact) moved via the editor → follow-up; its main + travel removed', { skip }, async () => {
  const day = pickDay();
  const id = await capture({});
  const legacy = await legacyPhoneCall(id, day, '10:00', { withTravel: true });
  const noType = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '11:00' });
  assert.strictEqual(noType.status, 400, 'a missing type never silently turns a legacy call into a Site Visit');
  assert.strictEqual(noType.body.error, 'appointment_type_required');
  const asVisit = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '11:00', appointment_type: 'Meeting' });
  assert.strictEqual(asVisit.status, 409, 'the legacy call row is never re-booked as a Site Visit');
  assert.strictEqual(asVisit.body.error, 'legacy_phone_call_booking');
  const r = await api('PUT', `/api/v1/leads/${id}/appointment`, {
    appointment_date: day, appointment_time: '11:00', appointment_type: 'Phone Call', expected_appointment_id: legacy.id,
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.legacy_phone_call_appointment_cancelled, true);
  assert.deepStrictEqual([r.body.lead.follow_up_time, r.body.lead.follow_up_type, r.body.lead.appointment], ['11:00', 'Phone Call', null]);
  await drain();
  assert.deepStrictEqual(activeGoogle([legacy.id]), [], 'legacy main AND the invalid travel artifact are gone');
  const { rescheduleAppointment, BookingError } = require('../../lib/booking/bookingService');
  const again = await legacyPhoneCall(id, day, '16:00');
  await assert.rejects(rescheduleAppointment(again.id, { new_start_at: new Date().toISOString() }),
    (e) => e instanceof BookingError && e.code === 'phone_call_is_follow_up', 'the booking service never re-books a Phone Call');
});

test('I. Workers can never (re)create a travel event for a Phone Call, a cancelled appointment or a stale slot', { skip }, async () => {
  const day = pickDay();
  const id = await capture({});
  const legacy = await legacyPhoneCall(id, day, '13:00');
  // enqueueCreate / enqueueUpdate refuse travel even when the caller says "not a Phone Call".
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await outbox.enqueueCreate(c, { ...legacy, version: 7 }, { first_name: 'X' }, 'yaron@ecconstructiongroup.com', false);
    await outbox.enqueueUpdate(c, { ...legacy, google_travel_event_id: null, version: 8 }, { first_name: 'X' }, 'yaron@ecconstructiongroup.com', 8, false);
    await c.query('COMMIT');
  } finally { c.release(); }
  assert.ok(!(await outboxOf(id)).some(o => /_travel$/.test(o.action) && o.action !== 'cancel_travel'), 'no travel create/update queued');
  // A travel create queued BEFORE the row became invalid is refused by the worker.
  const travelOp = outbox.buildOperation({ ...legacy, busy_range: null }, { first_name: 'X' }, 'y', 'travel');
  await db.query(
    `INSERT INTO calendar_outbox (appointment_id, action, slot, version, google_event_id, calendar_id, payload, idempotency_key, status)
     VALUES ($1, 'create_travel', $2, 99, $3, 'cal', $4, $5, 'pending')`,
    [legacy.id, travelOp.slot, travelOp.googleEventId, JSON.stringify(travelOp.body), `stale-travel-${legacy.id}`]);
  await drain();
  assert.deepStrictEqual(activeGoogle([legacy.id], 'travel'), []);
  const skipped = (await outboxOf(id)).find(o => o.action === 'create_travel');
  assert.strictEqual(skipped.status, 'synced');
  assert.match(skipped.last_error, /^skipped: travel_not_allowed/);
  // Reconciliation re-creates a missing event ONLY through enqueueCreate, whose
  // travel guard was exercised above — it has no travel path of its own.
  const src = require('fs').readFileSync(require.resolve('../../lib/booking/calendarOutbox'), 'utf8');
  const recon = src.slice(src.indexOf('async function reconcileSyncedAppointments'));
  assert.match(recon, /await enqueueCreate\(/);
  assert.doesNotMatch(recon, /create_travel|buildOperation\([^)]*'travel'\)/);
});

test('J. Availability shown in the UI and the write-path conflict check agree; Phone Calls never block either', { skip }, async () => {
  const day = pickDay();
  await capture({ follow_up_date: day, follow_up_time: '10:00', follow_up_type: 'Phone Call' });
  await legacyPhoneCall(await capture({}), day, '15:00');
  await capture({ appointment_date: day, appointment_time: '12:00' });
  const { getAvailability } = require('../../lib/booking/availabilityService');
  const { SLOTS, toUtcIso } = require('../../lib/booking/slotBlocking');
  const { acquireOwnerLockAndCheckConflict } = require('../../lib/booking/appointmentWriter');
  const av = await getAvailability({ owner_id: ownerId, date: day, timezone: TZ, duration_minutes: 60 });
  const blocked = new Set(av.blocked_slots);
  const mismatches = [];
  for (const slot of SLOTS) {
    const c = await db.pool.connect();
    let ok = true;
    try {
      await c.query('BEGIN');
      const s = new Date(toUtcIso(day, slot, TZ));
      await acquireOwnerLockAndCheckConflict(c, ownerId, s, new Date(s.getTime() + 3600000), null, false);
    } catch (e) { if (e.code === 'SLOT_CONFLICT') ok = false; else throw e; } finally { await c.query('ROLLBACK'); c.release(); }
    if (ok === blocked.has(slot)) mismatches.push(slot);
  }
  assert.deepStrictEqual(mismatches, []);
  assert.ok(!blocked.has('15:00') && !blocked.has('15:30'), 'a legacy Phone Call never blocks');
  assert.ok(blocked.has('12:00') && blocked.has('13:30'), 'the Site Visit blocks its buffered window');
});
