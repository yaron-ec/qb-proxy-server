/* eslint-disable no-undef */
'use strict';

/**
 * currentAction.test.js — pure unit coverage for the canonical
 * current-action selector (lib/booking/currentAction.js), using the exact
 * production shapes (Muhammad Khan, Jamey Corey, Mario Ibanez) that
 * motivated the AUTHORITATIVE CURRENT-ACTION RULE.
 */
const test = require('node:test');
const assert = require('node:assert');
const { currentPhysicalMeetingForDay, isAppointmentSupersededForDay } = require('../lib/booking/currentAction');
const CASES = require('./fixtures/currentActionCases');

function lead(overrides) {
  return {
    appointment_date: null, appointment_time: null, appointment_type: null,
    follow_up_date: null, follow_up_time: null, follow_up_type: null, follow_up_status: null,
    ...overrides,
  };
}

test('Muhammad Khan: Appointment 9:00 AM + active Meeting Follow-Up 10:00 AM (same day) — current physical meeting is ONLY the 10:00 AM Follow-Up', () => {
  const l = lead({
    appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(isAppointmentSupersededForDay(l, '2026-10-01'), true);
  assert.deepStrictEqual(currentPhysicalMeetingForDay(l, '2026-10-01'), { source: 'follow_up', date: '2026-10-01', time: '10:00', type: 'Meeting' });
});

test('Jamey Corey: historical Appointment Sep 29 + active Meeting Follow-Up Oct 1 — Oct 1 shows ONLY the Follow-Up; Sep 29 is unaffected on its own day', () => {
  const l = lead({
    appointment_date: '2026-09-29', appointment_time: '18:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-01', follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(isAppointmentSupersededForDay(l, '2026-10-01'), false, 'the Appointment is not even dated Oct 1 — not a same-day candidate');
  assert.deepStrictEqual(currentPhysicalMeetingForDay(l, '2026-10-01'), { source: 'follow_up', date: '2026-10-01', time: '12:00', type: 'Meeting' });
  // On its OWN day (Sep 29), the Appointment is not superseded (the Follow-Up is dated Oct 1, a different day).
  assert.strictEqual(isAppointmentSupersededForDay(l, '2026-09-29'), false);
  assert.deepStrictEqual(currentPhysicalMeetingForDay(l, '2026-09-29'), { source: 'appointment', date: '2026-09-29', time: '18:00', type: 'Meeting' });
});

test('Mario Ibanez: current Appointment, no superseding active Follow-Up — the Appointment remains the current physical meeting', () => {
  const l = lead({ appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting' });
  assert.strictEqual(isAppointmentSupersededForDay(l, '2026-10-01'), false);
  assert.deepStrictEqual(currentPhysicalMeetingForDay(l, '2026-10-01'), { source: 'appointment', date: '2026-10-01', time: '14:00', type: 'Meeting' });
});

test('exact mirror (same date AND time): the Follow-Up still wins — same outcome as a different-time same-day pair', () => {
  const l = lead({
    appointment_date: '2026-10-01', appointment_time: '16:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-01', follow_up_time: '16:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(isAppointmentSupersededForDay(l, '2026-10-01'), true);
  assert.strictEqual(currentPhysicalMeetingForDay(l, '2026-10-01').source, 'follow_up');
});

test('independent future Appointment NOT superseded by a Follow-Up dated a different day: preserved as future schedule on its own day', () => {
  const l = lead({
    appointment_date: '2026-10-05', appointment_time: '11:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-10', follow_up_time: '09:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(isAppointmentSupersededForDay(l, '2026-10-05'), false);
  assert.deepStrictEqual(currentPhysicalMeetingForDay(l, '2026-10-05'), { source: 'appointment', date: '2026-10-05', time: '11:00', type: 'Meeting' });
  assert.deepStrictEqual(currentPhysicalMeetingForDay(l, '2026-10-10'), { source: 'follow_up', date: '2026-10-10', time: '09:00', type: 'Meeting' });
});

test('a same-day Phone Call/Text/Email/Other Follow-Up never supersedes the Appointment — the Appointment remains the current PHYSICAL meeting (the Follow-Up is a separate, non-physical obligation handled elsewhere)', () => {
  for (const type of ['Phone Call', 'Text', 'Email', 'Other']) {
    const l = lead({
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: type, follow_up_status: 'pending',
    });
    assert.strictEqual(isAppointmentSupersededForDay(l, '2026-10-01'), false, `${type} must not supersede`);
    assert.deepStrictEqual(currentPhysicalMeetingForDay(l, '2026-10-01'), { source: 'appointment', date: '2026-10-01', time: '14:00', type: 'Meeting' }, `${type} must not supersede`);
  }
});

test('a COMPLETED Meeting Follow-Up never supersedes — the Appointment is current again', () => {
  const l = lead({
    appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'completed',
  });
  assert.strictEqual(isAppointmentSupersededForDay(l, '2026-10-01'), false);
  assert.strictEqual(currentPhysicalMeetingForDay(l, '2026-10-01').source, 'appointment');
});

test('neither an Appointment nor an active Follow-Up for the day: no current physical meeting', () => {
  const l = lead({});
  assert.strictEqual(currentPhysicalMeetingForDay(l, '2026-10-01'), null);
});

test('a legacy Phone Call appointment_type is never treated as a physical Appointment', () => {
  const l = lead({ appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Phone Call' });
  assert.strictEqual(currentPhysicalMeetingForDay(l, '2026-10-01'), null);
});

// DRIFT PROTECTION: the shared canonical truth table (test/fixtures/
// currentActionCases.js) is also run against the two frontend mirrors of
// this exact predicate (crm-frontend/src/pages/MobileDayView.jsx and
// crm-frontend/src/components/FollowUpsWidget.jsx) — see
// MobileDayView.currentActionParity.test.jsx and
// FollowUpsWidget.currentActionParity.test.jsx. If any of the three
// implementations is ever changed inconsistently with a case below, ITS
// OWN test fails immediately.
for (const c of CASES) {
  test(`fixture: ${c.name}`, () => {
    assert.strictEqual(isAppointmentSupersededForDay(c.lead, c.day), c.superseded, JSON.stringify(c));
  });
}
