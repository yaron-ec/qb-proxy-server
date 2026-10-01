/* eslint-disable no-undef */
'use strict';

/**
 * meetingFollowUpNotAppointment.test.js — Lead Detail → Follow-Up / Next
 * Update → Type "Meeting".
 *
 * CANONICAL RULE: a follow-up of type 'Meeting' is STILL ONLY A FOLLOW-UP
 * (leads.follow_up_*, an internal next action), never an appointments row —
 * `lib/booking/bookingService.js` only ever creates one from `start_at`, and
 * only the canonical appointments row is an appointment
 * (lib/booking/appointmentView.js).
 *
 * UPDATED (post-Jamey-Corey production defect, PERMANENT RULE): an ACTIVE
 * Meeting Follow-Up now gets the SAME physical-meeting SCHEDULING SEMANTICS
 * as a real Appointment — it blocks availability, gets a 1h duration, a
 * Driving/Travel Time block via the canonical travel engine, and ONE
 * calendar meeting representation (no separate 15-min generic reminder in
 * addition) — all built by literally reusing `calendarOutbox.js#buildOperation`
 * via a virtual-appointment adapter
 * (`lib/booking/followUpMeeting.js#virtualAppointmentFor`), never a second
 * implementation. This does NOT create an appointments row and does NOT
 * change anything tested in this file: reminders, the manual reminder
 * route, and routing (tests 3-8, 10, 11) are proven unchanged. Only
 * `lib/booking/availabilityService.js` is allowed to read an active Meeting
 * Follow-Up as a busy source — see test 9's and test 12's carve-outs below,
 * and test/followUpMeeting.test.js /
 * test/integration/phoneCallCalendarReminder.int.test.js case N for the
 * calendar-sync proof.
 *
 * Found and fixed in the systemic audit (every one read the follow-up as an
 * appointment):
 *   - lib/reminderTime.js#appointmentParts fell back to a dated 'Meeting' /
 *     'Phone Call' follow-up → customer "Appointment Reminder" emails and
 *     action-page fingerprints for a follow-up.
 *   - routes/routing.js + routes/routingDiagnostic.js previously UNIONed
 *     leads with a dated 'Meeting' follow-up in as driving stops using a
 *     DIFFERENT, ungated mechanism than today's (routingDiagnostic's
 *     appointment query also selected by l.follow_up_type = 'Meeting') — that
 *     was removed. routes/routing.js has since been DELIBERATELY re-extended
 *     under the PERMANENT RULE below with a narrower, gated, mirror-deduped
 *     version; routingDiagnostic.js was not.
 *   - routes/emails.js POST /leads/:id/remind preferred the follow-up over
 *     the appointment (and lib/dataAccessRailway#getLead read appointment_*
 *     from `leads`, which has no such columns).
 * Real-Postgres coverage (booking at the exact same time, zero appointments /
 * outbox rows, availability): test/integration/meetingFollowUp.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── db/client stub (no Postgres needed) ─────────────────────────────────────
const dbCalls = [];
let appointmentRows = [];
const dbPath = require.resolve('../db/client');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      dbCalls.push({ sql, params });
      if (/FROM appointments/.test(sql)) return { rows: appointmentRows };
      if (/FROM leads l LEFT JOIN owners/.test(sql)) return { rows: [LEAD_ROW] };
      if (/INSERT INTO reminder_leads/.test(sql)) return { rows: [{ inserted: true }] };
      return { rows: [], rowCount: 0 };
    },
    pool: {},
  },
};

const { normalizeFollowUp, FOLLOW_UP_TYPES } = require('../lib/followUp');
const time = require('../lib/reminderTime');
const { getAppointmentMs } = require('../lib/reminderEngine');
const { getCallMs } = require('../lib/phoneCallReminders');
const { syncLeadToReminders } = require('../lib/reminderProjection');
const dataAccess = require('../lib/dataAccessRailway');

const MEETING_FU = { follow_up_date: '2031-05-01', follow_up_time: '11:00', follow_up_type: 'Meeting' };
const LEAD_ROW = {
  id: '11111111-1111-4111-8111-111111111111', external_ref: null, first_name: 'Brian', last_name: 'Krantz',
  email: 'b@example.com', phone: '+13105550000', city: 'Los Angeles', project_type: 'Kitchen',
  owner_display_name: 'Yaron Drilevich', created_at: new Date('2026-09-01T00:00:00Z'),
  ...MEETING_FU, follow_up_notes: null, follow_up_status: 'pending',
};
const MEETING_APPT = {
  id: 'appt-1', lead_id: LEAD_ROW.id, status: 'scheduled', timezone: 'America/Los_Angeles',
  start_at: new Date('2031-05-01T18:00:00Z'), end_at: new Date('2031-05-01T19:00:00Z'),
  busy_range: '["2031-05-01 17:00:00+00","2031-05-01 20:00:00+00")',
};

test.beforeEach(() => { dbCalls.length = 0; appointmentRows = []; });

// ── Persistence / validation ────────────────────────────────────────────────
test('1. Meeting is a valid follow-up type and normalizes unchanged (backend enum)', () => {
  assert.deepStrictEqual(FOLLOW_UP_TYPES, ['Phone Call', 'Text', 'Email', 'Meeting', 'Other']);
  const r = normalizeFollowUp(MEETING_FU);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.value.follow_up_type, 'Meeting');
  assert.strictEqual(r.value.follow_up_date, '2031-05-01');
  assert.strictEqual(r.value.follow_up_time, '11:00');
});

test('2. Historical Meeting follow-ups stay valid — the DB CHECK allows Meeting (no destructive migration needed)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '2026-42-follow-up-notes-status.sql'), 'utf8');
  assert.match(sql, /follow_up_type IN \('Phone Call','Text','Email','Meeting','Other'\)/);
});

// ── Reminders ───────────────────────────────────────────────────────────────
test('3. A Meeting follow-up alone is NOT an appointment for customer reminders', () => {
  assert.strictEqual(time.appointmentParts({ ...MEETING_FU }), null);
  assert.strictEqual(getAppointmentMs({ id: 'x', ...MEETING_FU }), null);
});

test('4. A Phone Call follow-up is not an appointment either (its staff call reminder is separate and unchanged)', () => {
  const pc = { follow_up_date: '2031-05-01', follow_up_time: '11:00', follow_up_type: 'Phone Call' };
  assert.strictEqual(time.appointmentParts(pc), null);
  const call = getCallMs(pc);
  assert.ok(call, 'Phone Call follow-up still gets its call reminder');
  assert.strictEqual(call.date, '2031-05-01');
});

test('5. A Meeting follow-up never triggers a phone-call reminder', () => {
  assert.strictEqual(getCallMs({ ...MEETING_FU }), null);
});

test('6. With a real appointment, reminders follow the appointment — never the follow-up', () => {
  const lead = { ...MEETING_FU, follow_up_date: '2031-04-01', appointment_date: '2031-05-02', appointment_time: '14:00', appointment_type: 'Meeting' };
  assert.deepStrictEqual(time.appointmentParts(lead), { date: '2031-05-02', time: '14:00', type: 'Meeting' });
  const appt = getAppointmentMs(lead);
  assert.strictEqual(appt.date, '2031-05-02');
  assert.strictEqual(appt.ms, time.pacificToUtcMs('2031-05-02', '14:00'));
});

test('7. Reminder projection: a Meeting follow-up with no appointments row projects NO appointment_*', async () => {
  const r = await syncLeadToReminders({ query: require(dbPath).query }, LEAD_ROW);
  assert.strictEqual(r.action, 'synced');
  const up = dbCalls.find(c => /INSERT INTO reminder_leads/.test(c.sql));
  assert.ok(up, 'follow-up still projected (in-app follow-up reminders)');
  assert.strictEqual(up.params[10], 'Meeting', 'follow_up_type preserved');
  assert.strictEqual(up.params[11], null, 'appointment_date');
  assert.strictEqual(up.params[12], null, 'appointment_time');
  assert.strictEqual(up.params[21], null, 'appointment_type');
});

test('8. Manual reminder data: getLead reads appointment_* ONLY from the active appointments row', async () => {
  appointmentRows = [];
  const noAppt = await dataAccess.getLead(LEAD_ROW.id);
  assert.strictEqual(noAppt.follow_up_type, 'Meeting');
  assert.strictEqual(noAppt.appointment_date, null, 'a Meeting follow-up is not an appointment');
  assert.strictEqual(noAppt.appointment_time, null);

  appointmentRows = [MEETING_APPT];
  const withAppt = await dataAccess.getLead(LEAD_ROW.id);
  assert.strictEqual(withAppt.appointment_date, '2031-05-01');
  assert.strictEqual(withAppt.appointment_time, '11:00');
  assert.strictEqual(withAppt.appointment_type, 'Meeting');
});

// ── Source guards: no runtime path reads a follow-up as an appointment ──────
const ROOT = path.join(__dirname, '..');
function runtimeFiles() {
  const out = ['server.js', 'reminderWorker.js', 'reminderWatchdog.js', 'productionWatchdog.js', 'scripts/calendarOutboxWorker.js'];
  for (const dir of ['lib', 'routes']) {
    (function walk(d) {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.js')) out.push(rel);
      }
    })(dir);
  }
  return out.filter(f => fs.existsSync(path.join(ROOT, f)));
}

test('9. No backend runtime code selects on follow_up_type = Meeting (SQL or JS), except the one documented availability carve-out', () => {
  // PERMANENT RULE (post-Jamey-Corey production defect): an active Meeting
  // Follow-Up is a real physical meeting and must use the SAME canonical
  // physical-meeting scheduling semantics as an Appointment — including
  // BLOCKING availability. lib/booking/availabilityService.js is therefore
  // the one, deliberate, narrowly-scoped place allowed to select on
  // follow_up_type = 'Meeting', solely to add it as an additional busy
  // source (see lib/booking/followUpMeeting.js#isActiveMeetingFollowUp and
  // test/followUpMeeting.test.js). This does NOT weaken the original intent
  // of this test: a Meeting follow-up must still never be read as, or
  // conflated with, an appointments row anywhere else — reminders, routing
  // and the manual reminder route are proven unchanged by tests 3-8, 10, 11.
  // routes/routing.js (Daily Map's /daily-schedule) is a second deliberate
  // carve-out, for the identical reason: an active Meeting Follow-Up is a
  // real physical meeting and must appear as a route stop (see test 10's
  // carve-out below). lib/booking/appointmentWriter.js is a third: the
  // write-path conflict check must enforce the SAME blocking the
  // availability display shows, or a slot shown blocked could still be
  // double-booked (see test 12's carve-out below and
  // test/appointmentAvailabilityParity.test.js).
  const ALLOWED = ['lib/booking/availabilityService.js', 'routes/routing.js', 'lib/booking/appointmentWriter.js'];
  const offenders = [];
  for (const f of runtimeFiles()) {
    if (ALLOWED.includes(f)) continue;
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');         // line comments
    if (/follow_up_type\s*(=|===|==)\s*'Meeting'/.test(code)) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, []);
});

test('10. Routing: appointments remain the primary source everywhere; routing.js additionally UNIONs active Meeting Follow-Ups (PERMANENT RULE, mirror-deduped); routingDiagnostic.js is unchanged', () => {
  for (const f of ['routes/routing.js', 'routes/routingDiagnostic.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /legacyWhere/, f);
    assert.match(src, /lower\(a\.busy_range\) < a\.start_at/, `${f}: Meetings identified by their own buffered busy_range`);
  }
  // routingDiagnostic.js is an ops-only diagnostic surface, not part of the
  // Daily Map UI — deliberately NOT extended with the Meeting Follow-Up rule.
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, 'routes/routingDiagnostic.js'), 'utf8'),
    /l\.follow_up_date\s*=\s*\$/,
    'routes/routingDiagnostic.js'
  );
  // routes/routing.js (Daily Map's /daily-schedule) DOES now UNION active
  // Meeting Follow-Ups as additional route stops, deduped against a real
  // appointment for the same lead (PR #8 mirror-dedup principle, applied
  // horizontally — the appointment always wins).
  const routingSrc = fs.readFileSync(path.join(ROOT, 'routes/routing.js'), 'utf8');
  assert.match(routingSrc, /l\.follow_up_type\s*=\s*'Meeting'/, 'routes/routing.js must query active Meeting Follow-Ups');
  assert.match(routingSrc, /l\.follow_up_date\s*=\s*\$/, 'routes/routing.js');
  assert.match(routingSrc, /apptLeadIds\.has\(r\.id\)/, 'routes/routing.js must dedupe a Meeting Follow-Up against its own lead\'s real appointment');
});

test('11. Manual reminder route uses the appointment only, never the follow-up', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/emails.js'), 'utf8');
  const route = src.slice(src.indexOf("router.post('/leads/:id/remind'"), src.indexOf("router.post('/invoices/:id/email'"));
  assert.ok(route.length > 0);
  assert.doesNotMatch(route, /follow_up_/);
  assert.match(route, /const apptDate = lead\.appointment_date;/);
});

test('12. Booking creates an appointment only from start_at — never from follow-up fields', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/booking/bookingService.js'), 'utf8');
  assert.match(src, /const withAppointment = !!start_at;/);
  // lib/booking/availabilityService.js and lib/booking/appointmentWriter.js
  // are EXCLUDED from this list under the PERMANENT RULE above: they
  // deliberately read active Meeting Follow-Ups as an additional busy /
  // conflict source (lib/booking/followUpMeeting.js) so the availability
  // display and the write-path enforcement agree. Neither ever
  // creates/writes an appointments row FROM a follow-up — that guarantee is
  // unaffected and remains proven for slotBlocking.js and
  // googleAvailability.js below.
  for (const f of ['lib/booking/slotBlocking.js', 'lib/booking/googleAvailability.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /follow_up/, `${f} must not read follow-ups`);
  }
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, 'lib/booking/appointmentWriter.js'), 'utf8'),
    /INSERT INTO appointments/,
    'lib/booking/appointmentWriter.js must still never itself write an appointments row from a follow-up'
  );
});
