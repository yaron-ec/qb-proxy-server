/* eslint-disable no-undef */
'use strict';

/**
 * currentActionCases — the ONE canonical truth table for the FINAL
 * AUTHORITATIVE CURRENT-ACTION RULE (post-Muhammad-Khan/Jamey-Corey/
 * Mario-Ibanez production correction): current work is derived ENTIRELY
 * from the Follow-Up / Next Update. Appointment Date/Time is
 * historical/reference data only and is NEVER a fallback source of current
 * work, even when no Follow-Up exists.
 *
 * DRIFT PROTECTION: this file has no logic of its own — it is pure data.
 * It is imported and run against THREE independent implementations that
 * must never silently diverge:
 *   - lib/booking/currentAction.js#isCurrentWorkForDay /
 *     #currentActionForDay (backend, canonical) — see
 *     test/currentAction.test.js
 *   - crm-frontend/src/pages/MobileDayView.jsx#isCurrentPhysicalMeetingForDay
 *     (frontend mirror #1) — see
 *     crm-frontend/src/pages/MobileDayView.currentActionParity.test.jsx
 *   - crm-frontend/src/components/FollowUpsWidget.jsx (frontend mirror #2,
 *     which only ever bucket from the Follow-Up — there is no Appointment
 *     predicate left to test there; see
 *     crm-frontend/src/components/FollowUpsWidget.currentActionParity.test.jsx)
 *
 * Each case's `day` is the day being viewed. `expected` describes the
 * lead's current work for that day:
 *   - `isCurrent`: is there ANY current work for this lead on this day?
 *   - `type`: the Follow-Up type driving it (null if !isCurrent) — this is
 *     ALWAYS a follow_up_type; the Appointment's own `appointment_type` is
 *     never the answer, by design.
 *   - `isPhysicalMeeting`: true only when isCurrent AND type === 'Meeting'.
 *
 * Covers required cases 1-9 from the FINAL rule (cases 10-11 — the actual
 * calendar/travel/availability CONSEQUENCES of the Meeting vs non-Meeting
 * distinction this fixture proves — are covered by
 * test/followUpMeeting.test.js, test/integration/meetingFollowUp.int.test.js
 * and test/integration/currentActionRouting.int.test.js, not duplicated
 * here).
 */
module.exports = [
  {
    name: '1. Appointment today + Meeting Follow-Up today — only Follow-Up is current',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Meeting', isPhysicalMeeting: true },
  },
  {
    name: '2. Appointment today + Meeting Follow-Up today at the EXACT SAME TIME — still only Follow-Up is current (no mirror check involved)',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '10:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Meeting', isPhysicalMeeting: true },
  },
  {
    name: '3. Appointment today + Phone Call Follow-Up today — Phone Call is current; Appointment is not current',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Phone Call', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Phone Call', isPhysicalMeeting: false },
  },
  {
    name: '4. Appointment today + Text Follow-Up today — Text is current; Appointment is not current',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Text', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Text', isPhysicalMeeting: false },
  },
  {
    name: '5. Appointment today + Email Follow-Up today — Email is current; Appointment is not current',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Email', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Email', isPhysicalMeeting: false },
  },
  {
    name: '6. Appointment today + Other Follow-Up today — Other is current; Appointment is not current',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Other', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Other', isPhysicalMeeting: false },
  },
  {
    name: '7. Appointment today + NO active Follow-Up — Appointment does NOT become current work (no fallback)',
    lead: { appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting' },
    day: '2026-10-01',
    expected: { isCurrent: false, type: null, isPhysicalMeeting: false },
  },
  {
    name: '7b. Appointment today + a COMPLETED Meeting Follow-Up today — inactive Follow-Up, Appointment still does NOT become current',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'completed',
    },
    day: '2026-10-01',
    expected: { isCurrent: false, type: null, isPhysicalMeeting: false },
  },
  {
    name: '8. Historical Appointment (earlier day) + today\'s Meeting Follow-Up — today shows the Follow-Up only',
    lead: {
      appointment_date: '2026-09-29', appointment_time: '18:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Meeting', isPhysicalMeeting: true },
  },
  {
    name: '9a. Future Appointment + current (different-day) Follow-Up — the CURRENT day (the Follow-Up\'s own day) is driven by the Follow-Up',
    lead: {
      appointment_date: '2026-10-05', appointment_time: '11:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    expected: { isCurrent: true, type: 'Meeting', isPhysicalMeeting: true },
  },
  {
    name: '9b. Future Appointment + current (different-day) Follow-Up — the Appointment\'s OWN day has NO current work (no fallback, even though the Appointment record is preserved/unaltered)',
    lead: {
      appointment_date: '2026-10-05', appointment_time: '11:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-10-05',
    expected: { isCurrent: false, type: null, isPhysicalMeeting: false },
  },
];
