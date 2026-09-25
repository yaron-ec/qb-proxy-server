/* eslint-disable no-undef */
'use strict';

/**
 * meetingFollowUpNotAppointment.test.js — Lead Detail → Follow-Up / Next
 * Update → Type "Meeting".
 *
 * CANONICAL RULE: a follow-up of type 'Meeting' is STILL ONLY A FOLLOW-UP
 * (leads.follow_up_*, an internal next action). It must never become an
 * Appointment / Site Visit: no appointments row, no availability blocking,
 * no Google Calendar event, no Driving/Travel Time, no 1h buffer, no
 * customer appointment reminder. Only the canonical appointments row is an
 * appointment (lib/booking/appointmentView.js).
 *
 * Found and fixed in the systemic audit (every one read the follow-up as an
 * appointment):
 *   - lib/reminderTime.js#appointmentParts fell back to a dated 'Meeting' /
 *     'Phone Call' follow-up → customer "Appointment Reminder" emails and
 *     action-page fingerprints for a follow-up.
 *   - routes/routing.js + routes/routingDiagnostic.js UNIONed leads with a
 *     dated 'Meeting' follow-up in as driving stops; routingDiagnostic's
 *     appointment query also selected by l.follow_up_type = 'Meeting'.
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

test('9. No backend runtime code selects on follow_up_type = Meeting (SQL or JS)', () => {
  const offenders = [];
  for (const f of runtimeFiles()) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');         // line comments
    if (/follow_up_type\s*(=|===|==)\s*'Meeting'/.test(code)) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, []);
});

test('10. Routing (driving stops) comes from the appointments table only — no follow-up UNION', () => {
  for (const f of ['routes/routing.js', 'routes/routingDiagnostic.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /legacyWhere/, f);
    assert.doesNotMatch(src, /l\.follow_up_date\s*=\s*\$/, f);
    assert.match(src, /lower\(a\.busy_range\) < a\.start_at/, `${f}: Meetings identified by their own buffered busy_range`);
  }
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
  for (const f of ['lib/booking/appointmentWriter.js', 'lib/booking/availabilityService.js', 'lib/booking/slotBlocking.js', 'lib/booking/googleAvailability.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /follow_up/, `${f} must not read follow-ups`);
  }
});
