#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * reconcileGoogleContactsLive.js — READ-ONLY reconciliation of CRM Leads
 * against the LIVE Google Contacts API (People API searchContacts), using
 * the corrected shared matching rule (lib/googleContactsClient.js's
 * last-10-digits phone comparison; exact, case-insensitive email match —
 * never name-only matching, per the standing rule that a name is never
 * sufficient evidence for a destructive/update action).
 *
 * This is DIFFERENT from, and complements, scripts/reconcileGoogleContacts.js:
 *   - reconcileGoogleContacts.js classifies leads against OUR OWN sync
 *     bookkeeping (google_contacts_outbox / google_contact_synced_at) — it
 *     never calls Google at all, and its --enqueue is the one and only
 *     write path (queuing the existing, already-verified outbox worker,
 *     never writing to Google directly itself).
 *   - THIS script classifies leads against what Google's own Contacts data
 *     ACTUALLY contains right now — the thing our own bookkeeping cannot
 *     tell you (our outbox can believe a sync succeeded while Google's copy
 *     was since edited/merged/deleted independently, or holds more than
 *     one contact for the same person).
 *
 * This script NEVER creates, updates, or deletes a Google Contact — it has
 * no write path AT ALL, not even behind a flag. If a Lead needs a sync
 * queued as a result of what this report finds, the safe, existing path is
 * `node scripts/reconcileGoogleContacts.js --enqueue`.
 *
 * Categories (one per Lead with a phone or email; Leads with neither are
 * INSUFFICIENT_DATA and never searched):
 *   MATCHED           — exactly one Google contact matches (by email or by
 *                       last-10-digits phone), unambiguously.
 *   MISSING           — the search for this Lead's email/phone returned no
 *                       Google contact at all.
 *   AMBIGUOUS         — the email search and the phone search each found a
 *                       match, but they are DIFFERENT Google contacts — we
 *                       cannot tell which one (if either) is authoritative
 *                       without a human decision.
 *   DUPLICATE_GOOGLE  — a single search (by this Lead's own email, or by
 *                       its own phone) returned more than one distinct
 *                       Google contact — Google itself holds duplicates for
 *                       this identity.
 *   INSUFFICIENT_DATA — the Lead has neither an email nor a phone; there is
 *                       nothing to search Google Contacts by.
 *   ERROR             — the Google API call itself failed (auth/network/
 *                       quota) — this Lead's real state is unknown, NOT
 *                       assumed MISSING (a search failure is not evidence
 *                       of absence).
 *
 * Usage:
 *   node scripts/reconcileGoogleContactsLive.js
 *
 * Requires DATABASE_URL and the same Google service-account domain-wide
 * delegation credentials the live Contacts sync already uses. Report-only,
 * by design, permanently — there is no --apply/--enqueue flag here.
 */
'use strict';

const { last10Digits } = (() => {
  function last10Digits(value) {
    return String(value || '').replace(/\D/g, '').slice(-10);
  }
  return { last10Digits };
})();

/**
 * Pure classifier — takes the raw Google searchContacts result arrays for
 * one Lead's email query and phone query (each an array of Google `person`
 * objects, or null if that query wasn't run because the field was absent)
 * and returns one of the categories above. No I/O — fully unit-testable
 * against realistic Google API response shapes.
 */
function classifyContactMatch({ email, phone, emailResults, phoneResults }) {
  if (!email && !phone) return { category: 'INSUFFICIENT_DATA' };

  const emailMatches = (emailResults || []).filter(p =>
    (p.emailAddresses || []).some(e => e.value && email && e.value.toLowerCase() === email.toLowerCase())
  );
  const phoneMatches = (phoneResults || []).filter(p => {
    const target = last10Digits(phone);
    return target && (p.phoneNumbers || []).some(ph => ph.value && last10Digits(ph.value) === target);
  });

  if (email && emailMatches.length > 1) return { category: 'DUPLICATE_GOOGLE', matches: emailMatches, via: 'email' };
  if (phone && phoneMatches.length > 1) return { category: 'DUPLICATE_GOOGLE', matches: phoneMatches, via: 'phone' };

  const emailMatch = emailMatches[0] || null;
  const phoneMatch = phoneMatches[0] || null;

  if (emailMatch && phoneMatch) {
    const same = emailMatch.resourceName && emailMatch.resourceName === phoneMatch.resourceName;
    if (same) return { category: 'MATCHED', match: emailMatch };
    return { category: 'AMBIGUOUS', matches: [emailMatch, phoneMatch] };
  }
  if (emailMatch) return { category: 'MATCHED', match: emailMatch };
  if (phoneMatch) return { category: 'MATCHED', match: phoneMatch };
  return { category: 'MISSING' };
}

