/* eslint-disable no-undef */
'use strict';
/**
 * migrateQbCustomerIdToRailway.js — Idempotent backfill of leads.qb_customer_id
 * from Base44 Lead.qb_customer_id + 3 Property-only mappings.
 *
 * CANONICAL ARCHITECTURE:
 *   leads.qb_customer_id is the SINGLE source of truth for Lead <-> QB Customer.
 *   This script populates it from two Base44 sources:
 *     A) 54 Base44 Leads with qb_customer_id set (authoritative — set by QB sync)
 *     B) 3 Property-only mappings (Hannah→61, David→59, Desire→58 — only source)
 *
 * MICHAEL CAUGHEY CONFLICT RESOLUTION:
 *   Lead.qb_customer_id = "49" (proven correct by corroborating QB payment data:
 *   $6,814 paid, status "paid", sync success 2026-07-14)
 *   Property.qb_customer_id = "62" (older, 2026-05-07, no corroborating data)
 *   → Use Lead value "49". Property "62" is OBSOLETE/superseded.
 *
 * NOT MIGRATED (SAFE TO DISCARD):
 *   - 110 Property "60" mappings (all Contact records, default/bug value)
 *   - 29 deleted leads (no Railway destination)
 *   - 1 Michael Caughey Property "62" (superseded by Lead "49")
 *
 * DUPLICATE RESOLUTION — Kun Katsumata / QB Customer 46:
 *   Two Base44 leads share qb_customer_id="46":
 *     A) 69f921b331dad328146ca5ba — record_type "Contact", no phone, no QB
 *        financial data, sync result "pending", $0 deal, 1 activity.
 *     B) 69f9219281e1d336233e8b1d — record_type "Lead", phone 408-515-3991,
 *        $18,555 invoice / $17,755 paid / $800 balance, sync "success",
 *        $27,380 deal, 24 activities. Created 4 days earlier.
 *   Verdict: TRUE DUPLICATE — (A) is a duplicate of (B). (B) is canonical.
 *   Action: Backfill qb_customer_id="46" ONLY on (B). EXCLUDE (A) — its
 *   qb_customer_id must remain NULL so findMatchingLead() does not encounter
 *   an ambiguous 1:many mapping. (A) should be merged into (B) separately.
 *
 * IDEMPOTENT: ON CONFLICT (external_ref) DO UPDATE.
 * Uses dependency-injected queryFn for rollback validation.
 */
const { query: defaultQuery } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

// The 3 Property-only mappings (Lead has no qb_customer_id, Property is only source)
const PROPERTY_ONLY_MAPPINGS = [
  { external_ref: '69f937cd99ff3ef2652dc88e', qb_customer_id: '61', name: 'Hannah Abigail Peaslee' },
  { external_ref: '69fac331a97f1babcf4a5375', qb_customer_id: '59', name: 'David Fargo' },
  { external_ref: '69fac33595ee04a5e0fca791', qb_customer_id: '58', name: 'Desire Jones' },
];

// Duplicate leads that must NOT receive a qb_customer_id backfill.
// These are duplicate CRM records for a customer whose canonical lead is
// already in the mapping. Backfilling both would create an ambiguous 1:many
// mapping, causing findMatchingLead() to fail closed (return null).
const DUPLICATE_EXCLUSIONS = new Set([
  '69f921b331dad328146ca5ba', // Kun Katsumata (Contact) — duplicate of 69f9219281e1d336233e8b1d
]);

