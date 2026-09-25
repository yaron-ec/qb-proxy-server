/* eslint-disable no-undef */
'use strict';

/**
 * reconcileCalendarAppointmentsDisabled.test.js — regression guard.
 *
 * routes/cronJobs.js's POST /reconcile-calendar-appointments used to mirror a
 * lead's independent Follow-Up (follow_up_date/follow_up_type) into a real
 * `appointments` row + Google Calendar event, inserting DIRECTLY into
 * `appointments` with NO owner-lock/conflict check at all (a double-booking
 * risk on top of violating the Appointment/Follow-Up separation). Found
 * during the horizontal audit for the "UI shows available, backend rejects"
 * defect and disabled. This guards against it silently coming back.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('reconcile-calendar-appointments no longer inserts into appointments (Follow-Up must never create one)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'cronJobs.js'), 'utf8');
  const start = src.indexOf("router.post('/reconcile-calendar-appointments'");
  assert.ok(start >= 0, 'the route must still exist (disabled in place, not deleted)');
  const nextRoute = src.indexOf("router.post('", start + 1);
  const handlerSrc = src.slice(start, nextRoute > 0 ? nextRoute : undefined);
  assert.ok(!/INSERT INTO appointments/.test(handlerSrc), 'must never insert into appointments (see lib/booking/bookingService.js — the ONE canonical writer)');
  assert.ok(!/follow_up_date/.test(handlerSrc), 'must never read follow_up_date to manifest an appointment');
  assert.ok(/appointment_mirroring_disabled/.test(handlerSrc), 'must report that mirroring is disabled');
});
