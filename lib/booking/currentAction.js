/* eslint-disable no-undef */
/**
 * currentAction — the ONE canonical "what is this lead's current work"
 * selector (FINAL PERMANENT RULE, post-Muhammad-Khan/Jamey-Corey/
 * Mario-Ibanez production correction — replaces an earlier "Follow-Up
 * supersedes a same-day Appointment" model, which was itself a correction
 * of an even earlier, incorrect additive model. Both prior models are
 * superseded by this one.)
 *
 * FINAL CANONICAL BUSINESS RULE: the Follow-Up / Next Update
 * (leads.follow_up_*) is the ONLY source of CURRENT WORK for a lead.
 * Appointment Date/Time (leads.appointment_*, backed by the `appointments`
 * table) is historical/reference tracking data ONLY — it exists so EC can
 * see what was originally booked, but it NEVER independently determines:
 *   - Dashboard "Today's Work"
 *   - My Day (list or map)
 *   - Daily Map / route stops
 *   - current-work counts
 *   - current-action calendar/travel/availability scheduling
 *
 * There is NO Appointment fallback: if a lead has no active Follow-Up for a
 * given day, that lead has NO current work for that day — even if it has a
 * real Appointment dated that exact day. This holds even for an EXACT same-
 * day/same-time Appointment+Follow-Up pair: the Follow-Up wins because it
 * is authoritative, not because of any "mirror" or "supersession" check
 * against the Appointment. (Mario Ibanez: his current work is whatever his
 * own Follow-Up / Next Update says — if he has none, he has no current
 * work, Appointment or not.)
 *
 * This module never deletes, cancels, or mutates any Appointment or
 * Follow-Up record. It also does NOT touch the Appointment's own,
 * independent, already-working booking/calendar/travel/availability
 * pipeline (lib/booking/bookingService.js, appointmentWriter.js,
 * calendarOutbox.js, availabilityService.js's appointments-table busy
 * source) — booking a real Appointment through the existing Appointment
 * editor still syncs its own Google Calendar main/travel events and blocks
 * availability exactly as before; that is a separate, deliberately
 * untouched concern from CURRENT-WORK SELECTION, which is what this module
 * governs.
 *
 * FOLLOW-UP TYPE DETERMINES BEHAVIOR for current work:
 *   - MEETING: a real physical meeting — 1-hour duration, canonical travel
 *     handling, blocks availability, syncs to Google Calendar, participates
 *     in My Day / Map / route (see lib/booking/followUpMeeting.js, which
 *     reuses calendarOutbox.js#buildOperation, never a second
 *     implementation).
 *   - PHONE CALL / TEXT / EMAIL: the current non-physical action — no route
 *     stop, no travel, no availability block.
 *   - OTHER: the current follow-up action — not automatically a physical
 *     meeting; no physical routing/travel unless a future rule defines one.
 *
 * isCurrentWorkForDay()/currentActionForDay() are the two predicates every
 * consumer (routes/routing.js, and the equivalent logic mirrored in
 * crm-frontend/src/pages/MobileDayView.jsx and
 * crm-frontend/src/components/FollowUpsWidget.jsx — keep all three in
 * sync, and see test/fixtures/currentActionCases.js for the shared
 * cross-layer drift-protection fixture) must use instead of reading
 * `appointment_date`/`appointment_type` for any current-work purpose.
 */
'use strict';

const { isActiveFollowUpReminder } = require('./phoneCallModel');

/**
 * True when `lead` has an ACTIVE Follow-Up / Next Update dated exactly
 * `day` (a `YYYY-MM-DD` string) — the one and only source of current work.
 * The Appointment is never consulted.
 */
function isCurrentWorkForDay(lead, day) {
  return !!(isActiveFollowUpReminder(lead) && lead.follow_up_date === day);
}

/**
 * The lead's current-work item for `day`, or null if the lead has no
 * active Follow-Up dated `day` (an Appointment dated `day` with no active
 * Follow-Up still yields null — there is no Appointment fallback).
 */
function currentActionForDay(lead, day) {
  if (!isCurrentWorkForDay(lead, day)) return null;
  const type = String(lead.follow_up_type || '').trim();
  return {
    date: lead.follow_up_date,
    time: lead.follow_up_time,
    type: lead.follow_up_type,
    isPhysicalMeeting: type === 'Meeting',
  };
}

/** Convenience: is the lead's current work for `day` a physical meeting
 * (Follow-Up type 'Meeting')? Used by routing/map/travel consumers, which
 * only care about physical obligations. */
function isCurrentPhysicalMeetingForDay(lead, day) {
  const action = currentActionForDay(lead, day);
  return !!(action && action.isPhysicalMeeting);
}

module.exports = { isCurrentWorkForDay, currentActionForDay, isCurrentPhysicalMeetingForDay };
