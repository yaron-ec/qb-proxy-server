/* eslint-disable no-undef */
'use strict';

/**
 * followUpAppointmentMismatch.test.js — pure unit coverage for
 * routes/leads.js#followUpAppointmentMismatch (November 2026 "John John"
 * production incident fix): a read-only signal surfaced on the serialized
 * lead so the CRM can warn a rep the moment a Follow-Up diverges from the
 * active Appointment, instead of this only being discoverable later via a
 * stale Google Calendar event. Mirrors (but does not literally share code
 * with — see the function's own header) scripts/auditAppointmentFollowUp.js's
 * DIVERGENT classification; this test pins the comparison logic itself.
 */
const test = require('node:test');
const assert = require('node:assert');
const { followUpAppointmentMismatch } = require('../routes/leads');

const appt = { date: '2026-11-20', time: '09:00', kind: 'Meeting', status: 'scheduled' };

test('no active appointment -> never a mismatch, regardless of follow-up', () => {
  assert.strictEqual(followUpAppointmentMismatch({ follow_up_date: '2026-11-23', follow_up_type: 'Meeting' }, null), null);
});

test('no dated, scheduled-type follow-up -> never a mismatch', () => {
  assert.strictEqual(followUpAppointmentMismatch({ follow_up_date: null, follow_up_type: null }, appt), null);
  assert.strictEqual(followUpAppointmentMismatch({ follow_up_date: '2026-11-23', follow_up_type: 'Text' }, appt), null);
  assert.strictEqual(followUpAppointmentMismatch({ follow_up_date: '2026-11-23', follow_up_type: 'Other' }, appt), null);
});

test('identical date/time/kind -> null (a MIRROR, not a divergence warning)', () => {
  const r = followUpAppointmentMismatch({ follow_up_date: '2026-11-20', follow_up_time: '09:00', follow_up_type: 'Meeting' }, appt);
  assert.strictEqual(r, null);
});

test('the exact John John shape: different date -> different_date', () => {
  const r = followUpAppointmentMismatch({ follow_up_date: '2026-11-23', follow_up_time: '09:00', follow_up_type: 'Meeting' }, appt);
  assert.deepStrictEqual(r, {
    reason: 'different_date',
    appointment_date: '2026-11-20', appointment_time: '09:00', appointment_kind: 'Meeting',
  });
});

test('same date, different time -> different_time', () => {
  const r = followUpAppointmentMismatch({ follow_up_date: '2026-11-20', follow_up_time: '14:00', follow_up_type: 'Meeting' }, appt);
  assert.strictEqual(r.reason, 'different_time');
});

test('same date and time, different kind -> kind_only', () => {
  const r = followUpAppointmentMismatch({ follow_up_date: '2026-11-20', follow_up_time: '09:00', follow_up_type: 'Phone Call' }, appt);
  assert.strictEqual(r.reason, 'kind_only');
});

test('a dated Phone Call follow-up (not just Meeting) is also checked', () => {
  const r = followUpAppointmentMismatch({ follow_up_date: '2026-12-01', follow_up_time: null, follow_up_type: 'Phone Call' }, appt);
  assert.strictEqual(r.reason, 'different_date');
});

test('leads.follow_up_date is a plain TEXT column (db/migrations/2026-09-crm-core.sql) — never a Date object needing conversion here', () => {
  const r = followUpAppointmentMismatch({ follow_up_date: '2026-11-23', follow_up_time: '09:00:00', follow_up_type: 'Meeting' }, appt);
  // follow_up_time with seconds (":00" appended) must still compare correctly against the appointment's "HH:MM" time.
  assert.strictEqual(r.reason, 'different_date');
});

test('a missing follow_up_time (never scheduled with a time) never crashes and compares as null vs the appointment time', () => {
  const r = followUpAppointmentMismatch({ follow_up_date: '2026-11-20', follow_up_time: null, follow_up_type: 'Meeting' }, appt);
  assert.strictEqual(r.reason, 'different_time');
});
