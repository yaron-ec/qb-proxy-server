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
 */
const APPOINTMENT_LOCK_NAMESPACE = 1001;
async function acquireOwnerLockAndCheckConflict(client, ownerId, candidateStart, candidateEnd, excludeAppointmentId, adminOverride) {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [APPOINTMENT_LOCK_NAMESPACE, ownerId]);
  const { rows } = await client.query(
    "SELECT id, override_authorized, override_authorized_by FROM appointments " +
    "WHERE owner_id = $1 " +
    "  AND status IN ('scheduled', 'confirmed') " +
    "  AND ($2::uuid IS NULL OR id != $2::uuid) " +
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
