/* eslint-disable no-undef */
/**
 * appointmentKind — derive an appointment's kind from the row itself.
 *
 * bookingService reserves busy_range with a 1h travel buffer on both sides for
 * Meetings and NO buffer for Phone Calls, so the reserved range is the durable
 * record of which kind was booked. Deriving kind from it means the calendar
 * event title, the travel event, the blocking and the UI label can never
 * disagree (and never depend on the lead's follow-up fields).
 */
'use strict';

// pg returns tstzrange as text: ["2026-09-24 22:00:00+00","2026-09-25 01:00:00+00")
function parseRangeLower(range) {
  if (!range) return null;
  if (typeof range === 'object' && range.lower) return new Date(range.lower);
  const m = String(range).match(/^[[(]"?([^",]+)"?,/);
  if (!m) return null;
  const d = new Date(m[1].replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return isNaN(d.getTime()) ? null : d;
}

/** 'Meeting' | 'Phone Call' (null when no appointment). */
function appointmentKind(appt) {
  if (!appt) return null;
  const lower = parseRangeLower(appt.busy_range);
  if (!lower || !appt.start_at) return 'Meeting';
  return lower.getTime() >= new Date(appt.start_at).getTime() ? 'Phone Call' : 'Meeting';
}

function isPhoneCallAppointment(appt) {
  return appointmentKind(appt) === 'Phone Call';
}

module.exports = { parseRangeLower, appointmentKind, isPhoneCallAppointment };
