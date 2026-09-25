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
 */
const APPOINTMENT_LOCK_NAMESPACE = 1001;
async function acquireOwnerLockAndCheckConflict(client, ownerId, candidateStart, candidateEnd, excludeAppointmentId, adminOverride) {
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
  return { conflicts: rows };
}
module.exports = { acquireOwnerLockAndCheckConflict, APPOINTMENT_LOCK_NAMESPACE };
