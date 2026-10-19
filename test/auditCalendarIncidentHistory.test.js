/* eslint-disable no-undef */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyzeAttendeeHistory, classifyAppointment } = require('../scripts/auditCalendarIncidentHistory');

const MICHELLE = 'michelle@ecconstructiongroup.com';
const YARON = 'yaron@ecconstructiongroup.com';

test('analyzeAttendeeHistory: flags a staff member present in an earlier payload and absent from a later one as an unintended removal', () => {
  const rows = [
    { action: 'create_main', created_at: '2026-10-16T10:00:00Z', payload: { attendees: [{ email: YARON }, { email: MICHELLE }] } },
    { action: 'update_main', created_at: '2026-10-17T10:00:00Z', payload: { attendees: [{ email: YARON }] } },
  ];
  const result = analyzeAttendeeHistory(rows, [MICHELLE, YARON]);
  assert.strictEqual(result[MICHELLE].ever_present, true);
  assert.strictEqual(result[MICHELLE].currently_present, false);
  assert.strictEqual(result[MICHELLE].unintended_removal, true);
  assert.strictEqual(result[MICHELLE].removed_at, '2026-10-17T10:00:00Z');
  assert.strictEqual(result[MICHELLE].removed_at_action, 'update_main');
  assert.strictEqual(result[YARON].unintended_removal, false);
});

test('analyzeAttendeeHistory: a staff member present in every payload is never flagged', () => {
  const rows = [
    { action: 'create_main', created_at: '2026-10-16T10:00:00Z', payload: { attendees: [{ email: YARON }, { email: MICHELLE }] } },
    { action: 'update_main', created_at: '2026-10-18T10:00:00Z', payload: { attendees: [{ email: YARON }, { email: MICHELLE }] } },
  ];
  const result = analyzeAttendeeHistory(rows, [MICHELLE, YARON]);
  assert.strictEqual(result[MICHELLE].unintended_removal, false);
  assert.strictEqual(result[MICHELLE].currently_present, true);
});

test('analyzeAttendeeHistory: a staff member NEVER present at all is not flagged as a "removal" (never_present, not removed)', () => {
  const rows = [
    { action: 'create_main', created_at: '2026-10-16T10:00:00Z', payload: { attendees: [{ email: YARON }] } },
  ];
  const result = analyzeAttendeeHistory(rows, [MICHELLE]);
  assert.strictEqual(result[MICHELLE].ever_present, false);
  assert.strictEqual(result[MICHELLE].unintended_removal, false, 'never having been invited is a different (also real, but distinct) gap from being removed');
});

test('analyzeAttendeeHistory: only captures the FIRST drop — re-adding then dropping again still reports the original removal timestamp', () => {
  const rows = [
    { action: 'create_main', created_at: '2026-10-16T09:00:00Z', payload: { attendees: [{ email: MICHELLE }] } },
    { action: 'update_main', created_at: '2026-10-17T09:00:00Z', payload: { attendees: [] } },
    { action: 'update_main', created_at: '2026-10-18T09:00:00Z', payload: { attendees: [{ email: MICHELLE }] } },
    { action: 'update_main', created_at: '2026-10-19T09:00:00Z', payload: { attendees: [] } },
  ];
  const result = analyzeAttendeeHistory(rows, [MICHELLE]);
  assert.strictEqual(result[MICHELLE].unintended_removal, true);
  assert.strictEqual(result[MICHELLE].removed_at, '2026-10-17T09:00:00Z', 'reports the first removal, not a later one');
  assert.strictEqual(result[MICHELLE].currently_present, false, 'but currently_present reflects the LATEST payload');
});

test('analyzeAttendeeHistory: ignores cancel_main rows (null payload) entirely — a cancellation is not an "attendee removal"', () => {
  const rows = [
    { action: 'create_main', created_at: '2026-10-16T09:00:00Z', payload: { attendees: [{ email: MICHELLE }] } },
    { action: 'cancel_main', created_at: '2026-10-17T09:00:00Z', payload: null },
  ];
  const result = analyzeAttendeeHistory(rows, [MICHELLE]);
  assert.strictEqual(result[MICHELLE].unintended_removal, false, 'the appointment was cancelled outright for everyone, not silently stripped of one attendee');
  assert.strictEqual(result[MICHELLE].currently_present, true, 'the last MAIN payload (pre-cancel) still had Michelle — the cancellation itself is tracked by classifyAppointment, not here');
});

test('classifyAppointment: active appointments are "active"', () => {
  assert.strictEqual(classifyAppointment({ status: 'scheduled' }, false), 'active');
  assert.strictEqual(classifyAppointment({ status: 'confirmed' }, false), 'active');
});

test('classifyAppointment: completed/no_show pass through unchanged', () => {
  assert.strictEqual(classifyAppointment({ status: 'completed' }, false), 'completed');
  assert.strictEqual(classifyAppointment({ status: 'no_show' }, false), 'no_show');
});

test('classifyAppointment: rescheduled becomes rescheduled_superseded', () => {
  assert.strictEqual(classifyAppointment({ status: 'rescheduled' }, false), 'rescheduled_superseded');
});

test('classifyAppointment: cancelled WITH a matching terminal-lost note is legitimate', () => {
  assert.strictEqual(classifyAppointment({ status: 'cancelled' }, true), 'cancelled_terminal_lost');
});

test('classifyAppointment: cancelled WITHOUT a matching terminal-lost note needs human review', () => {
  assert.strictEqual(classifyAppointment({ status: 'cancelled' }, false), 'cancelled_needs_review');
});
