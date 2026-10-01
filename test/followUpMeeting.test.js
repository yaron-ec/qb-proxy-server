/* eslint-disable no-undef */
'use strict';

/**
 * followUpMeeting.test.js — pure tests of the physical-meeting representation
 * for a Follow-Up of type 'Meeting' (lib/booking/followUpMeeting.js).
 *
 * PERMANENT RULE: a Meeting follow-up is a real physical customer meeting —
 * 1 hour duration, a BUSY main event, and a Driving/Travel Time event built
 * by literally calling calendarOutbox.js#buildOperation (the ONE canonical
 * travel/main-event builder — see test/phoneCallNonBlocking.test.js's "ONE
 * travel rule" guard) against a "virtual appointment" shape. This file never
 * reimplements event content — it only proves the virtual-appointment
 * adapter produces the SAME output buildOperation gives a real Appointment.
 * Real-Postgres coverage: test/integration/followUpMeeting.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  MEETING_DURATION_MINUTES, isActiveMeetingFollowUp, meetingWindow, meetingBusyWindow, virtualAppointmentFor,
} = require('../lib/booking/followUpMeeting');
const { buildOperation } = require('../lib/booking/calendarOutbox');
const { isNonBlockingCrmGoogleEvent } = require('../lib/booking/phoneCallModel');
const { isExcluded } = require('../lib/booking/googleAvailability');

const LEAD = {
  id: '22222222-3333-4444-5555-666666666666', first_name: 'Jamey', last_name: 'Corey',
  email: 'jamey@example.com', phone: '555-0199', property_address: '123 Main St', city: 'Corona', project_type: 'Kitchen',
  follow_up_type: 'Meeting', follow_up_date: '2026-10-01', follow_up_time: '12:00',
  follow_up_status: 'pending', follow_up_notes: null, owner_email: 'rep@example.com',
};

test('MEETING_DURATION_MINUTES is exactly 1 hour, per the permanent rule', () => {
  assert.strictEqual(MEETING_DURATION_MINUTES, 60);
});

test('isActiveMeetingFollowUp: only an active, timed Meeting follow-up qualifies', () => {
  assert.strictEqual(isActiveMeetingFollowUp(LEAD), true);
  assert.strictEqual(isActiveMeetingFollowUp({ ...LEAD, follow_up_status: 'completed' }), false);
  assert.strictEqual(isActiveMeetingFollowUp({ ...LEAD, follow_up_time: null }), false);
  for (const t of ['Phone Call', 'Text', 'Email', 'Other', null]) {
    assert.strictEqual(isActiveMeetingFollowUp({ ...LEAD, follow_up_type: t }), false, `${t} is never a physical meeting`);
  }
});

test('meetingWindow: the actual, unbuffered window is exactly 1 hour (12:00 PM-1:00 PM for Jamey)', () => {
  const { start, end } = meetingWindow(LEAD);
  assert.strictEqual(start.toISOString(), '2026-10-01T19:00:00.000Z'); // 12:00 PM PDT
  assert.strictEqual(end.toISOString(), '2026-10-01T20:00:00.000Z'); // 1:00 PM PDT
  assert.strictEqual((end - start) / 60000, 60);
});

test('meetingBusyWindow: buffered exactly like a real Appointment (1h before + 1h duration + 1h after, with the configured buffer)', () => {
  const { busyStart, busyEnd } = meetingBusyWindow(LEAD, undefined, 60);
  assert.strictEqual(busyStart.toISOString(), '2026-10-01T18:00:00.000Z'); // 11:00 AM
  assert.strictEqual(busyEnd.toISOString(), '2026-10-01T21:00:00.000Z'); // 2:00 PM
});

test('virtualAppointmentFor: a shape calendarOutbox.buildOperation can consume directly — no busy_range, so it reads as Meeting-kind for free', () => {
  const va = virtualAppointmentFor(LEAD, 0);
  assert.strictEqual(va.start_at, '2026-10-01T19:00:00.000Z');
  assert.strictEqual(va.end_at, '2026-10-01T20:00:00.000Z');
  assert.strictEqual(va.timezone, 'America/Los_Angeles');
  assert.strictEqual(va.busy_range, undefined, 'no busy_range — appointmentKind() falls back to Meeting');
  assert.notStrictEqual(virtualAppointmentFor(LEAD, 0).id, virtualAppointmentFor(LEAD, 1).id, 'generation is baked into the id');
});

test('buildOperation(virtualAppointment, ..., "main"): a BUSY (not free) 1-hour event, summary/attendees matching a real Appointment main event', () => {
  const va = virtualAppointmentFor(LEAD, 0);
  const { body: ev } = buildOperation(va, LEAD, LEAD.owner_email, 'main', ['michelle@example.com']);
  assert.deepStrictEqual(ev.start, { dateTime: '2026-10-01T12:00:00', timeZone: 'America/Los_Angeles' });
  assert.deepStrictEqual(ev.end, { dateTime: '2026-10-01T13:00:00', timeZone: 'America/Los_Angeles' });
  assert.strictEqual(ev.transparency, undefined, 'no transparency override — defaults BUSY, same as a real Appointment main event');
  assert.match(ev.summary, /^Meeting with Jamey Corey$/);
  assert.strictEqual(ev.location, '123 Main St, Corona');
  const attendeeEmails = ev.attendees.map((a) => a.email).sort();
  assert.deepStrictEqual(attendeeEmails, ['jamey@example.com', 'michelle@example.com', 'rep@example.com'].sort());
  assert.strictEqual(ev.extendedProperties.private.ec_kind, 'main');
  assert.strictEqual(ev.extendedProperties.private.ec_appointment_kind, 'meeting');
  // Same markers a real Appointment main event carries — the EXISTING
  // classifiers already treat it as occupancy, zero new exclusion logic.
  assert.strictEqual(isNonBlockingCrmGoogleEvent(ev), false, 'a physical meeting BLOCKS — it is never excluded');
  assert.strictEqual(isExcluded(ev), false);
});

test('buildOperation(virtualAppointment, ..., "travel"): identical shape to a real Appointment travel event — opaque, after the meeting, configured buffer duration', () => {
  const va = virtualAppointmentFor(LEAD, 0);
  const { body: ev } = buildOperation(va, LEAD, LEAD.owner_email, 'travel', [], 60);
  assert.strictEqual(ev.summary, 'Driving / Travel Time');
  assert.strictEqual(ev.transparency, 'opaque');
  assert.deepStrictEqual(ev.start, { dateTime: '2026-10-01T13:00:00', timeZone: 'America/Los_Angeles' }); // right after the 1h meeting ends
  assert.deepStrictEqual(ev.end, { dateTime: '2026-10-01T14:00:00', timeZone: 'America/Los_Angeles' }); // +60min buffer
  assert.strictEqual(ev.extendedProperties.private.ec_kind, 'travel');
  // Travel itself is non-blocking by marker (the main event's own buffer already covers it) — same as a real Appointment's travel event.
  assert.strictEqual(isNonBlockingCrmGoogleEvent(ev), true);
});

test('meeting main+travel ids are deterministic per lead + generation; never collide with each other or with the reminder id scheme', () => {
  const { reminderEventId } = require('../lib/booking/followUpReminders');
  const va = virtualAppointmentFor(LEAD, 0);
  const mainId = buildOperation(va, LEAD, LEAD.owner_email, 'main', []).googleEventId;
  const travelId = buildOperation(va, LEAD, LEAD.owner_email, 'travel', [], 60).googleEventId;
  const reminderId = reminderEventId(LEAD.id, 0);
  assert.notStrictEqual(mainId, travelId);
  assert.notStrictEqual(mainId, reminderId);
  assert.notStrictEqual(travelId, reminderId);
  const vaGen1 = virtualAppointmentFor(LEAD, 1);
  const mainIdGen1 = buildOperation(vaGen1, LEAD, LEAD.owner_email, 'main', []).googleEventId;
  assert.notStrictEqual(mainId, mainIdGen1, 'a new generation never reuses a removed id');
});

test('rescheduling (same lead+generation, different time) changes the id — reconciler cancels the old event and creates the new one (same idiom as a real Appointment reschedule)', () => {
  const va = virtualAppointmentFor(LEAD, 0);
  const rescheduled = virtualAppointmentFor({ ...LEAD, follow_up_time: '15:00' }, 0);
  const idBefore = buildOperation(va, LEAD, LEAD.owner_email, 'main', []).googleEventId;
  const idAfter = buildOperation(rescheduled, LEAD, LEAD.owner_email, 'main', []).googleEventId;
  assert.notStrictEqual(idBefore, idAfter, 'a different time produces a different id — matches a real Appointment reschedule exactly');
});

test('timezone/DST: the physical meeting + its travel event compute the correct UTC instant on both sides of the 2026-03-08 spring-forward transition', () => {
  const before = { ...LEAD, follow_up_date: '2026-03-07', follow_up_time: '10:00' }; // PST (UTC-8)
  const after = { ...LEAD, follow_up_date: '2026-03-09', follow_up_time: '10:00' }; // PDT (UTC-7)
  const { start: startBefore, end: endBefore } = meetingWindow(before);
  const { start: startAfter, end: endAfter } = meetingWindow(after);
  assert.strictEqual(startBefore.toISOString(), '2026-03-07T18:00:00.000Z');
  assert.strictEqual(endBefore.toISOString(), '2026-03-07T19:00:00.000Z'); // +1h, still PST
  assert.strictEqual(startAfter.toISOString(), '2026-03-09T17:00:00.000Z');
  assert.strictEqual(endAfter.toISOString(), '2026-03-09T18:00:00.000Z'); // +1h, now PDT
  const travelBefore = buildOperation(virtualAppointmentFor(before, 0), before, before.owner_email, 'travel', [], 60).body;
  const travelAfter = buildOperation(virtualAppointmentFor(after, 0), after, after.owner_email, 'travel', [], 60).body;
  assert.strictEqual(travelBefore.start.dateTime, '2026-03-07T11:00:00');
  assert.strictEqual(travelAfter.start.dateTime, '2026-03-09T11:00:00');
});
