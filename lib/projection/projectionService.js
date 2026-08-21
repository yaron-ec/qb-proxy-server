/* eslint-disable no-undef */
/**
 * projectionService — the ONLY module that owns Base44 projection internals.
 *
 * Booking / lead services express business intent:
 *   projectionService.recordLeadAggregateChange(client, leadId, reason)
 *
 * This module alone is responsible for:
 *   - the origin gate (only 'railway'-native leads are projected)
 *   - incrementing leads.projection_revision
 *   - allocating the exact new revision
 *   - generating the deterministic idempotency key
 *   - inserting the projection_outbox row
 *
 * It hides all projection implementation details (revision allocation, key
 * format, outbox schema, insert logic) from callers. If the projection
 * mechanism is ever replaced, only this module + projectionOutbox.js change;
 * bookingService is untouched.
 *
 * Contract: runs INSIDE the caller's transaction on the caller's `client`.
 * A rollback rolls back the revision increment AND the outbox insert together.
 * No double increment: this is the ONLY place projection_revision is touched.
 */
'use strict';

const ORIGIN_RAILWAY = 'railway';

/**
 * Record one Base44-visible Lead aggregate change.
 *
 * @param {object} client - a pg transaction client (from pool.connect() + BEGIN)
 * @param {string} leadId - Railway leads.id (UUID)
 * @param {string} reason - audit reason ('lead_created','appointment_rescheduled',
 *                         'owner_changed','appointment_cancelled', ...)
 * @returns {Promise<{skipped:boolean, reason?:string, revision?:number, idempotencyKey?:string}>}
 */
async function recordLeadAggregateChange(client, leadId, reason) {
  // Origin gate: only Railway-native leads are projected. Base44-origin leads
  // are left untouched (zero silent data loss for population A).
  const originRes = await client.query(
    'SELECT origin_system FROM leads WHERE id = $1',
    [leadId]
  );
  const origin = originRes.rows[0] && originRes.rows[0].origin_system;
  if (origin !== ORIGIN_RAILWAY) {
    return { skipped: true, reason: `origin_not_railway (${origin || 'missing'})` };
  }

  // 1. increment projection_revision (the ONLY increment site — no trigger)
  await client.query(
    'UPDATE leads SET projection_revision = projection_revision + 1 WHERE id = $1',
    [leadId]
  );

  // 2. read the exact new revision
  const revRes = await client.query(
    'SELECT projection_revision FROM leads WHERE id = $1',
    [leadId]
  );
  const revision = revRes.rows[0].projection_revision;

  // 3. deterministic idempotency key (owned here, not by callers)
  const idempotencyKey = `proj:lead:${leadId}:v${revision}`;

  // 4. insert outbox row (ON CONFLICT dedups a duplicate enqueue in the same tx)
  await client.query(
    `INSERT INTO projection_outbox (lead_id, revision, action, idempotency_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [leadId, revision, reason, idempotencyKey]
  );

  return { skipped: false, revision, idempotencyKey };
}

const ACTIVE_STATUSES = new Set(['scheduled', 'confirmed']);

/**
 * Pure visibility rule for updateAppointment changes. Returns true iff the
 * change affects a Base44-projected field:
 *   - owner change        -> assigned_rep is projected
 *   - status transition crossing the active boundary (active = scheduled/
 *     confirmed) -> the active-appointment set changes
 * appointment_type and duration changes are NOT projected to Base44 and return
 * false (no revision allocated). bookingService calls this to decide whether
 * to record a change; projectionService owns the visibility rule.
 *
 * @param {object} changes - bookingService `changes` object (may be empty)
 * @param {string} oldStatus - appointment status before the update
 * @returns {boolean}
 */
function isBase44VisibleUpdateChange(changes, oldStatus) {
  if (!changes || typeof changes !== 'object') return false;
  if (changes.owner) return true;
  if (changes.status) {
    const newStatus = changes.status.new;
    if (ACTIVE_STATUSES.has(oldStatus) !== ACTIVE_STATUSES.has(newStatus)) return true;
  }
  return false;
}

module.exports = { recordLeadAggregateChange, isBase44VisibleUpdateChange, ORIGIN_RAILWAY };