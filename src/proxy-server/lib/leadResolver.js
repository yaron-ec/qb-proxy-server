/* eslint-disable no-undef */
/**
 * leadResolver — shared safe identifier resolution for Railway leads.
 *
 * PostgreSQL throws "invalid input syntax for type uuid" if a non-UUID string
 * is compared against a uuid column. The naive `WHERE external_ref = $1 OR
 * id = $1` pattern breaks when $1 is a legacy non-UUID external_ref.
 *
 * This module provides TWO helpers:
 *
 *   leadIdWhere(identifier, alias?)  → { whereSql, params }
 *     Builds a WHERE clause that only compares against `id` when the
 *     identifier is a valid UUID, and always compares against external_ref.
 *     Use this when you need to splice the clause into a larger query.
 *
 *   resolveLeadByIdentifier(identifier)  → leadRow | null
 *     Resolves a single lead row by external_ref OR Railway UUID.
 *     Returns the full row with owner join. Use this when you need the
 *     canonical Railway UUID for downstream operations (activities, QB, etc.)
 *
 * Canonical identity: Railway UUID (leads.id).
 * Legacy external_ref: compatibility lookup only.
 */
'use strict';

const { query } = require('../db/client');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build a safe WHERE clause for lead identifier resolution.
 *
 * @param {string} identifier - external_ref (legacy) or Railway UUID
 * @param {string} alias - optional table alias with trailing dot (e.g. 'l.')
 * @returns {{ whereSql: string, params: string[] }}
 */
function leadIdWhere(identifier, alias) {
  const col = alias || '';
  if (UUID_RE.test(String(identifier))) {
    // Use SEPARATE parameters: $1 (text) for external_ref, $2::uuid for id.
    // Sharing $1 causes PostgreSQL to infer one type for both comparisons,
    // making the other fail with "operator does not exist: text = uuid"
    // or "operator does not exist: uuid = text".
    return { whereSql: `${col}external_ref = $1 OR ${col}id = $2::uuid`, params: [identifier, identifier] };
  }
  return { whereSql: `${col}external_ref = $1`, params: [identifier] };
}

/**
 * Resolve a single lead row by external_ref OR Railway UUID.
 * Returns the full row with owner join (display_name, email), or null.
 *
 * @param {string} identifier - external_ref (legacy) or Railway UUID
 * @returns {Promise<object|null>}
 */
async function resolveLeadByIdentifier(identifier) {
  const { whereSql, params } = leadIdWhere(identifier, 'l.');
  const { rows } = await query(
    `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
     FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
     WHERE ${whereSql} LIMIT 1`,
    params
  );
  return rows[0] || null;
}

module.exports = { UUID_RE, leadIdWhere, resolveLeadByIdentifier };