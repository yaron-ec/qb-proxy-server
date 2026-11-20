/* eslint-disable no-undef */
'use strict';

/**
 * meetingFollowUp.int.test.js — REAL-Postgres regression test.
 *
 * PRODUCT CORRECTION (November 2026, "John John" production incident): this
 * file originally proved a Follow-Up of type 'Meeting' is ONLY a follow-up
 * record — never an `appointments` row — getting its own SEPARATE virtual
 * physical-meeting calendar representation via followUpMeeting.js/
 * followUpReminders.js. That premise is now WRONG for the authenticated,
 * CRM-internal write path: Follow-Up Date/Time/Type is the single,
 * user-facing source of scheduling truth for a Meeting, and saving one
 * through an authenticated route (Lead Detail, New Lead, other update
 * endpoints) now AUTOMATICALLY creates/reschedules/cancels the REAL
 * `appointments` row (lib/booking/followUpAppointmentSync.js) — the user is
 * never required to separately open the Appointment editor. The
 * UNAUTHENTICATED public-capture endpoint is deliberately NOT wired into
 * this automatic sync (a different trust boundary, out of scope for this
 * correction) — a Meeting follow-up set only through public capture, with
 * no authenticated follow-up edit ever applied to it, still gets the
 * ORIGINAL virtual-appointment treatment this file first proved (see M6c).
 * Once a real appointment exists matching the follow-up, the PRE-EXISTING
 * mirror-dedup guard in followUpReminders.js correctly suppresses the
 * separate virtual representation — proven directly below (M2b, M3b, M6),
 * so there is never a duplicate calendar event for the one meeting.
 *
 * Runs only when TEST_DATABASE_URL points at a DISPOSABLE, migrated database
 * (same harness as appointmentFollowUp.int.test.js); skipped otherwise:
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/crm_int \
 *     node --test test/integration/meetingFollowUp.int.test.js
 *
 * Proves, end to end through HTTP → routes → followUpAppointmentSync →
 * bookingService → calendarOutbox → availability → routing → reminders:
 *   a Meeting follow-up saved via public capture alone creates no
 *   appointment; editing it through an authenticated route automatically
 *   creates the real appointment (1h buffer each side, main + travel
 *   calendar events, correctly blocks availability, drives the customer
 *   reminder projection, appears as a routing.js stop via the follow-up);
 *   changing the follow-up's time automatically reschedules the same
 *   appointment (old events cancelled, new ones created, no duplicates);
 *   owner reassignment moves calendar ownership via the pre-existing
 *   mechanism; re-saving an unchanged date/time is a safe no-op; marking
 *   the follow-up "completed" (type/date unchanged) never touches the
 *   appointment; clearing the follow-up automatically cancels the matching
 *   appointment, its calendar events, and its reminder projection; a
 *   STANDALONE Meeting follow-up (never routed through the authenticated
 *   sync) still gets the ORIGINAL virtual-appointment treatment; a Phone
 *   Call follow-up remains the old free/non-blocking reminder treatment.
 *   See test/integration/phoneCallCalendarReminder.int.test.js case N for
 *   the Phone Call/Text/Email/Other reminder-only proof, and
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

// PRODUCT CORRECTION (November 2026, "John John" production incident):
// Follow-Up is now the single, user-facing source of scheduling truth for
// a Meeting (lib/booking/followUpAppointmentSync.js). Saving a dated
// Meeting follow-up through an AUTHENTICATED CRM write path (Lead Detail,
// New Lead, other update endpoints) now automatically creates/reschedules
// the real `appointments` row — superseding this file's original premise
// ("still only a follow-up record... never an appointments row"). The
// unauthenticated public capture endpoint (routes/publicCapture.js) is
// DELIBERATELY NOT wired into this automatic sync — a different trust
// boundary, out of scope for this correction, so a Meeting follow-up set
// at public-capture time still creates no appointment on its own (M1
// below still proves that half). Once a real appointment exists matching
// the follow-up, lib/booking/followUpReminders.js's own PRE-EXISTING
// mirror-dedup guard (proven directly in
// test/integration/appointmentFollowUp.int.test.js's case 9) correctly
// suppresses the separate virtual-appointment ('followup-meeting:...')
// calendar representation this file originally tested — so that
// representation, and the generic reminder, are both now the ABSENT case
// for an actively-synced lead; M6c (unchanged) still proves the virtual
// representation itself works correctly for the one case it's still
// reachable: a Meeting follow-up set directly via SQL/public-capture with
// no authenticated follow-up edit ever applied to it.
test('M1. Meeting follow-up via public capture creates no appointment (public capture is out of scope for this correction); editing it via Lead Detail PUT /:id/follow-up now automatically syncs the real appointment', { skip }, async () => {
  day = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({
    follow_up_date: day, follow_up_time: '11:00', follow_up_type: 'Meeting', follow_up_notes: 'Walk the site with the client',
  }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.appointment, null, 'public capture (out of scope for this correction) never books an appointment from a Meeting follow-up');
  leadId = r.body.lead.id;

  // Lead Detail: change it to a different type, then back to Meeting —
  // the Meeting save (an AUTHENTICATED write) now automatically syncs the
  // real appointment.
  const t = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_type: 'Text' });
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  assert.strictEqual(t.body.follow_up_appointment_sync.action, 'none', 'no active Meeting -> no appointment action');
  const m = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, {
    follow_up_date: day, follow_up_time: '11:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  assert.strictEqual(m.body.lead.follow_up_type, 'Meeting');
  assert.strictEqual(m.body.follow_up_appointment_sync.action, 'created', 'saving a dated Meeting follow-up automatically creates the real appointment');

  const lead = await getLead(leadId); // reload
  assert.strictEqual(lead.follow_up_type, 'Meeting');
  assert.strictEqual(lead.follow_up_date, day);
  assert.strictEqual(lead.follow_up_time, '11:00');
  assert.strictEqual(lead.follow_up_status, 'pending');
  assert.ok(lead.appointment, 'the automatically-synced appointment persists across a reload');
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '11:00');
  assert.strictEqual(lead.appointment_type, 'Meeting');
});

test('M2. Exactly ONE appointment row now exists, automatically created from the Meeting follow-up — buffered, with its own calendar outbox jobs', { skip }, async () => {
  const c = await counts(leadId);
  assert.strictEqual(c.appointments, 1, 'one real appointment row, automatically created');
  assert.strictEqual(c.outbox, 2, 'create_main + create_travel enqueued, same as any normal Meeting booking');
  await drainOutbox();
  const c2 = await counts(leadId);
  assert.strictEqual(c2.events, 2, 'main + travel events exist once drained');
  const row = (await db.query(`SELECT lower(busy_range) AS bs, upper(busy_range) AS be, start_at, end_at FROM appointments WHERE lead_id = $1`, [leadId])).rows[0];
  assert.strictEqual(new Date(row.start_at) - new Date(row.bs), 3600000, '1h buffer before, same as any real Meeting');
  assert.strictEqual(new Date(row.be) - new Date(row.end_at), 3600000, '1h buffer after');
});

test('M2b. The REAL appointment\'s calendar representation is correct, and the SEPARATE virtual-appointment ("meeting" follow-up) representation is correctly absent — no duplicate calendar events for the one meeting', { skip }, async () => {
  const apptRow = (await db.query(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  const main = [...google.events.values()].find((e) => e.status !== 'cancelled' && e.extendedProperties?.private?.ec_appointment_id === apptRow.id && e.extendedProperties?.private?.ec_kind === 'main');
  const travel = [...google.events.values()].find((e) => e.status !== 'cancelled' && e.extendedProperties?.private?.ec_appointment_id === apptRow.id && e.extendedProperties?.private?.ec_kind === 'travel');
  assert.ok(main, 'the real appointment\'s main event exists');
  assert.ok(travel, 'the real appointment\'s travel event exists');
  assert.strictEqual(main.transparency, undefined, 'BUSY (not transparent) — a real physical meeting');
  assert.match(main.summary, /^Meeting with /);
  const startMs = utcOf(main.start);
  const endMs = utcOf(main.end);
  assert.strictEqual(endMs - startMs, 60 * 60 * 1000, 'exactly 1 hour');
  assert.strictEqual(startMs, Date.parse(require('../../lib/booking/slotBlocking').toUtcIso(day, '11:00', 'America/Los_Angeles')));
  assert.strictEqual(utcOf(travel.start), endMs, 'travel starts right after the meeting ends');

  // The pre-existing mirror-dedup guard in followUpReminders.js correctly
  // suppresses the separate virtual-appointment representation once a
  // matching real appointment exists — proven directly here, not assumed.
  const s = await reconcile();
  assert.strictEqual(s.errors, 0, JSON.stringify(s));
  assert.deepStrictEqual(liveMeetingEvents(leadId), [], 'no separate meeting-kind virtual-appointment event — the real appointment is the one calendar representation');
  assert.deepStrictEqual(liveReminderEvents(leadId), [], 'no generic reminder either — fully covered by the real appointment');
  const row = (await db.query('SELECT * FROM followup_calendar_reminders WHERE lead_id = $1', [leadId])).rows[0];
  assert.ok(!row || row.google_event_id == null, 'no virtual-appointment state row for this lead');
});

test('M3. The physical meeting now blocks availability exactly like a real Appointment Meeting (1h before + duration + 1h after)', { skip }, async () => {
  const av = await availability(day);
  assert.strictEqual(av.busy_windows.length, 1);
  for (const s of ['10:00', '10:30', '11:00', '11:30']) assert.ok(av.blocked_slots.includes(s), `${s} blocked`);
  assert.ok(!av.blocked_slots.includes('09:00') && !av.blocked_slots.includes('13:00'), 'boundaries stay free');
});

function liveApptEvents(apptId, kind) {
  return [...google.events.values()].filter((e) =>
    e.status !== 'cancelled'
    && e.extendedProperties?.private?.ec_appointment_id === apptId
    && (!kind || e.extendedProperties.private.ec_kind === kind));
}

test('M3b. Changing the Meeting follow-up\'s time automatically reschedules the REAL appointment — old main/travel cancelled, new ones created, no duplicates', { skip }, async () => {
  const before = (await db.query(`SELECT id FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  const [oldMain] = liveApptEvents(before.id, 'main');
  const [oldTravel] = liveApptEvents(before.id, 'travel');
  const r = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_time: '15:00' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.follow_up_appointment_sync.action, 'rescheduled', 'changing the Meeting follow-up\'s time automatically reschedules the real appointment');
  await drainOutbox();
  assert.strictEqual(google.events.get(oldMain.id)?.status, 'cancelled', 'old main event cancelled');
  assert.strictEqual(google.events.get(oldTravel.id)?.status, 'cancelled', 'old travel event cancelled');
  const after = (await db.query(`SELECT id FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  const mains = liveApptEvents(after.id, 'main');
  const travels = liveApptEvents(after.id, 'travel');
  assert.strictEqual(mains.length, 1, 'exactly one live main event after reschedule');
  assert.strictEqual(travels.length, 1, 'exactly one live travel event after reschedule');
  assert.strictEqual(utcOf(mains[0].start), Date.parse(require('../../lib/booking/slotBlocking').toUtcIso(day, '15:00', 'America/Los_Angeles')));
  const av = await availability(day);
  assert.ok(av.blocked_slots.includes('15:00'), 'new time blocks');
  assert.ok(!av.blocked_slots.includes('11:00'), 'old time no longer blocks');

  // The separate virtual-appointment representation stays correctly absent
  // throughout — the dedup guard holds across a reschedule, not just at
  // creation time.
  await reconcile();
  assert.deepStrictEqual(liveMeetingEvents(leadId), [], 'still no separate virtual-appointment event after the reschedule');
});

test('M3c. Owner reassignment moves the automatically-synced appointment\'s calendar ownership correctly (pre-existing routes/leads.js mechanism, unaffected by this correction)', { skip }, async () => {
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('mtg-reassign@example.com', 'Meeting Reassign Owner') ON CONFLICT DO NOTHING`);
  const otherOwner = (await db.query(`SELECT id FROM owners WHERE email = 'mtg-reassign@example.com'`)).rows[0].id;
  const r = await api('PUT', `/api/v1/leads/${leadId}`, { owner_id: otherOwner });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await drainOutbox();
  const apptRow = (await db.query(`SELECT id FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  assert.strictEqual(apptRow.id, apptRow.id); // sanity
  const [main] = liveApptEvents(apptRow.id, 'main');
  assert.ok(main, 'still exactly one main event after reassignment');
  assert.ok(main.attendees.some((a) => a.email === 'mtg-reassign@example.com'), 'now includes the new owner');
  // Reassign back to the original owner for the rest of this file's tests.
  const back = await api('PUT', `/api/v1/leads/${leadId}`, { owner_id: ownerId });
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  await drainOutbox();
});

test('M3d. Saving the follow-up again with an unchanged date/time is a safe no-op for the appointment sync — no reschedule, no duplicate', { skip }, async () => {
  const before = (await db.query(`SELECT id, start_at FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  const r = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_notes: 'same time, just a note edit' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.follow_up_appointment_sync.action, 'none', 'unchanged date/time -> no appointment action');
  const after = (await db.query(`SELECT id, start_at FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  assert.strictEqual(after.id, before.id, 'same appointment row — never recreated');
  assert.strictEqual(new Date(after.start_at).getTime(), new Date(before.start_at).getTime());
  assert.strictEqual(liveApptEvents(before.id, 'main').length, 1, 'still exactly one main event');
});

test('M4. The automatically-synced appointment now correctly DOES drive the customer appointment-reminder projection — the whole point of creating a real appointment from the follow-up', { skip }, async () => {
  const { getAppointmentMs } = require('../../lib/reminderEngine');
  const rl = (await db.query(
    'SELECT * FROM reminder_leads WHERE id IN (SELECT COALESCE(external_ref, id::text) FROM leads WHERE id = $1)', [leadId])).rows[0];
  assert.ok(rl, 'the lead is projected into reminder_leads');
  assert.strictEqual(rl.appointment_type, 'Meeting');
  assert.ok(rl.appointment_date, 'the real, automatically-synced appointment date is now projected');
  assert.ok(getAppointmentMs(rl) !== null, 'the reminder engine now sees a valid appointment and computes reminder windows for it');
});

test('M5. Routing: the active Meeting follow-up now appears as a physical route stop (PERMANENT RULE), with full traffic-aware routing fields', { skip }, async () => {
  const r = await api('GET', `/api/v1/routing/daily-schedule?date=${day}&owner=all`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const stops = (r.body.schedule || []).filter(s => s.id === leadId);
  assert.strictEqual(stops.length, 1, JSON.stringify(r.body.schedule));
  assert.strictEqual(stops[0].is_meeting_followup, true);
  assert.strictEqual(stops[0].follow_up_time, '15:00');
});

test('M6. Explicitly booking the Appointment editor at the EXACT same time the follow-up already auto-synced to is a safe no-op — never a second appointment, follow-up and appointment stay in agreement', { skip }, async () => {
  // The follow-up (and its automatically-synced appointment) are already at
  // 15:00 (from M3b). Using the Appointment editor directly at that exact
  // same moment is the "second manual action" the product correction says
  // should never be required — proving it is at worst a harmless no-op,
  // never a duplicate, when a user does it anyway.
  const r = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: day, appointment_time: '15:00', appointment_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const lead = await getLead(leadId);
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '15:00');
  assert.strictEqual(lead.appointment_type, 'Meeting');
  assert.strictEqual(lead.follow_up_type, 'Meeting');
  assert.strictEqual(lead.follow_up_date, day);
  assert.strictEqual(lead.follow_up_time, '15:00');

  // Still exactly ONE appointment ROW currently active (history from the
  // M3b reschedule — the superseded 11:00 row — may still exist as
  // 'rescheduled', which is correct, expected history, not a bug).
  const active = (await db.query(
    `SELECT start_at, end_at, lower(busy_range) AS bs, upper(busy_range) AS be FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows;
  assert.strictEqual(active.length, 1, 'exactly one ACTIVE appointment');
  assert.strictEqual(new Date(active[0].start_at) - new Date(active[0].bs), 3600000);
  assert.strictEqual(new Date(active[0].be) - new Date(active[0].end_at), 3600000);

  await drainOutbox();
  const after = await getLead(leadId);
  assert.ok(after.google_event_id, 'appointment main event synced');
  assert.ok(after.google_travel_event_id, 'appointment travel event synced');

  // The separate virtual-appointment representation stays correctly absent.
  const s = await reconcile();
  assert.strictEqual(s.errors, 0, JSON.stringify(s));
  assert.deepStrictEqual(liveMeetingEvents(leadId), [], 'no separate follow-up calendar representation — the real appointment is the one source');

  // Exactly ONE blocked window around 15:00 — never doubled.
  const av = await availability(day);
  assert.strictEqual(av.busy_windows.length, 1);
  assert.ok(av.blocked_slots.includes('15:00'));

  // A second appointment for the same owner overlapping it is still rejected.
  const other = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '15:30' }), null);
  assert.strictEqual(other.status, 409, JSON.stringify(other.body));

  // Routing has exactly one stop for this lead (routes/routing.js's
  // /daily-schedule reads the active Meeting Follow-Up, which — by
  // construction of this correction — is now always in agreement with the
  // real appointment).
  const route = await api('GET', `/api/v1/routing/daily-schedule?date=${day}&owner=all`);
  assert.strictEqual(route.status, 200, JSON.stringify(route.body));
  const stops = (route.body.schedule || []).filter(s => s.id === leadId || s.lead_id === leadId);
  assert.strictEqual(stops.length, 1, JSON.stringify(route.body.schedule));
  assert.ok(stops[0].is_meeting_followup);
});

test('M6b. Marking the Meeting follow-up "completed" (type/date unchanged) never touches the already-synced appointment — completing the follow-up task is not the same as cancelling the meeting', { skip }, async () => {
  const r = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_status: 'completed' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.follow_up_appointment_sync.action, 'none', 'still type=Meeting with the same date/time — marking the task complete is not "changed to another type or cleared"');
  const s = await reconcile();
  assert.strictEqual(s.errors, 0, JSON.stringify(s));
  assert.deepStrictEqual(liveMeetingEvents(leadId), []);
  assert.deepStrictEqual(liveReminderEvents(leadId), []);
  // The appointment's own calendar presence is completely unaffected.
  const after = await getLead(leadId);
  assert.ok(after.google_event_id);
  assert.ok(after.google_travel_event_id);
  assert.strictEqual(after.appointment_date, day);
});

test('M6d. Clearing a completed Meeting follow-up (type -> none/date cleared) now automatically cancels the matching real appointment and its calendar events', { skip }, async () => {
  const before = (await db.query(`SELECT id FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
  const [main] = liveApptEvents(before.id, 'main');
  const [travel] = liveApptEvents(before.id, 'travel');
  assert.ok(main && travel, 'precondition: the appointment is still live going into this test');

  const r = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_type: null, follow_up_date: null, follow_up_time: null, follow_up_status: null });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.follow_up_appointment_sync.action, 'cancelled', 'clearing a Meeting follow-up that matches the active appointment automatically cancels it');
  await drainOutbox();

  const apptRow = (await db.query('SELECT status FROM appointments WHERE id = $1', [before.id])).rows[0];
  assert.strictEqual(apptRow.status, 'cancelled', 'the real appointment row is cancelled, not deleted — history preserved');
  assert.strictEqual(google.events.get(main.id)?.status, 'cancelled', 'main calendar event cancelled');
  assert.strictEqual(google.events.get(travel.id)?.status, 'cancelled', 'travel calendar event cancelled');

  const lead = await getLead(leadId);
  assert.strictEqual(lead.appointment, null, 'no active appointment remains');
  const av = await availability(day);
  assert.ok(!av.blocked_slots.includes('15:00'), 'the slot is freed');

  const rl = (await db.query(
    'SELECT * FROM reminder_leads WHERE id IN (SELECT COALESCE(external_ref, id::text) FROM leads WHERE id = $1)', [leadId])).rows[0];
  assert.strictEqual(rl.appointment_date, null, 'stale reminder projection is cleared along with the cancellation');
});

test('M6c. Completing a STANDALONE Meeting follow-up through the authenticated route now ALSO auto-creates the matching real appointment (type/date unchanged -> the sync still ensures it exists) — "completing" is an authenticated write like any other', { skip }, async () => {
  const d = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({
    follow_up_date: d, follow_up_time: '09:00', follow_up_type: 'Meeting',
  }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const id = r.body.lead.id;
  await reconcile();
  assert.strictEqual(liveMeetingEvents(id, 'main').length, 1, 'untouched by any authenticated write so far — still the original virtual representation');
  assert.strictEqual(liveMeetingEvents(id, 'travel').length, 1);
  assert.ok((await availability(d)).blocked_slots.includes('09:00'));

  // PUT /follow-up touches FOLLOW_UP_FIELDS (follow_up_status included) even
  // though this call only changes status — per the product correction, ANY
  // authenticated save of a still-Meeting, still-dated follow-up ensures a
  // matching real appointment exists (requirement #4: "create the
  // appointment if none exists"). This is deliberate, not a side effect to
  // work around: marking the follow-up TASK complete is not the same as
  // saying the meeting shouldn't happen (see M6b) — nothing here un-dates
  // or un-types the follow-up, so the sync still wants a Meeting on this
  // day/time and creates it since none existed yet.
  const complete = await api('PUT', `/api/v1/leads/${id}/follow-up`, { follow_up_status: 'completed' });
  assert.strictEqual(complete.status, 200, JSON.stringify(complete.body));
  assert.strictEqual(complete.body.follow_up_appointment_sync.action, 'created');
  await drainOutbox();
  const apptRow = (await db.query(`SELECT id FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [id])).rows[0];
  assert.ok(apptRow, 'the real appointment now exists');

  // The dedup guard correctly removes the now-redundant virtual representation.
  const s = await reconcile();
  assert.strictEqual(s.errors, 0, JSON.stringify(s));
  assert.deepStrictEqual(liveMeetingEvents(id), [], 'virtual representation correctly superseded by the real appointment');
  assert.ok((await availability(d)).blocked_slots.includes('09:00'), 'still blocked — by the real appointment now, not the virtual event');
  assert.ok(liveApptEvents(apptRow.id, 'main').length === 1 && liveApptEvents(apptRow.id, 'travel').length === 1);
});

test('M6e. A Meeting follow-up set entirely outside any authenticated route (legacy/imported data, never touched by followUpAppointmentSync) still gets the ORIGINAL standalone virtual-appointment lifecycle, including cleanup on completion and lead deletion', { skip }, async () => {
  const d = uniqueDay();
  // Bypass the HTTP follow-up route entirely, simulating legacy/imported
  // data this correction's automatic sync has never had a chance to see.
  const create = await api('POST', '/api/public/capture', capturePayload({}), null);
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  const id = create.body.lead.id;
  await db.query(
    `UPDATE leads SET follow_up_date = $1, follow_up_time = '09:00', follow_up_type = 'Meeting', follow_up_status = 'pending' WHERE id = $2`,
    [d, id]
  );
  await reconcile();
  assert.strictEqual(liveMeetingEvents(id, 'main').length, 1);
  assert.strictEqual(liveMeetingEvents(id, 'travel').length, 1);
  assert.ok((await availability(d)).blocked_slots.includes('09:00'));

  // "Complete" it the same way — directly via SQL, never through the
  // authenticated route (so followUpAppointmentSync never runs) — proving
  // the pre-existing virtual-appointment cleanup still works correctly on
  // its own for data the new sync has no visibility into.
  await db.query(`UPDATE leads SET follow_up_status = 'completed' WHERE id = $1`, [id]);
  const s = await reconcile();
  assert.ok(s.removed >= 1, JSON.stringify(s));
  assert.deepStrictEqual(liveMeetingEvents(id), [], 'both meeting + travel events removed on completion');
  assert.ok(!(await availability(d)).blocked_slots.includes('09:00'), 'no longer blocks once completed');
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM appointments WHERE lead_id = $1', [id])).rows[0].n, 0, 'still no real appointment row — this lead was never touched by the authenticated sync');

  // Re-opening it with a new time gets a fresh event (a removed id never reused).
  await db.query(`UPDATE leads SET follow_up_status = 'pending', follow_up_date = $1, follow_up_time = '09:00' WHERE id = $2`, [d, id]);
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
