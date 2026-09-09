'use strict';

/**
 * Shared appointment conflict detection — ONE database-serialized write path.
 *
 * acquireOwnerLockAndCheckConflict MUST be called inside a BEGIN'd transaction.
 * It acquires a PostgreSQL transaction-scoped advisory lock for the owner
 * schedule, then queries for conflicting active appointments.
 *
 * Invariants:
 * - Normal vs Normal overlap: impossible (lock serializes, then conflict check)
 * - Normal vs existing Override: impossible (override still blocks)
 * - Authorized Admin Override: allowed (adminOverride=true bypasses rejection)
 * - Non-admin forged override: rejected (adminOverride is server-validated)
 * - Editing excludes only the exact appointment by canonical ID
 *
 * The advisory lock key is derived from the owner UUID via hashtext().
 * Collisions cause contention, not correctness issues (the conflict check
 * inside the transaction is the real protection).
 *
 * The conflict query sees BOTH normal AND overridden appointments —
 * overridden appointments still block future normal bookings.
 */

const APPOINTMENT_LOCK_NAMESPACE = 1001;

async function acquireOwnerLockAndCheckConflict(client, ownerId, busyStart, busyEnd, excludeAppointmentId, adminOverride) {
  // 1. Serialize all competing writes for this owner's schedule.
  //    Transaction-scoped: automatically released on COMMIT/ROLLBACK.
  await client.query(
    'SELECT pg_advisory_xact_lock($1, hashtext($2::text))',
    [APPOINTMENT_LOCK_NAMESPACE, ownerId]
  );

  // 2. Query for conflicting active appointments (BOTH normal AND overridden).
  //    Overridden appointments are NOT exempt — they still block normal bookings.
  const { rows } = await client.query(
    'SELECT id, override_authorized, override_authorized_by FROM appointments ' +
    'WHERE owner_id = $1 ' +
    '  AND status IN ('scheduled', 'confirmed') ' +
    '  AND ($2::uuid IS NULL OR id != $2::uuid) ' +
    '  AND busy_range && tstzrange($3, $4, '[')',
    [ownerId, excludeAppointmentId || null, busyStart.toISOString(), busyEnd.toISOString()]
  );

  // 3. Reject if conflict and not authorized override.
  //    adminOverride is server-validated by the caller (req.user.role === 'admin').
  if (rows.length > 0 && !adminOverride) {
    const err = new Error('This time conflicts with another appointment. Please choose a different time.');
    err.code = 'SLOT_CONFLICT';
    err.conflicts = rows;
    throw err;
  }

  return { conflicts: rows };
}

module.exports = { acquireOwnerLockAndCheckConflict, APPOINTMENT_LOCK_NAMESPACE };
