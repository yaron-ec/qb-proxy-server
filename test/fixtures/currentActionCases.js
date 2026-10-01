/* eslint-disable no-undef */
'use strict';

/**
 * currentActionCases — the ONE canonical truth table for the AUTHORITATIVE
 * CURRENT-ACTION RULE (PERMANENT RULE, post-Muhammad-Khan/Jamey-Corey
 * production defect).
 *
 * DRIFT PROTECTION: this file has no logic of its own — it is pure data.
 * It is imported and run against THREE independent implementations that
 * must never silently diverge:
 *   - lib/booking/currentAction.js#isAppointmentSupersededForDay (backend,
 *     canonical) — see test/currentAction.test.js
 *   - crm-frontend/src/pages/MobileDayView.jsx#isAppointmentSupersededForDay
 *     (frontend mirror #1) — see
 *     crm-frontend/src/pages/MobileDayView.currentActionParity.test.jsx
 *   - crm-frontend/src/components/FollowUpsWidget.jsx#isAppointmentSupersededByFollowUp
 *     (frontend mirror #2) — see
 *     crm-frontend/src/components/FollowUpsWidget.currentActionParity.test.jsx
 *
 * Each case's `day` is always the Appointment's own date — every consumer
 * answers the same question, "is THIS lead's Appointment, on its own date,
 * superseded by an active Meeting Follow-Up dated that same day" — so a
 * single-argument predicate (FollowUpsWidget's, which has no separate `day`
 * parameter) and a two-argument one (the backend's and MobileDayView's) are
 * both exercised correctly against the same fixture.
 *
 * Adding a new case here extends regression coverage in all three
 * implementations at once, without touching any of their separate source
 * files — if one implementation's logic is ever changed inconsistently
 * with a case's expected `superseded` value, THAT implementation's own
 * test fails immediately.
 */
module.exports = [
  {
    name: 'A. Muhammad Khan: same-day Appointment 9:00 + active Meeting Follow-Up 10:00 (different times) — Appointment superseded',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    superseded: true,
  },
  {
    name: 'B. Jamey Corey: Appointment on its own (earlier) day + Meeting Follow-Up dated a LATER day — the Appointment\'s own day is unaffected, NOT superseded',
    lead: {
      appointment_date: '2026-09-29', appointment_time: '18:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-09-29',
    superseded: false,
  },
  {
    name: 'C. Mario Ibanez: same-day Appointment, no Meeting Follow-Up at all — Appointment remains',
    lead: { appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting' },
    day: '2026-10-01',
    superseded: false,
  },
  {
    name: 'D1. same-day Appointment + Phone Call Follow-Up — never supersedes (non-Meeting type)',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Phone Call', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    superseded: false,
  },
  {
    name: 'D2. same-day Appointment + Text Follow-Up — never supersedes (non-Meeting type)',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Text', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    superseded: false,
  },
  {
    name: 'D3. same-day Appointment + Email Follow-Up — never supersedes (non-Meeting type)',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Email', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    superseded: false,
  },
  {
    name: 'D4. same-day Appointment + Other Follow-Up — never supersedes (non-Meeting type)',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '14:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '09:00', follow_up_type: 'Other', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    superseded: false,
  },
  {
    name: 'E. same-day Appointment + a COMPLETED Meeting Follow-Up — inactive, must not supersede',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '09:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'completed',
    },
    day: '2026-10-01',
    superseded: false,
  },
  {
    name: 'F. exact Appointment/Meeting Follow-Up mirror (same date AND time) — one current representation (the Follow-Up side; Appointment superseded)',
    lead: {
      appointment_date: '2026-10-01', appointment_time: '16:00', appointment_type: 'Meeting',
      follow_up_date: '2026-10-01', follow_up_time: '16:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
    },
    day: '2026-10-01',
    superseded: true,
  },
];
