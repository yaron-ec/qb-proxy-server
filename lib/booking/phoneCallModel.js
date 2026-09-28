/* eslint-disable no-undef */
/**
 * phoneCallModel — the ONE canonical Phone Call classification.
 *
 * A Phone Call is a FOLLOW-UP / REMINDER, never an Appointment:
 *   - its canonical record is the lead's follow-up (leads.follow_up_*,
 *     follow_up_type = 'Phone Call');
 *   - it MAY have calendar VISIBILITY: one non-blocking ("free") reminder event
 *     on Google Calendar per lead (lib/booking/followUpReminders.js);
 *   - it NEVER has appointment OCCUPANCY: no appointments row, no busy_range,
 *     no 1h buffers, no Driving / Travel Time, no conflict, no 409.
 *
 * Two independent guards keep a Phone Call out of availability:
 *   1. CRM-generated Google events are classified by their own private
 *      extended properties (isNonBlockingCrmGoogleEvent) — not by Google's
 *      free/busy flag alone and never by title text;
 *   2. legacy Phone Call APPOINTMENT rows (pre-rule data, unbuffered
 *      busy_range) and the Google events they once produced are recognised by
 *      the row itself (appointmentKind) and excluded everywhere.
 * Genuine external Google events (no CRM marker) keep blocking as before.
 */
'use strict';

const { toUtcIso, DEFAULT_TZ: TZ } = require('./slotBlocking');
const { isPhoneCallAppointment } = require('./appointmentKind');

const PHONE_CALL = 'Phone Call';

// Follow-up types that get a calendar reminder event. Meeting follow-ups stay
// CRM-only (My Day / Follow-Ups) — they are never converted into appointments
// and never touch availability either way.
const CALENDAR_REMINDER_FOLLOWUP_TYPES = [PHONE_CALL];

// Private extended-property markers on CRM-generated Google events.
const EC_KIND_TRAVEL = 'travel';
const EC_KIND_FOLLOWUP_REMINDER = 'followup_reminder';
const REMINDER_DURATION_MIN = 15;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d/;

function isPhoneCallType(type) {
  return String(type || '').trim() === PHONE_CALL;
}

/** An ACTIVE, timed Phone Call follow-up (the only thing that gets a reminder event). */
function isActivePhoneCallFollowUp(lead) {
  return !!lead
    && CALENDAR_REMINDER_FOLLOWUP_TYPES.includes(String(lead.follow_up_type || '').trim())
    && lead.follow_up_status !== 'completed'
    && DATE_RE.test(String(lead.follow_up_date || ''))
    && TIME_RE.test(String(lead.follow_up_time || ''));
}

/** UTC ISO start of a follow-up (Pacific business date + HH:MM). */
function followUpStartIso(lead) {
  return toUtcIso(String(lead.follow_up_date), String(lead.follow_up_time).slice(0, 5), TZ);
}

/**
 * True for Google events the CRM created that must NEVER count as busy:
 * Phone Call follow-up reminders, Driving / Travel Time (the Site Visit's own
 * busy_range already covers it) and legacy Phone Call main events that were
 * tagged when synced. Decided from our private marker, not Google's
 * transparency and not the title.
 */
function isNonBlockingCrmGoogleEvent(event) {
  const p = (event && event.extendedProperties && event.extendedProperties.private) || {};
  if (p.ec_kind === EC_KIND_TRAVEL) return true;
  if (p.ec_kind === EC_KIND_FOLLOWUP_REMINDER) return true;
  if (p.ec_appointment_kind === 'phone_call') return true;
  if (p.ec_blocking === 'false') return true;
  return false;
}

module.exports = {
  PHONE_CALL, TZ, CALENDAR_REMINDER_FOLLOWUP_TYPES, EC_KIND_TRAVEL, EC_KIND_FOLLOWUP_REMINDER, REMINDER_DURATION_MIN,
  isPhoneCallType, isActivePhoneCallFollowUp, followUpStartIso, isNonBlockingCrmGoogleEvent, isPhoneCallAppointment,
};