async function runQbCustomerIdMigration(queryFn = defaultQuery) {
  console.log('[migrate-qb-customer-id] Starting leads.qb_customer_id backfill...');

  // ── Step 1: Verify the column exists ──────────────────────────────────
  const { rows: colCheck } = await queryFn(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'qb_customer_id'
  `);
  if (colCheck.length === 0) {
    throw new Error('leads.qb_customer_id column does NOT exist. Run migration 2026-23 first.');
  }
  console.log('[migrate-qb-customer-id] leads.qb_customer_id column exists ✅');

  // ── Step 2: Fetch all Base44 leads with qb_customer_id ────────────────
  const base44Leads = await fetchBase44Entity('Lead');
  const leadsWithQb = base44Leads.filter(l => l.qb_customer_id != null && String(l.qb_customer_id).trim() !== '');
  console.log(`[migrate-qb-customer-id] Base44 leads with qb_customer_id: ${leadsWithQb.length}`);

  // ── Step 3: Fetch Base44 Property qb_customer_* mappings ──────────────
  const properties = await fetchBase44Entity('Property');
  const propMappings = new Map();
  for (const p of properties) {
    if (p.key && p.key.startsWith('qb_customer_')) {
      const leadRef = p.key.replace('qb_customer_', '');
      const qbId = String(p.value).trim();
      propMappings.set(leadRef, qbId);
    }
  }
  console.log(`[migrate-qb-customer-id] Property qb_customer_* mappings: ${propMappings.size}`);

  // ── Step 4: Build the canonical mapping list ──────────────────────────
  // Rule: Lead.qb_customer_id is authoritative. Property is only used when
  // Lead has no qb_customer_id AND the Property value is NOT "60" (default/bug).
  const canonicalMappings = new Map(); // external_ref -> qb_customer_id

  // A) Lead.qb_customer_id values (54 leads, minus 1 duplicate = 53)
  let excludedDuplicates = 0;
  for (const lead of leadsWithQb) {
    if (DUPLICATE_EXCLUSIONS.has(lead.id)) {
      excludedDuplicates++;
      console.log(`[migrate-qb-customer-id] EXCLUDING duplicate: ${lead.first_name} ${lead.last_name} (${lead.id}) — qb_customer_id=${lead.qb_customer_id} not backfilled`);
      continue;
    }
    canonicalMappings.set(lead.id, String(lead.qb_customer_id).trim());
  }
  console.log(`[migrate-qb-customer-id] From Lead.qb_customer_id: ${canonicalMappings.size} (excluded ${excludedDuplicates} duplicate(s))`);

  // B) Property-only mappings (3 leads — Hannah, David, Desire)
  // Only for leads NOT already in canonicalMappings (Lead is authoritative)
  let propertyOnlyAdded = 0;
  for (const { external_ref, qb_customer_id, name } of PROPERTY_ONLY_MAPPINGS) {
    if (!canonicalMappings.has(external_ref)) {
      canonicalMappings.set(external_ref, qb_customer_id);
      propertyOnlyAdded++;
      console.log(`[migrate-qb-customer-id] Property-only: ${name} (${external_ref}) → QB ${qb_customer_id}`);
    }
  }
  console.log(`[migrate-qb-customer-id] From Property-only: ${propertyOnlyAdded}`);
  console.log(`[migrate-qb-customer-id] Total canonical mappings: ${canonicalMappings.size}`);

  // ── Step 5: Write to Railway leads.qb_customer_id ─────────────────────
  let updated = 0, notFound = 0, errors = 0;
  const unresolved = [];

  for (const [external_ref, qb_customer_id] of canonicalMappings) {
    try {
      const { rows } = await queryFn(`
        UPDATE leads
        SET qb_customer_id = $1, updated_at = NOW()
        WHERE external_ref = $2
        RETURNING id, first_name, last_name
      `, [qb_customer_id, external_ref]);

      if (rows.length === 0) {
        notFound++;
        unresolved.push({ external_ref, qb_customer_id, reason: 'lead not found in Railway' });
      } else {
        updated++;
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-qb-customer-id] Error on ${external_ref}: ${e.message}`);
      unresolved.push({ external_ref, qb_customer_id, reason: e.message });
    }
  }

  // ── Step 6: Verify no duplicate qb_customer_id values ─────────────────
  const { rows: dupes } = await queryFn(`
    SELECT qb_customer_id, COUNT(*) as cnt, array_agg(external_ref) as lead_refs
    FROM leads
    WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
    GROUP BY qb_customer_id
    HAVING COUNT(*) > 1
  `);

  console.log(`\n=== QB CUSTOMER ID BACKFILL COMPLETE ===`);
  console.log(`Total canonical mappings: ${canonicalMappings.size}`);
  console.log(`Updated: ${updated}, Not found: ${notFound}, Errors: ${errors}`);
  console.log(`Duplicate qb_customer_id values in Railway: ${dupes.length}`);
  if (dupes.length > 0) {
    for (const d of dupes) {
      console.log(`  ⚠️  QB ${d.qb_customer_id}: ${d.cnt} leads (${d.lead_refs.join(', ')})`);
    }
  }

  if (unresolved.length > 0) {
    console.log(`\nUnresolved mappings (${unresolved.length}):`);
    for (const u of unresolved) {
      console.log(`  ${u.external_ref} → QB ${u.qb_customer_id}: ${u.reason}`);
    }
  }

  // Final count
  const { rows: finalCount } = await queryFn(`
    SELECT COUNT(*) as cnt FROM leads WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
  `);
  console.log(`Railway leads with qb_customer_id: ${finalCount[0].cnt}`);

  return { updated, notFound, errors, total: canonicalMappings.size, duplicates: dupes.length, unresolved };
}

module.exports = { runQbCustomerIdMigration };

if (require.main === module) {
  if (!hasBase44Creds()) { console.error('[migrate-qb-customer-id] WORKER_SECRET required'); process.exit(1); }
  runQbCustomerIdMigration().then(() => process.exit(0)).catch(e => { console.error('[migrate-qb-customer-id] fatal:', e); process.exit(1); });
}