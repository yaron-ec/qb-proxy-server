/* eslint-disable no-undef */
'use strict';

/**
 * currentAction.test.js — pure unit coverage for the canonical
 * current-action selector (lib/booking/currentAction.js), using the exact
 * production shapes (Muhammad Khan, Jamey Corey, Mario Ibanez) that
 * motivated the FINAL AUTHORITATIVE CURRENT-ACTION RULE: current work is
 * derived ENTIRELY from the Follow-Up / Next Update. There is NO
 * Appointment fallback.
 */
const test = require('node:test');
const assert = require('node:assert');
const { isCurrentWorkForDay, currentActionForDay, isCurrentPhysicalMeetingForDay } = require('../lib/booking/currentAction');
const CASES = require('./fixtures/currentActionCases');

function lead(overrides) {
  return {
    appointment_date: null, appointment_time: null, appointment_type: null,
    follow_up_date: null, follow_up_time: null, follow_up_type: null, follow_up_status: null,
    ...overrides,
  };
}

test('Muhammad Khan: Appointment 9:00 AM + active Meeting Follow-Up 10:00 AM — current work is ONLY the 10:00 AM Follow-Up', () => {
  const l = lead({
    appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(isCurrentWorkForDay(l, '2026-10-01'), true);
  assert.deepStrictEqual(currentActionForDay(l, '2026-10-01'), { date: '2026-10-01', time: '10:00', type: 'Meeting', isPhysicalMeeting: true });
  assert.strictEqual(isCurrentPhysicalMeetingForDay(l, '2026-10-01'), true);
});

test('Jamey Corey: historical Appointment Sep 29 + active Meeting Follow-Up Oct 1 — Oct 1 current work is the Follow-Up; Sep 29 has NO current work (no Appointment fallback)', () => {
  const l = lead({
    appointment_date: '2026-09-29', appointment_time: '18:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-01', follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.deepStrictEqual(currentActionForDay(l, '2026-10-01'), { date: '2026-10-01', time: '12:00', type: 'Meeting', isPhysicalMeeting: true });
  assert.strictEqual(currentActionForDay(l, '2026-09-29'), null, 'the Appointment\'s own day has no current work — Appointment is never a fallback');
});

test('Mario Ibanez: a current Appointment with NO active Follow-Up — NO current work at all (the Appointment never fills in)', () => {
  const l = lead({ appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting' });
  assert.strictEqual(isCurrentWorkForDay(l, '2026-10-01'), false);
  assert.strictEqual(currentActionForDay(l, '2026-10-01'), null);
});

test('a same-day Phone Call/Text/Email/Other Follow-Up IS current work (as its own type), while the Appointment is never current', () => {
  for (const type of ['Phone Call', 'Text', 'Email', 'Other']) {
    const l = lead({
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: type, follow_up_status: 'pending',
    });
    assert.deepStrictEqual(currentActionForDay(l, '2026-10-01'), { date: '2026-10-01', time: '09:00', type, isPhysicalMeeting: false }, type);
    assert.strictEqual(isCurrentPhysicalMeetingForDay(l, '2026-10-01'), false, `${type} is never a physical meeting`);
  }
});

test('a COMPLETED Meeting Follow-Up is not active — no current work (never falls back to the Appointment)', () => {
  const l = lead({
    appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
    follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'completed',
  });
  assert.strictEqual(currentActionForDay(l, '2026-10-01'), null);
});

test('neither an Appointment nor an active Follow-Up for the day: no current work', () => {
  const l = lead({});
  assert.strictEqual(currentActionForDay(l, '2026-10-01'), null);
});

test('an Appointment alone (no Follow-Up at all, any status) never produces current work on its own day', () => {
  const l = lead({ appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting' });
  assert.strictEqual(currentActionForDay(l, '2026-10-01'), null);
  assert.strictEqual(isCurrentWorkForDay(l, '2026-10-01'), false);
});

// DRIFT PROTECTION: the shared canonical truth table (test/fixtures/
// currentActionCases.js) is also run against the frontend mirrors of this
// exact rule (crm-frontend/src/pages/MobileDayView.jsx and
// crm-frontend/src/components/FollowUpsWidget.jsx) — see
// MobileDayView.currentActionParity.test.jsx and
// FollowUpsWidget.currentActionParity.test.jsx. If any of the three
// implementations is ever changed inconsistently with a case below, ITS
// OWN test fails immediately.
for (const c of CASES) {
  test(`fixture: ${c.name}`, () => {
    assert.strictEqual(isCurrentWorkForDay(c.lead, c.day), c.expected.isCurrent, JSON.stringify(c));
    assert.deepStrictEqual(currentActionForDay(c.lead, c.day), c.expected.isCurrent
      ? { date: c.lead.follow_up_date, time: c.lead.follow_up_time, type: c.lead.follow_up_type, isPhysicalMeeting: c.expected.isPhysicalMeeting }
      : null, JSON.stringify(c));
    assert.strictEqual(isCurrentPhysicalMeetingForDay(c.lead, c.day), c.expected.isPhysicalMeeting, JSON.stringify(c));
  });
}
