/* eslint-disable no-undef */
/**
 * currentAction — the ONE canonical "what is this lead's current next
 * action" selector (PERMANENT RULE, post-Muhammad-Khan/Jamey-Corey
 * production defect; corrects an earlier, incorrect "Appointment OR Meeting
 * Follow-Up, additive" model that briefly shipped in the same fix).
 *
 * AUTHORITATIVE CURRENT-ACTION RULE: the Follow-Up / Next Update
 * (leads.follow_up_*) is the authoritative CURRENT NEXT ACTION for a lead.
 * A real Appointment record is NEVER deleted and keeps its own independent
 * calendar/availability presence (lib/booking/appointmentView.js,
 * lib/booking/calendarOutbox.js — both completely unaffected by this
 * module) — it simply is not ALSO surfaced as "current work" (Dashboard,
 * My Day, routing, map, counts) on any day where the lead has an ACTIVE
 * MEETING-TYPE Follow-Up dated that SAME day.
 *
 * Production evidence proved exact-time "mirror" detection (the PR #8
 * Dashboard dedup, lib/booking/followUpMeeting.js's own calendar-sync
 * mirror check) is NOT sufficient on its own:
 *   - Muhammad Khan: Appointment 9:00 AM + active Meeting Follow-Up
 *     10:00 AM (same day, DIFFERENT time) — not an exact mirror, yet the
 *     Follow-Up is still the one real current obligation. Correct result:
 *     ONLY the 10:00 AM Follow-Up.
 *   - Jamey Corey: historical Appointment Sep 29 + active Meeting
 *     Follow-Up Oct 1 (different days) — the Follow-Up is current work on
 *     Oct 1; the Sep 29 Appointment is historical and never resurfaces as
 *     Oct 1 work (trivially true once supersession is evaluated PER DAY).
 *   - Mario Ibanez: a current Appointment with NO superseding active
 *     Follow-Up — the Appointment remains the current action.
 *
 * SCOPE: supersession applies only between a Meeting-type Follow-Up and an
 * Appointment, both dated the SAME day — they represent "the one physical
 * meeting for this lead that day," so showing both would be a stale
 * duplicate. A Follow-Up of any OTHER type (Phone Call/Text/Email/Other)
 * NEVER supersedes an Appointment: per CLAUDE.md, "Appointment and
 * Follow-Up remain independent CRM records" — a phone-call reminder and a
 * real site visit on the same day are two genuinely different obligations,
 * not two recordings of the same event. This is deliberately NOT an
 * additive "all Appointments + all Meeting Follow-Ups" model — see
 * isAppointmentSupersededForDay() below, which is the one predicate every
 * consumer (routes/routing.js, and the equivalent logic mirrored in
 * crm-frontend/src/pages/MobileDayView.jsx and
 * crm-frontend/src/components/FollowUpsWidget.jsx — keep all three in
 * sync) must apply before treating an Appointment as current work for a
 * given day.
 *
 * This module never deletes, cancels, or mutates any Appointment or
 * Follow-Up record — it is pure selection/display/routing logic only.
 */
'use strict';

const { isActiveFollowUpReminder } = require('./phoneCallModel');

/** A real, physical (non-Phone-Call) Appointment is set on this lead. */
function hasActiveAppointment(lead) {
  return !!(lead && lead.appointment_date && String(lead.appointment_type || '').trim() !== 'Phone Call');
}

/**
 * True when `lead`'s Appointment is superseded, for the specific calendar
 * day `day` (a `YYYY-MM-DD` string), by an active Meeting-type Follow-Up
 * dated that SAME day. An Appointment dated a day other than `day`, or
 * superseded only by a non-Meeting or inactive/completed Follow-Up, is
 * never superseded.
 */
function isAppointmentSupersededForDay(lead, day) {
  return !!(
    hasActiveAppointment(lead)
    && lead.appointment_date === day
    && isActiveFollowUpReminder(lead)
    && String(lead.follow_up_type || '').trim() === 'Meeting'
    && lead.follow_up_date === day
  );
}

/**
 * The lead's authoritative current PHYSICAL MEETING for the specific
 * calendar day `day` (`YYYY-MM-DD`), or null if none applies to that day.
 * This is NOT a generic "pick one of Appointment/Follow-Up" merge: a
 * non-Meeting Follow-Up (Phone Call/Text/Email/Other) never supersedes an
 * Appointment (see module doc), so when one is active for `day` alongside
 * an Appointment also dated `day`, BOTH remain real, independent
 * obligations — callers that need "every work item for this lead today"
 * (e.g. Dashboard's Today's Work) must bucket the Follow-Up and the
 * Appointment separately, suppressing only the Appointment side via
 * isAppointmentSupersededForDay(). This function is for the narrower,
 * ROUTING/MAP/CALENDAR sense: "what is the one physical meeting to drive
 * to/block for/put on the map for this lead on this day" — which an active
 * Meeting Follow-Up answers whenever it supersedes the Appointment, and the
 * Appointment answers otherwise.
 */
function currentPhysicalMeetingForDay(lead, day) {
  if (isActiveFollowUpReminder(lead) && String(lead.follow_up_type || '').trim() === 'Meeting' && lead.follow_up_date === day) {
    return { source: 'follow_up', date: lead.follow_up_date, time: lead.follow_up_time, type: lead.follow_up_type };
  }
  if (hasActiveAppointment(lead) && lead.appointment_date === day && !isAppointmentSupersededForDay(lead, day)) {
    return { source: 'appointment', date: lead.appointment_date, time: lead.appointment_time, type: lead.appointment_type };
  }
  return null;
}

module.exports = { currentPhysicalMeetingForDay, isAppointmentSupersededForDay, hasActiveAppointment };
