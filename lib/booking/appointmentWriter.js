'use strict';
const APPOINTMENT_LOCK_NAMESPACE = 1001;
async function acquireOwnerLockAndCheckConflict(client, ownerId, busyStart, busyEnd, excludeAppointmentId, adminOverride) {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [APPOINTMENT_LOCK_NAMESPACE, ownerId]);
  const { rows } = await client.query(
    "SELECT id, override_authorized, override_authorized_by FROM appointments " +
    "WHERE owner_id = $1 " +
    "  AND status IN ('scheduled', 'confirmed') " +
    "  AND ($2::uuid IS NULL OR id != $2::uuid) " +
    "  AND busy_range && tstzrange($3, $4, '[)')",
    [ownerId, excludeAppointmentId || null, busyStart.toISOString(), busyEnd.toISOString()]
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
