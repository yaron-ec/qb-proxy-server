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

// ── Per-identity intake lock ────────────────────────────────────────────────
// SELECT … FOR UPDATE on duplicate candidates cannot protect a lead that does
// not exist yet: two simultaneous submissions for the same NEW person both see
// zero candidates and both INSERT (a duplicate), and two simultaneous bookings
// with the same idempotency key both miss booking_idempotency and the second
// fails on its primary key. Every lead-creating transaction therefore first
// takes transaction-scoped advisory locks on the identities it may create or
// match — normalized phone (last 10 digits), normalized email, external_ref and
// idempotency key — so those submissions serialize and the later one sees the
// earlier one's committed lead (reuse / duplicate review / idempotent replay).
// Unrelated leads share no key and never wait on each other.
//
// Deadlock-free by construction: keys are hashed and acquired in ascending
// order, and they are ALWAYS the first locks an intake transaction takes
// (before lead row locks, the owner-schedule lock in appointmentWriter, or any
// insert). Released automatically at COMMIT/ROLLBACK.
const INTAKE_LOCK_NAMESPACE = 1002; // appointmentWriter uses 1001

function identityLockKeys({ email, phone, external_ref, idempotency_key } = {}) {
  const keys = [];
  const e = normEmail(email);
  if (e) keys.push('email:' + e);
  const p = normPhone(phone);
  if (p && p.length >= 7) keys.push('phone:' + p);
  if (external_ref) keys.push('ref:' + String(external_ref));
  if (idempotency_key) keys.push('idem:' + String(idempotency_key));
  return keys;
}

async function lockLeadIdentity(client, identity) {
  const keys = identityLockKeys(identity);
  if (!keys.length) return [];
  const { rows } = await client.query('SELECT DISTINCT hashtext(k) AS h FROM unnest($1::text[]) AS k', [keys]);
  const hashes = rows.map(r => Number(r.h)).sort((a, b) => a - b);
  for (const h of hashes) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [INTAKE_LOCK_NAMESPACE, h]);
  }
  return hashes;
}

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
      `SELECT * FROM leads WHERE ${orClauses.join(' OR ')} ORDER BY id FOR UPDATE`,
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

module.exports = { resolveLead, lockLeadIdentity, identityLockKeys, INTAKE_LOCK_NAMESPACE, normPhone, normEmail, normAddr, normName };