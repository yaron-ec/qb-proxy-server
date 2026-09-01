/* eslint-disable no-undef */
/**
 * leadResolution — deterministic Lead Resolution Policy.
 *
 * Idempotency (retry the same booking) and customer deduplication are separate.
 * A retry never creates a second Lead; a new legitimate lead is never silently
 * merged away.
 *
 * Resolution (run inside the booking transaction, on the first attempt only):
 *   A. explicit reuse — lead_id or external_ref supplied and matches a row.
 *   B. confident reuse — name(first+last) matches AND (address matches OR
 *      both empty) AND (phone matches OR email matches). Reuses the lead.
 *   C. potential duplicate — phone or email matches but name/address differ.
 *      Returns candidates for review; does NOT auto-merge.
 *   D. create — no match. Creates a new canonical Lead.
 *
 * Phone/email are secondary signals; address + name are primary discriminators.
 */
'use strict';

function normPhone(p) { return (p || '').replace(/\D/g, '').slice(-10); }
function normEmail(e) { return (e || '').trim().toLowerCase(); }
function normAddr(a) {
  return (a || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s]/g, '');
}
function normName(n) { return (n || '').trim().toLowerCase().replace(/\s+/g, ' '); }

async function resolveLead(client, input) {
  const { lead_id, external_ref, first_name, last_name, email, phone, property_address, force_new_lead } = input;

  // A. explicit reuse
  if (lead_id) {
    const r = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [lead_id]);
    if (r.rows[0]) return { action: 'reuse', leadId: r.rows[0].id };
  }
  if (external_ref) {
    const r = await client.query('SELECT * FROM leads WHERE external_ref = $1 FOR UPDATE', [external_ref]);
    if (r.rows[0]) return { action: 'reuse', leadId: r.rows[0].id };
  }

  // force_new_lead: explicit user decision to create a separate canonical Lead
  // even when a potential duplicate exists. Skip candidate-based duplicate
  // detection entirely. Never silently merges. Idempotency is unaffected
  // (handled before this runs). Included in the request hash so a retry with a
  // different force_new_lead decision is a materially different request.
  if (force_new_lead) return { action: 'create' };

  const nFirst = normName(first_name);
  const nLast = normName(last_name);
  const nEmail = normEmail(email);
  const nPhone = normPhone(phone);
  const nAddr = normAddr(property_address);

  // Find candidates by phone or email (secondary signals).
  const orClauses = [];
  const params = [];
  if (nEmail) {
    params.push(nEmail);
    orClauses.push(`lower(coalesce(email, '')) = lower($${params.length})`);
  }
  if (nPhone && nPhone.length >= 7) {
    params.push(nPhone);
    orClauses.push(`regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE '%' || $${params.length}`);
  }
  let candidates = [];
  if (orClauses.length) {
    const r = await client.query(
      `SELECT * FROM leads WHERE ${orClauses.join(' OR ')} FOR UPDATE`,
      params
    );
    candidates = r.rows;
  }

  // B. confident reuse
  for (const c of candidates) {
    const cFirst = normName(c.first_name);
    const cLast = normName(c.last_name);
    const cAddr = normAddr(c.property_address);
    const cEmail = normEmail(c.email);
    const cPhone = normPhone(c.phone);
    const nameMatch = nFirst && nLast && cFirst === nFirst && cLast === nLast;
    const addrMatch = (nAddr && cAddr === nAddr) || (!nAddr && !cAddr);
    const contactMatch = (nPhone && cPhone === nPhone) || (nEmail && cEmail === nEmail);
    if (nameMatch && addrMatch && contactMatch) {
      return { action: 'reuse', leadId: c.id };
    }
  }

  // C. potential duplicate — return for review, do NOT merge
  if (candidates.length) {
    return {
      action: 'duplicate',
      candidates: candidates.map(c => ({
        id: c.id,
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        phone: c.phone,
        property_address: c.property_address,
      })),
    };
  }

  // D. create
  return { action: 'create' };
}

module.exports = { resolveLead, normPhone, normEmail, normAddr, normName };