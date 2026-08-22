/* eslint-disable no-undef */
/**
 * base44ProjectionClient — reconcile + write a Lead aggregate to Base44.
 *
 * Reconciliation is EXACT (by Lead.railway_lead_id), never fuzzy:
 *   - map present          -> UPDATE the known Base44 Lead (UPDATE field set)
 *   - map absent, 0 matches -> CREATE the Base44 Lead (CREATE field set)
 *   - map absent, 1 match  -> ADOPT + UPDATE (UPDATE field set; no identity overwrite)
 *   - map absent, >1 match -> FAIL safely (DuplicateError); no arbitrary write
 *
 * Depends on the existing lib/base44.js REST client (service-role). The module
 * is imported lazily so tests can inject a mock.
 */
'use strict';

const TZ = 'America/Los_Angeles';

function laParts(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const hh = m.hour === '24' ? '00' : m.hour;
  return { date: `${m.year}-${m.month}-${m.day}`, hhmm: `${hh}${m.minute}` };
}

class DuplicateRailwayLeadIdError extends Error {
  constructor(count) {
    super(`duplicate_railway_lead_id: ${count} matches`);
    this.code = 'DUPLICATE_RAILWAY_LEAD_ID';
    this.matchCount = count;
  }
}

// CREATE field set: identity + owner + appointment + railway_lead_id.
// status is omitted (rely on the Base44 entity default 'New' — verified in 3C).
// railway_appointment_id is NOT projected (not used for reconciliation, stale
// protection, or any UI) — Phase 3B scope is railway_lead_id only.
function buildCreatePayload(agg) {
  const { lead, ownerDisplayName, appointment } = agg;
  const payload = {
    first_name: lead.first_name,
    last_name: lead.last_name,
    full_name: `${lead.first_name} ${lead.last_name}`.trim(),
    email: lead.email || null,
    phone: lead.phone || null,
    property_address: lead.property_address || null,
    city: lead.city || null,
    assigned_rep: ownerDisplayName || null,
    railway_lead_id: lead.id,
  };
  if (appointment) {
    const p = laParts(appointment.start_at);
    payload.appointment_date = p.date;
    payload.appointment_time = p.hhmm;
  }
  return payload;
}

// UPDATE field set: owner (assigned_rep) + appointment (date/time) ONLY.
// Identity fields are deliberately excluded — Base44 UI edits persist.
// No Railway-only appointment identifier is projected.
function buildUpdatePayload(agg) {
  const { ownerDisplayName, appointment } = agg;
  const payload = {
    assigned_rep: ownerDisplayName || null,
  };
  if (appointment) {
    const p = laParts(appointment.start_at);
    payload.appointment_date = p.date;
    payload.appointment_time = p.hhmm;
  }
  // No active appointment: appointment_date/appointment_time are LEFT UNCHANGED
  // (cancellation clearing is UNRESOLVED — requires business decision). Only
  // assigned_rep is written.
  return payload;
}

/**
 * @param {object} base44 - lib/base44.js interface ({filter, create, update})
 * @param {object} agg - { lead, ownerDisplayName, appointment }
 * @param {object|null} mapRow - base44_entity_map row or null
 * @returns {Promise<{base44Id:string, mode:'created'|'updated'|'adopted'}>}
 */
async function reconcileAndWrite(base44, agg, mapRow) {
  // Map present -> update the known Lead (UPDATE field set)
  if (mapRow) {
    await base44.update('Lead', mapRow.base44_id, buildUpdatePayload(agg));
    return { base44Id: mapRow.base44_id, mode: 'updated' };
  }

  // Map absent -> exact reconciliation by railway_lead_id
  const matches = await base44.filter('Lead', { railway_lead_id: agg.lead.id });

  if (!matches || matches.length === 0) {
    const created = await base44.create('Lead', buildCreatePayload(agg));
    return { base44Id: created.id, mode: 'created' };
  }

  if (matches.length === 1) {
    await base44.update('Lead', matches[0].id, buildUpdatePayload(agg));
    return { base44Id: matches[0].id, mode: 'adopted' };
  }

  // >1 match -> fail safely, never choose arbitrarily
  throw new DuplicateRailwayLeadIdError(matches.length);
}

module.exports = {
  reconcileAndWrite,
  buildCreatePayload,
  buildUpdatePayload,
  laParts,
  DuplicateRailwayLeadIdError,
};