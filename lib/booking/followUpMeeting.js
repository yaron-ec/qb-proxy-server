/* eslint-disable no-undef */
/**
 * followUpMeeting — a Follow-Up of type 'Meeting' represents a REAL physical
 * customer meeting (PERMANENT RULE). It gets the SAME canonical
 * physical-meeting scheduling semantics as a real Appointment:
 *   - 1 hour duration (fixed — a Meeting Follow-Up has no appointment_type_id
 *     to resolve a duration from, unlike a real Appointment);
 *   - a Google Calendar main event, BUSY (not free), and a Driving / Travel
 *     Time event — built by literally calling
 *     lib/booking/calendarOutbox.js#buildOperation, the ONE canonical
 *     travel/main-event builder (see test/phoneCallNonBlocking.test.js's
 *     "ONE travel rule" guard) — never a second implementation. This file
 *     only constructs a "virtual appointment" shape buildOperation already
 *     knows how to consume.
 *
 * This NEVER creates an `appointments` row — the Follow-Up and the
 * Appointment remain independent CRM records (lib/followUp.js). A Meeting
 * Follow-Up's "occupancy" is a SEPARATE, additively-modeled busy source
 * (see lib/booking/availabilityService.js and routes/routing.js), not a
 * second copy of the appointments table.
 *
 * Phone Call / Text / Email / Other follow-ups are UNCHANGED by this file:
 * they keep the existing lightweight, FREE, non-blocking 15-minute reminder
 * built by lib/booking/followUpReminders.js's own buildReminderEvent().
 */
'use strict';

const { followUpStartIso, TZ } = require('./phoneCallModel');

const MEETING_DURATION_MINUTES = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d/;

/** An ACTIVE, timed Meeting follow-up — the one gate for the physical-meeting representation. */
function isActiveMeetingFollowUp(lead) {
  return !!lead
    && String(lead.follow_up_type || '').trim() === 'Meeting'
    && lead.follow_up_status !== 'completed'
    && DATE_RE.test(String(lead.follow_up_date || ''))
    && TIME_RE.test(String(lead.follow_up_time || ''));
}

/** The meeting's actual, UNBUFFERED [start, end) window (start, start+1h). */
function meetingWindow(lead, tz) {
  const start = new Date(followUpStartIso(lead, tz || TZ));
  const end = new Date(start.getTime() + MEETING_DURATION_MINUTES * 60 * 1000);
  return { start, end };
}

/** The meeting's BUFFERED busy window — identical formula to a real
 * Appointment's busy_range (lib/booking/bookingService.js#busyWindow):
 * [start - bufferMinutes, end + bufferMinutes]. */
function meetingBusyWindow(lead, tz, bufferMinutes) {
  const { busyWindow } = require('./bookingService');
  const { start, end } = meetingWindow(lead, tz);
  const { busyStart, busyEnd } = busyWindow(start, end, false, bufferMinutes);
  return { busyStart, busyEnd };
}

/**
 * A "virtual appointment" shape good enough for
 * calendarOutbox.js#buildOperation to build a real main + travel event body
 * from — WITHOUT ever inserting an `appointments` row. `id` bakes in the
 * lead + generation (bumped whenever this representation's event(s) are
 * cancelled — see followUpReminders.js), so computeGoogleEventId's hash
 * (id + date + hhmm + kind) can never collide with a previously-cancelled
 * event's id the way a bare, generation-less lead id could.
 *
 * No `busy_range` is set, so calendarOutbox's own isPhoneCallAppointment()
 * (lib/booking/appointmentKind.js#appointmentKind: "no busy_range -> treat
 * as Meeting") classifies this as a Meeting for free — the exact summary
 * ("Meeting with <name>"), attendee set and travel eligibility a real
 * Appointment's main event gets, with zero new classification logic.
 */
function virtualAppointmentFor(lead, generation, tz) {
  const zone = tz || TZ;
  const { start, end } = meetingWindow(lead, zone);
  return {
    id: `followup-meeting:${lead.id}:g${generation || 0}`,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    timezone: zone,
    version: generation || 0,
  };
}

module.exports = {
  MEETING_DURATION_MINUTES,
  isActiveMeetingFollowUp, meetingWindow, meetingBusyWindow, virtualAppointmentFor,
};