async function searchGoogleContacts(fetchImpl, token, query, peopleBase) {
  if (!query) return null;
  const mask = 'names,emailAddresses,phoneNumbers';
  const url = `${peopleBase}/people:searchContacts?query=${encodeURIComponent(query)}&readMask=${mask}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`Google People API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.results || []).map(r => r.person || {});
}

async function classifyLead(lead, deps) {
  const { getAccessToken, fetchImpl, peopleBase } = deps;
  const { email, phone, owner_email } = lead;
  if (!email && !phone) return { lead_id: lead.id, category: 'INSUFFICIENT_DATA' };

  try {
    const token = await getAccessToken(owner_email);
    const [emailResults, phoneResults] = await Promise.all([
      email ? searchGoogleContacts(fetchImpl, token, email, peopleBase) : Promise.resolve(null),
      phone ? searchGoogleContacts(fetchImpl, token, phone.replace(/\D/g, ''), peopleBase) : Promise.resolve(null),
    ]);
    const result = classifyContactMatch({ email, phone, emailResults, phoneResults });
    return { lead_id: lead.id, ...result };
  } catch (e) {
    return { lead_id: lead.id, category: 'ERROR', error: e.message };
  }
}

async function runReconciliation(leads, deps) {
  const buckets = { MATCHED: [], MISSING: [], AMBIGUOUS: [], DUPLICATE_GOOGLE: [], INSUFFICIENT_DATA: [], ERROR: [] };
  for (const lead of leads) {
    const result = await classifyLead(lead, deps);
    buckets[result.category].push(result);
  }
  return buckets;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const { pool } = require('../db/client');
  const googleContactsClient = require('../lib/googleContactsClient');

  const { rows: leads } = await pool.query(`
    SELECT l.id, l.email, l.phone, o.email AS owner_email
    FROM leads l
    LEFT JOIN owners o ON o.id = l.owner_id
    WHERE l.status NOT IN ('DNQ', 'Lost', 'Closed Lost', 'Closed', 'Duplicate', 'Archived', 'Cancelled')
      AND l.record_type = 'Lead'
  `);

  console.log(`[reconcile-contacts-live] Classifying ${leads.length} active leads against LIVE Google Contacts (read-only — no writes)...`);

  const buckets = await runReconciliation(leads, {
    getAccessToken: googleContactsClient.getAccessToken,
    fetchImpl: fetch,
    peopleBase: 'https://people.googleapis.com/v1',
  });

  const summary = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  console.log(JSON.stringify(summary, null, 2));

  if (buckets.AMBIGUOUS.length) {
    console.log(`\nAMBIGUOUS (${buckets.AMBIGUOUS.length}) — needs a human decision, no automatic action taken:`);
    for (const r of buckets.AMBIGUOUS) console.log(`  lead ${r.lead_id}`);
  }
  if (buckets.DUPLICATE_GOOGLE.length) {
    console.log(`\nDUPLICATE_GOOGLE (${buckets.DUPLICATE_GOOGLE.length}) — Google itself holds more than one contact for this identity:`);
    for (const r of buckets.DUPLICATE_GOOGLE) console.log(`  lead ${r.lead_id} (matched via ${r.via})`);
  }
  if (buckets.ERROR.length) {
    console.log(`\nERROR (${buckets.ERROR.length}) — could not be verified, NOT assumed missing:`);
    for (const r of buckets.ERROR) console.log(`  lead ${r.lead_id}: ${r.error}`);
  }

  console.log('\nReport-only — this script never writes to Google Contacts. To queue a real sync for a MISSING/stale lead, use the existing safe path: node scripts/reconcileGoogleContacts.js --enqueue');
  process.exit(0);
}

module.exports = { classifyContactMatch, classifyLead, runReconciliation };

if (require.main === module) {
  main().catch(e => { console.error('[reconcile-contacts-live] fatal:', e); process.exit(1); });
}
