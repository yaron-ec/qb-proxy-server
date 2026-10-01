/* eslint-disable no-undef */
'use strict';

/**
 * meetingFollowUp.int.test.js — REAL-Postgres regression test: a Follow-Up
 * of type 'Meeting' is still only a FOLLOW-UP RECORD (never an `appointments`
 * row), but — PERMANENT RULE, post-Jamey-Corey production defect — an ACTIVE
 * one now gets the SAME physical-meeting SCHEDULING SEMANTICS as a real
 * Appointment once reconciled: 1h duration, a BUSY main calendar event, a
 * Driving/Travel Time event via the canonical travel engine
 * (calendarOutbox.js#buildOperation, reused through a virtual-appointment
 * adapter — never a second implementation), and it blocks availability.
 *
 * Runs only when TEST_DATABASE_URL points at a DISPOSABLE, migrated database
 * (same harness as appointmentFollowUp.int.test.js); skipped otherwise:
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/crm_int \
 *     node --test test/integration/meetingFollowUp.int.test.js
 *
 * Proves, end to end through HTTP → routes → bookingService → followUpReminders
 * reconciler → calendarOutbox.buildOperation → availability → routing:
 *   Meeting can be selected/saved and survives reload; it creates zero
 *   appointments rows; once reconciled it gets exactly one physical-meeting
 *   representation (main + travel, no separate generic 15-min reminder in
 *   addition); it blocks its own slot (1h buffer each side); it appears as a
 *   routing.js driving stop; a real Appointment can still be booked at the
 *   exact same time (and behaves exactly as before — buffered, blocking,
 *   main + travel events, and wins the mirror-dedup against the Follow-Up in
 *   routing); a Phone Call follow-up remains the old free/non-blocking
 *   reminder treatment. See test/integration/phoneCallCalendarReminder.int.test.js
 *   case N for the Phone Call/Text/Email/Other reminder-only proof, and
 *   test/followUpMeeting.test.js for the pure-unit adapter/DST proof.
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
// Random 10-digit phone per lead: the test DB persists between runs, and a phone
// reused from an earlier run is (correctly) rejected by duplicate-lead prevention
// (exact phone-suffix match) with a 409 potential_duplicate.
const rnd = (lo, n) => lo + Math.floor(Math.random() * n);
const randomPhone = () => `${rnd(200, 800)}${rnd(200, 800)}${String(rnd(0, 10000)).padStart(4, '0')}`;
function capturePayload(extra) {
  seq++;
  return {
    first_name: 'Mtg', last_name: `FollowUp${seq}${Date.now() % 100000}`,
    phone: randomPhone(),
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich',
    property_address: '123 Main St', city: 'Los Angeles',
    ...extra,
  };
}

let pickDay; // set in test.before from ./freeDays (days with no appointment)
function uniqueDay() { return pickDay(); }

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

async function availability(date, excludeLeadId) {
  const { getAvailability } = require('../../lib/booking/availabilityService');
  return getAvailability({ owner_id: ownerId, date, timezone: 'America/Los_Angeles', duration_minutes: 60, exclude_lead_id: excludeLeadId });
}

// The Meeting Follow-Up's physical-meeting representation is reconciled by
// followUpReminders.js (calling calendarOutbox.buildOperation directly via a
// virtual-appointment adapter) — a SEPARATE mechanism from calendar_outbox /
// drainOutbox(), which only processes real `appointments` rows.
const reconcile = (now) => require('../../lib/booking/followUpReminders')
  .reconcileFollowUpReminders(db.pool, { google: require('../../lib/booking/googleCalendarClient'), limit: 100000, delayMs: 0, crmPublicUrl: '', ...(now ? { now } : {}) });

// Events tagged with the virtual appointment id `followup-meeting:<leadId>:g*`
// (calendarOutbox.js's extendedProperties.private.ec_appointment_id).
function liveMeetingEvents(leadId, kind) {
  return [...google.events.values()].filter((e) =>
    e.status !== 'cancelled'
    && typeof e.extendedProperties?.private?.ec_appointment_id === 'string'
    && e.extendedProperties.private.ec_appointment_id.startsWith(`followup-meeting:${leadId}:`)
    && (!kind || e.extendedProperties.private.ec_kind === kind));
}
function liveReminderEvents(leadId) {
  return [...google.events.values()].filter((e) => e.status !== 'cancelled'
    && e.extendedProperties?.private?.ec_kind === 'followup_reminder'
    && e.extendedProperties?.private?.ec_lead_id === String(leadId));
}
// A Google event's {dateTime, timeZone} is a LOCAL wall-clock time, not UTC —
// Date.parse(dateTime) alone (no timeZone offset) silently parses it as if
// it were UTC. Mirrors phoneCallCalendarReminder.int.test.js's utcOf().
function utcOf(t) {
  if (!t) return null;
  if (!t.dateTime) return typeof t === 'string' ? Date.parse(t) : null;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime)) return Date.parse(t.dateTime);
  const { toUtcIso } = require('../../lib/booking/slotBlocking');
  return Date.parse(toUtcIso(t.dateTime.slice(0, 10), t.dateTime.slice(11, 16), t.timeZone || 'America/Los_Angeles'));
}

let googleModulesState;

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  outbox = require('../../lib/booking/calendarOutbox');
  const { issueAccessToken } = require('../../lib/authService');
  // PRODUCTIZATION: M6 asserts a real Appointment still books/syncs
  // normally — see ensureGoogleModulesEnabled.js.
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  require('../../lib/companyConfig').invalidate();
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
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  require('../../lib/companyConfig').invalidate();
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

test('M2. Still zero appointments rows — the physical-meeting representation never writes to the appointments table', { skip }, async () => {
  await drainOutbox();
  assert.deepStrictEqual(await counts(leadId), { appointments: 0, outbox: 0, events: 0 });
});

test('M2b. PERMANENT RULE: reconciling an active Meeting follow-up produces exactly ONE physical-meeting representation — 1h BUSY main + travel — and NO separate generic reminder', { skip }, async () => {
  const s = await reconcile();
  assert.ok(s.upserted >= 1, JSON.stringify(s));
  assert.deepStrictEqual(liveReminderEvents(leadId), [], 'no generic 15-min reminder IN ADDITION to the physical meeting');
  const [main, ...moreMain] = liveMeetingEvents(leadId, 'main');
  const [travel, ...moreTravel] = liveMeetingEvents(leadId, 'travel');
  assert.ok(main, 'main physical-meeting event exists');
  assert.deepStrictEqual(moreMain, [], 'exactly one main event');
  assert.ok(travel, 'travel event exists');
  assert.deepStrictEqual(moreTravel, [], 'exactly one travel event');
  assert.strictEqual(main.transparency, undefined, 'BUSY (not transparent) — a real physical meeting');
  assert.match(main.summary, /^Meeting with /);
  assert.strictEqual(main.extendedProperties.private.ec_appointment_kind, 'meeting');
  const startMs = utcOf(main.start);
  const endMs = utcOf(main.end);
  assert.strictEqual(endMs - startMs, 60 * 60 * 1000, 'exactly 1 hour, not 15 minutes');
  assert.strictEqual(startMs, Date.parse(require('../../lib/booking/slotBlocking').toUtcIso(day, '11:00', 'America/Los_Angeles')));
  const travelStartMs = utcOf(travel.start);
  assert.strictEqual(travelStartMs, endMs, 'travel starts right after the meeting ends');
  assert.strictEqual(travel.transparency, 'opaque', 'travel time itself is also busy, same as a real Appointment\'s travel event');
  const row = (await db.query('SELECT * FROM followup_calendar_reminders WHERE lead_id = $1', [leadId])).rows[0];
  assert.strictEqual(row.representation, 'meeting');
});

test('M3. The physical meeting now blocks availability exactly like a real Appointment Meeting (1h before + duration + 1h after)', { skip }, async () => {
  const av = await availability(day);
  assert.strictEqual(av.busy_windows.length, 1);
  for (const s of ['10:00', '10:30', '11:00', '11:30']) assert.ok(av.blocked_slots.includes(s), `${s} blocked`);
  assert.ok(!av.blocked_slots.includes('09:00') && !av.blocked_slots.includes('13:00'), 'boundaries stay free');
});

test('M3b. Rescheduling the Meeting follow-up moves BOTH the meeting and travel events — no duplicates', { skip }, async () => {
  const [oldMain] = liveMeetingEvents(leadId, 'main');
  const [oldTravel] = liveMeetingEvents(leadId, 'travel');
  const r = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_time: '15:00' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await reconcile();
  assert.strictEqual(google.events.get(oldMain.id)?.status, 'cancelled', 'old main event cancelled');
  assert.strictEqual(google.events.get(oldTravel.id)?.status, 'cancelled', 'old travel event cancelled');
  const mains = liveMeetingEvents(leadId, 'main');
  const travels = liveMeetingEvents(leadId, 'travel');
  assert.strictEqual(mains.length, 1, 'exactly one live main event after reschedule');
  assert.strictEqual(travels.length, 1, 'exactly one live travel event after reschedule');
  assert.strictEqual(utcOf(mains[0].start), Date.parse(require('../../lib/booking/slotBlocking').toUtcIso(day, '15:00', 'America/Los_Angeles')));
  const av = await availability(day);
  assert.ok(av.blocked_slots.includes('15:00'), 'new time blocks');
  assert.ok(!av.blocked_slots.includes('11:00'), 'old time no longer blocks');
});

test('M3c. Owner reassignment moves the meeting + travel calendar ownership correctly', { skip }, async () => {
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('mtg-reassign@example.com', 'Meeting Reassign Owner') ON CONFLICT DO NOTHING`);
  const otherOwner = (await db.query(`SELECT id FROM owners WHERE email = 'mtg-reassign@example.com'`)).rows[0].id;
  const r = await api('PUT', `/api/v1/leads/${leadId}`, { owner_id: otherOwner });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await reconcile();
  const [main] = liveMeetingEvents(leadId, 'main');
  assert.ok(main, 'still exactly one main event after reassignment');
  assert.ok(main.attendees.some((a) => a.email === 'mtg-reassign@example.com'), 'now includes the new owner');
  const row = (await db.query('SELECT owner_email FROM followup_calendar_reminders WHERE lead_id = $1', [leadId])).rows[0];
  assert.strictEqual(row.owner_email, 'mtg-reassign@example.com');
  // Reassign back to the original owner for the rest of this file's tests.
  const back = await api('PUT', `/api/v1/leads/${leadId}`, { owner_id: ownerId });
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  await reconcile();
});

test('M3d. Repeated reconciliation is idempotent — no Google call when nothing changed', { skip }, async () => {
  const s1 = await reconcile();
  assert.ok(s1.unchanged >= 1, JSON.stringify(s1));
  assert.strictEqual(liveMeetingEvents(leadId, 'main').length, 1);
  assert.strictEqual(liveMeetingEvents(leadId, 'travel').length, 1);
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

test('M5. Routing: the active Meeting follow-up now appears as a physical route stop (PERMANENT RULE), with full traffic-aware routing fields', { skip }, async () => {
  const r = await api('GET', `/api/v1/routing/daily-schedule?date=${day}&owner=all`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const stops = (r.body.schedule || []).filter(s => s.id === leadId);
  assert.strictEqual(stops.length, 1, JSON.stringify(r.body.schedule));
  assert.strictEqual(stops[0].is_meeting_followup, true);
  assert.strictEqual(stops[0].follow_up_time, '15:00');
});

test('M6. MIRROR-DEDUP (PR #8 principle, applied to calendar sync): booking a real Appointment at the EXACT same time as the active Meeting follow-up removes the follow-up\'s own calendar presence — never two physical-meeting representations for the one event', { skip }, async () => {
  // The follow-up is currently at 15:00 (rescheduled in M3b) — book the real
  // Appointment at that exact same moment.
  const r = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: day, appointment_time: '15:00', appointment_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const lead = await getLead(leadId);
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '15:00');
  assert.strictEqual(lead.appointment_type, 'Meeting');
  // The follow-up record itself is untouched — Appointment and Follow-Up
  // remain independent CRM records; only their CALENDAR representation dedupes.
  assert.strictEqual(lead.follow_up_type, 'Meeting');
  assert.strictEqual(lead.follow_up_date, day);
  assert.strictEqual(lead.follow_up_time, '15:00');

  // Exactly one appointment, buffered 1h each side (Meeting behavior unchanged).
  const rows = (await db.query(
    `SELECT start_at, end_at, lower(busy_range) AS bs, upper(busy_range) AS be FROM appointments WHERE lead_id = $1`, [leadId])).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(new Date(rows[0].start_at) - new Date(rows[0].bs), 3600000);
  assert.strictEqual(new Date(rows[0].be) - new Date(rows[0].end_at), 3600000);

  // Google Calendar: the APPOINTMENT's own main + travel sync normally.
  await drainOutbox();
  const after = await getLead(leadId);
  assert.ok(after.google_event_id, 'appointment main event synced');
  assert.ok(after.google_travel_event_id, 'appointment travel event synced');

  // Reconciling now removes the Meeting follow-up's OWN separate physical-
  // meeting representation (it is a proven exact mirror of the Appointment) —
  // never two BUSY main+travel pairs for the one meeting.
  const s = await reconcile();
  assert.ok(s.removed >= 1, JSON.stringify(s));
  assert.deepStrictEqual(liveMeetingEvents(leadId, 'main'), [], 'the follow-up\'s own main event is gone — the Appointment\'s own event is a DIFFERENT id and unaffected');
  assert.deepStrictEqual(liveMeetingEvents(leadId, 'travel'), [], 'the follow-up\'s own travel event is gone');
  assert.deepStrictEqual(liveReminderEvents(leadId), [], 'no generic reminder either — fully covered by the Appointment');

  // Exactly ONE blocked window around 15:00 — never doubled.
  const av = await availability(day);
  assert.strictEqual(av.busy_windows.length, 1);
  assert.ok(av.blocked_slots.includes('15:00'));

  // A second appointment for the same owner overlapping it is still rejected.
  const other = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '15:30' }), null);
  assert.strictEqual(other.status, 409, JSON.stringify(other.body));

  // Routing now has exactly one stop — the FOLLOW-UP (FINAL AUTHORITATIVE
  // CURRENT-ACTION RULE: route stops come ENTIRELY from the active Meeting
  // Follow-Up; routes/routing.js's /daily-schedule never queries the
  // `appointments` table at all, so the Appointment — even an exact-time
  // match — can never itself be, or produce, a second route stop. The
  // Appointment is never deleted, and its own calendar/availability
  // presence above is completely unaffected).
  const route = await api('GET', `/api/v1/routing/daily-schedule?date=${day}&owner=all`);
  assert.strictEqual(route.status, 200, JSON.stringify(route.body));
  const stops = (route.body.schedule || []).filter(s => s.id === leadId || s.lead_id === leadId);
  assert.strictEqual(stops.length, 1, JSON.stringify(route.body.schedule));
  assert.ok(stops[0].is_meeting_followup, 'the Follow-Up is the only possible route-stop source');
});

test('M6b. Completing the Meeting follow-up after it has been mirror-deduped changes nothing further (idempotent cleanup edge case)', { skip }, async () => {
  const r = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_status: 'completed' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const s = await reconcile();
  assert.deepStrictEqual(liveMeetingEvents(leadId), []);
  assert.deepStrictEqual(liveReminderEvents(leadId), []);
  // The appointment's own calendar presence is completely unaffected.
  const after = await getLead(leadId);
  assert.ok(after.google_event_id);
  assert.ok(after.google_travel_event_id);
});

test('M6c. Completing (or deleting) a STANDALONE active Meeting follow-up (never mirrored) cleans up its future meeting + travel state correctly', { skip }, async () => {
  const d = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({
    follow_up_date: d, follow_up_time: '09:00', follow_up_type: 'Meeting',
  }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const id = r.body.lead.id;
  await reconcile();
  assert.strictEqual(liveMeetingEvents(id, 'main').length, 1);
  assert.strictEqual(liveMeetingEvents(id, 'travel').length, 1);
  assert.ok((await availability(d)).blocked_slots.includes('09:00'));

  const complete = await api('PUT', `/api/v1/leads/${id}/follow-up`, { follow_up_status: 'completed' });
  assert.strictEqual(complete.status, 200, JSON.stringify(complete.body));
  const s = await reconcile();
  assert.ok(s.removed >= 1, JSON.stringify(s));
  assert.deepStrictEqual(liveMeetingEvents(id), [], 'both meeting + travel events removed on completion');
  assert.ok(!(await availability(d)).blocked_slots.includes('09:00'), 'no longer blocks once completed');

  // Re-opening it with a new time gets a fresh event (a removed id never reused).
  const reopen = await api('PUT', `/api/v1/leads/${id}/follow-up`, { follow_up_status: 'pending', follow_up_date: d, follow_up_time: '09:00' });
  assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.body));
  await reconcile();
  assert.strictEqual(liveMeetingEvents(id, 'main').length, 1);

  // Deleting the lead entirely also cleans it up.
  const del = await api('DELETE', `/api/v1/leads/${id}`);
  assert.ok([200, 204].includes(del.status), JSON.stringify(del.body));
  await reconcile();
  assert.deepStrictEqual(liveMeetingEvents(id), [], 'deleting the lead removes its meeting + travel events');
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
