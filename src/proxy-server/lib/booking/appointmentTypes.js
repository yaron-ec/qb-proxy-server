/* eslint-disable no-undef */
/**
 * appointmentTypes — list active types, validate + resolve duration.
 *
 * Duration resolution:
 *   - duration_override_minutes supplied → must pass validateDurationOverride
 *     (positive integer, 1..MAX). Used verbatim; never silently substituted.
 *   - null/undefined → appointment_types.default_duration_minutes.
 *
 * appointment_types.default_duration_minutes is CHECK-constrained at the DB
 * level (0 < d <= MAX_DURATION_MINUTES) so invalid defaults cannot be stored.
 */
'use strict';

const { query } = require('../../db/client');

const MAX_DURATION_MINUTES = 480; // 8-hour upper bound

async function getType(id) {
  const r = await query('SELECT * FROM appointment_types WHERE id = $1 AND is_active = true', [id]);
  return r.rows[0] || null;
}

async function listTypes() {
  const r = await query('SELECT * FROM appointment_types WHERE is_active = true ORDER BY name');
  return r.rows;
}

// Throws a 400 invalid_duration error for any invalid override. No silent fallback.
function validateDurationOverride(override) {
  if (override == null || override === undefined) return; // null/undefined → use type default
  const n = Number(override);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DURATION_MINUTES) {
    const e = new Error(`duration_override_minutes must be a positive integer between 1 and ${MAX_DURATION_MINUTES}`);
    e.code = 'invalid_duration';
    e.status = 400;
    throw e;
  }
}

// Caller MUST call validateDurationOverride first when override comes from user input.
function resolveDuration(type, override) {
  if (override != null) return Number(override);
  return type ? type.default_duration_minutes : 60;
}

module.exports = { getType, listTypes, resolveDuration, validateDurationOverride, MAX_DURATION_MINUTES };