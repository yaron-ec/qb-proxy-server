'use strict';
/**
 * acquireOwnerLockAndCheckConflict — the write-side half of the single-buffer
 * rule. `appointments.busy_range` is already stored buffered ([start-1h,
 * end+1h] for Meetings; [start,end] for Phone Calls — see bookingService's
 * busyWindow()). To match lib/booking/slotBlocking.js#computeBlockedSlots
 * (the availability DISPLAY's rule) exactly, the CANDIDATE window passed here
 * MUST be the appointment's ACTUAL, UNBUFFERED meeting window [start, end] —
 * never re-buffered. Passing an already-buffered candidate window double-
 * buffers the check (comparing a buffered range against an already-buffered
 * busy_range), which rejects slots the availability display correctly shows
 * as free (e.g. a slot starting exactly 1 hour after an existing meeting).
 *
 * PHONE CALLS NEVER BLOCK: a Phone Call is a reminder/activity, never an
 * Appointment/Site Visit — it must never conflict-block a real booking, and a
 * real Appointment may freely overlap one. `lower(busy_range) < start_at` is
 * the canonical kind distinction (lib/booking/appointmentKind.js): a
 * Meeting's busy_range always starts exactly 1h before start_at; a Phone
 * Call's starts exactly AT start_at (no buffer). Excluding non-strictly-less
 * rows excludes Phone Calls from ever being treated as a conflict.
 *
 * PERMANENT RULE (post-Jamey-Corey production defect): an ACTIVE Meeting
 * Follow-Up now occupies the SAME physical-meeting availability as a real
 * Appointment (lib/booking/availabilityService.js blocks it on the display
 * side) — so this write-path check must enforce it too, or the availability
 * grid and actual booking enforcement would disagree (a slot shown blocked
 * that still silently books). `excludeLeadId` excludes the lead's OWN
 * Meeting follow-up: converting/mirroring it into this exact appointment is
 * the expected flow (see lib/booking/followUpReminders.js's mirror-dedup),
 * never a conflict with itself.
 */
const APPOINTMENT_LOCK_NAMESPACE = 1001;
async function acquireOwnerLockAndCheckConflict(client, ownerId, candidateStart, candidateEnd, excludeAppointmentId, adminOverride, excludeLeadId) {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [APPOINTMENT_LOCK_NAMESPACE, ownerId]);
  const { rows } = await client.query(
    "SELECT id, override_authorized, override_authorized_by FROM appointments " +
    "WHERE owner_id = $1 " +
    "  AND status IN ('scheduled', 'confirmed') " +
    "  AND ($2::uuid IS NULL OR id != $2::uuid) " +
    "  AND lower(busy_range) < start_at " +
    "  AND busy_range && tstzrange($3, $4, '[)')",
    [ownerId, excludeAppointmentId || null, candidateStart.toISOString(), candidateEnd.toISOString()]
  );
  if (rows.length > 0 && !adminOverride) {
    const err = new Error('This time conflicts with another appointment. Please choose a different time.');
    err.code = 'SLOT_CONFLICT';
    err.conflicts = rows;
    throw err;
  }

  const followUpMeeting = require('./followUpMeeting');
  const { rows: fuRows } = await client.query(
    `SELECT l.id, l.follow_up_date, l.follow_up_time, l.follow_up_type, l.follow_up_status
       FROM leads l
      WHERE l.owner_id = $1
        AND l.follow_up_type = 'Meeting'
        AND l.follow_up_status IS DISTINCT FROM 'completed'
        AND ($2::uuid IS NULL OR l.id != $2::uuid)`,
    [ownerId, excludeLeadId || null]
  );
  if (fuRows.length) {
    const bufferMinutes = await require('./bookingService').getTravelBufferMinutes();
    const tz = await require('../companyConfig').getTimezone();
    const conflictingFollowUps = fuRows.filter((l) => {
      if (!followUpMeeting.isActiveMeetingFollowUp(l)) return false;
      const { busyStart, busyEnd } = followUpMeeting.meetingBusyWindow(l, tz, bufferMinutes);
      return busyStart < candidateEnd && busyEnd > candidateStart;
    });
    if (conflictingFollowUps.length && !adminOverride) {
      const err = new Error('This time conflicts with an active Meeting follow-up. Please choose a different time.');
      err.code = 'SLOT_CONFLICT';
      err.conflicts = conflictingFollowUps.map((l) => ({ id: l.id, follow_up_meeting: true }));
      throw err;
    }
  }

  return { conflicts: rows };
}
module.exports = { acquireOwnerLockAndCheckConflict, APPOINTMENT_LOCK_NAMESPACE };
