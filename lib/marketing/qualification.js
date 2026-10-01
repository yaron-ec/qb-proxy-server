/* eslint-disable no-undef */
/**
 * qualification — "Qualified Lead" as a versioned MARKETING attribute,
 * deliberately separate from the operational lead status (there is no
 * "Qualified" status and none is created).
 *
 * Definition v1 (business decision, 2026-10): a lead may become Qualified
 * when it is a legitimate, non-spam, non-duplicate inquiry with ALL of
 *   usable_contact       usable contact information
 *   service_offered      a project/service the company actually provides
 *   in_service_area      geography within the service area
 *   not_dnq              not DNQ for a legitimate business reason
 * plus not_spam / not_duplicate.
 *
 * Each decision is an append-only lead_qualification_events row carrying
 * the definition version and the criteria as evaluated, so the definition
 * can evolve (v2, v3 …) without rewriting history. Decisions are recorded
 * explicitly (decision_source 'manual', or 'rule' for a future automated
 * evaluator); NOTHING is inferred for historical leads.
 */
'use strict';

const QUALIFICATION_DEFINITIONS = Object.freeze({
  v1: Object.freeze(['usable_contact', 'service_offered', 'in_service_area', 'not_dnq', 'not_spam', 'not_duplicate']),
});
const CURRENT_DEFINITION = 'v1';

/**
 * Validate a decision. Every criterion of the definition must be an explicit
 * boolean; the outcome is derived (all true → qualified), never supplied.
 * Returns { ok, outcome, criteria } or { ok: false, errors }.
 */
function evaluateQualification(criteria, version = CURRENT_DEFINITION) {
  const keys = QUALIFICATION_DEFINITIONS[version];
  if (!keys) return { ok: false, errors: [`unknown definition_version ${version}`] };
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return { ok: false, errors: ['criteria must be an object'] };
  const errors = [];
  const out = {};
  for (const k of keys) {
    if (typeof criteria[k] !== 'boolean') errors.push(`criteria.${k} must be true or false`);
    else out[k] = criteria[k];
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, outcome: keys.every((k) => out[k]) ? 'qualified' : 'not_qualified', criteria: out, definition_version: version };
}

async function recordQualification(db, { leadId, criteria, version = CURRENT_DEFINITION, decidedBy, notes, idempotencyKey, source = 'manual' }) {
  const ev = evaluateQualification(criteria, version);
  if (!ev.ok) { const e = new Error(ev.errors.join('; ')); e.status = 400; e.details = ev.errors; throw e; }
  const r = await db.query(
    `INSERT INTO lead_qualification_events (lead_id, outcome, definition_version, criteria, decided_by, decision_source, notes, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [leadId, ev.outcome, ev.definition_version, JSON.stringify(ev.criteria), decidedBy || null, source,
      notes ? String(notes).slice(0, 2000) : null, idempotencyKey || null]);
  if (r.rows[0]) return { event: r.rows[0], duplicate: false };
  const prev = await db.query('SELECT * FROM lead_qualification_events WHERE idempotency_key = $1', [idempotencyKey]);
  return { event: prev.rows[0], duplicate: true };
}

module.exports = { QUALIFICATION_DEFINITIONS, CURRENT_DEFINITION, evaluateQualification, recordQualification };
