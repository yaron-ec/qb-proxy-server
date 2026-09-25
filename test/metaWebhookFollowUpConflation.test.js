/* eslint-disable no-undef */
'use strict';

/**
 * metaWebhookFollowUpConflation.test.js — regression coverage for a
 * Follow-Up/Appointment conflation bug found during the horizontal audit
 * triggered by the Charles Carlson "invalid_id" production defect.
 *
 * ROOT CAUSE: routes/metaWebhook.js's with-appointment branch, right after
 * calling bookingService.createBooking() (whose own adjacent comment says
 * "The appointment lives only in the appointments row — it is not mirrored
 * into the lead's follow_up_* fields"), ran a post-commit UPDATE that
 * itself set `follow_up_type = 'Meeting', meeting_stage = 'First Meeting'`
 * on the lead — directly contradicting that comment and reintroducing the
 * exact Appointment/Follow-Up conflation eliminated everywhere else in the
 * codebase (see routes/cronJobs.js's disabled reconcile-calendar-
 * appointments mirroring, commit 1301d3c). A Follow-Up must remain
 * independent, next-action data — labeling it "Meeting" must never make it
 * participate in availability/conflict/buffer as if it were a real
 * Appointment.
 *
 * FIX: removed both fields from the post-commit UPDATE. meeting_stage is
 * redundant there anyway — bookingService.createBooking()'s own INSERT
 * already sets meeting_stage='First Meeting' (and status='Appointment
 * Scheduled') whenever withAppointment is true; follow_up_type is never
 * derived from the appointment at all — it only ever comes from an
 * explicit, independent `followUp` input.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'metaWebhook.js'), 'utf8');

function extractWithAppointmentBranch() {
  const start = src.indexOf('if (startAt) {');
  assert.ok(start >= 0, 'with-appointment branch not found');
  const end = src.indexOf('} else {', start);
  assert.ok(end > start, 'end of with-appointment branch not found');
  return src.slice(start, end);
}

test('metaWebhook.js with-appointment branch: post-commit UPDATE never sets follow_up_type or meeting_stage', () => {
  const branch = extractWithAppointmentBranch();
  const updateStart = branch.indexOf('UPDATE leads SET');
  assert.ok(updateStart >= 0, 'post-commit UPDATE not found in with-appointment branch');
  const updateStmt = branch.slice(updateStart, branch.indexOf('WHERE id = $2', updateStart) + 'WHERE id = $2'.length);
  assert.ok(!/follow_up_type/.test(updateStmt), 'post-commit UPDATE must never set follow_up_type — the appointment is not a Follow-Up');
  assert.ok(!/meeting_stage/.test(updateStmt), 'post-commit UPDATE must never set meeting_stage — createBooking() already sets it on INSERT');
});

test('metaWebhook.js with-appointment branch calls bookingService.createBooking (the sole path that creates the appointment row)', () => {
  const branch = extractWithAppointmentBranch();
  assert.ok(/await createBooking\(/.test(branch), 'must route through the canonical booking service, never a direct appointments INSERT');
});

test('the no-appointment ("lead only") branch never touches follow_up_type/meeting_stage/appointment fields either', () => {
  const start = src.indexOf('} else {', src.indexOf('if (startAt) {'));
  const end = src.indexOf('router.', start) > 0 ? src.indexOf('router.', start) : src.length;
  const branch = src.slice(start, end);
  assert.ok(!/follow_up_type/.test(branch), 'lead-only branch must not touch follow_up_type');
  assert.ok(!/meeting_stage/.test(branch), 'lead-only branch must not touch meeting_stage');
  assert.ok(!/appointment_date|appointment_time/.test(branch), 'lead-only branch must not fabricate appointment fields');
});

test('lib/booking/bookingService.js — meeting_stage is derived ONLY from withAppointment on INSERT, never from a Follow-Up field', () => {
  const bs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'booking', 'bookingService.js'), 'utf8');
  assert.ok(/withAppointment \? 'First Meeting' : null/.test(bs),
    'meeting_stage must be set from withAppointment (real appointment), not from any follow_up_* input');
  assert.ok(/followUp \? followUp\.follow_up_type : null/.test(bs),
    'follow_up_type must be set from the independent followUp input only, never derived from the appointment');
});
