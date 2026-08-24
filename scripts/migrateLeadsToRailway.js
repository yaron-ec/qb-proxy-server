/* eslint-disable no-undef */
/**
 * migrateLeadsToRailway.js — Idempotent lead migration from Base44 to Railway.
 *
 * Run on Railway: node scripts/migrateLeadsToRailway.js
 *
 * Reads ALL leads from Base44 (via REST API) and upserts them into the
 * Railway `leads` table with external_ref = Base44 lead ID.
 *
 * Maps Base44 `assigned_rep` (display name) → owners.display_name → owner_id.
 *
 * IDEMPOTENT: uses ON CONFLICT (external_ref) DO UPDATE. Safe to run multiple times.
 * PRESERVES: existing Railway lead IDs (external_ref is the stable key).
 * DOES NOT: delete leads that exist in Railway but not Base44 (one-way sync).
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */
'use strict';

const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildOwnerCache, resolveOwnerId, BASE44_API_URL } = require('./migrationHelpers');

if (!hasBase44Creds()) {
  console.error('[migrate-leads] BASE44_APP_ID and BASE44_API_KEY required');
  process.exit(1);
}

// ── Upsert a single lead into Railway ────────────────────────────────────────
async function upsertLead(lead, ownerId) {
  const externalRef = lead.id; // Base44 lead ID becomes external_ref
  if (!externalRef) return { action: 'skipped', reason: 'no_id' };

  const firstName = lead.first_name || 'Unknown';
  const lastName = lead.last_name || 'Lead';

  const sql = `
    INSERT INTO leads (
      external_ref, first_name, last_name, phone, email,
      property_address, city, state, zip, project_type, budget_range,
      start_timeframe, source, referral_name, owner_id, status, notes,
      message, lead_score, is_new_intake_lead, customer_reminders_disabled,
      photo_urls, record_type, follow_up_date, follow_up_time, follow_up_type,
      meeting_stage, crm_created_date, reviewed_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21,
      $22, $23, $24, $25, $26,
      $27, $28
    )
    ON CONFLICT (external_ref) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      phone = COALESCE(EXCLUDED.phone, leads.phone),
      email = COALESCE(EXCLUDED.email, leads.email),
      property_address = COALESCE(EXCLUDED.property_address, leads.property_address),
      city = COALESCE(EXCLUDED.city, leads.city),
      state = COALESCE(EXCLUDED.state, leads.state),
      zip = COALESCE(EXCLUDED.zip, leads.zip),
      project_type = COALESCE(EXCLUDED.project_type, leads.project_type),
      budget_range = COALESCE(EXCLUDED.budget_range, leads.budget_range),
      start_timeframe = COALESCE(EXCLUDED.start_timeframe, leads.start_timeframe),
      source = COALESCE(EXCLUDED.source, leads.source),
      referral_name = COALESCE(EXCLUDED.referral_name, leads.referral_name),
      owner_id = COALESCE(EXCLUDED.owner_id, leads.owner_id),
      status = EXCLUDED.status,
      notes = EXCLUDED.notes,
      message = EXCLUDED.message,
      lead_score = EXCLUDED.lead_score,
      is_new_intake_lead = EXCLUDED.is_new_intake_lead,
      customer_reminders_disabled = EXCLUDED.customer_reminders_disabled,
      photo_urls = EXCLUDED.photo_urls,
      record_type = EXCLUDED.record_type,
      follow_up_date = EXCLUDED.follow_up_date,
      follow_up_time = EXCLUDED.follow_up_time,
      follow_up_type = EXCLUDED.follow_up_type,
      meeting_stage = EXCLUDED.meeting_stage,
      crm_created_date = COALESCE(EXCLUDED.crm_created_date, leads.crm_created_date),
      reviewed_at = EXCLUDED.reviewed_at,
      updated_at = NOW()
    RETURNING (xmax = 0) AS inserted, id
  `;

  // TEXT[] column — pass JS array directly; pg converts to PostgreSQL array.
  // Never JSON.stringify — that produces a JSON string, not a TEXT[] array.
  const photoUrls = Array.isArray(lead.photo_urls) ? lead.photo_urls : [];

  const params = [
    String(externalRef),
    firstName, lastName,
    lead.phone || null, lead.email || null,
    lead.property_address || null, lead.city || null, lead.state || null, lead.zip || null,
    lead.project_type || null, lead.budget_range || null,
    lead.start_timeframe || null, lead.source || null, lead.referral_name || null,
    ownerId, lead.status || 'New', lead.notes || null,
    lead.message || null, lead.lead_score || 0,
    lead.is_new_intake_lead === true, lead.customer_reminders_disabled === true,
    photoUrls, lead.record_type || 'Lead',
    lead.follow_up_date || null, lead.follow_up_time || null, lead.follow_up_type || null,
    lead.meeting_stage || null,
    lead.crm_created_date || lead.created_date || null,
    lead.reviewed_at || null,
  ];

  const { rows } = await query(sql, params);
  const inserted = !!(rows[0] && rows[0].inserted);
  return { action: inserted ? 'created' : 'updated', id: rows[0]?.id };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[migrate-leads] Starting idempotent lead migration...');
  console.log('[migrate-leads] Base44 API:', BASE44_API_URL);

  // Load owner cache (shared helper — includes alias mapping)
  const ownerCache = await buildOwnerCache();
  console.log(`[migrate-leads] Loaded ${Object.keys(ownerCache).length} owner mappings`);

  // Load the canonical "Unassigned" owner ID — used ONLY for leads where Base44
  // assigned_rep is genuinely null/empty. NEVER used as a fallback for a named
  // owner that cannot be resolved. Named owners that can't be resolved cause
  // the migration to FAIL CLOSED to preserve ownership integrity.
  let unassignedOwnerId = ownerCache['unassigned'];
  if (!unassignedOwnerId) {
    const { rows: existing } = await query(
      `SELECT id FROM owners WHERE lower(display_name) = 'unassigned' AND is_active = true LIMIT 1`
    );
    unassignedOwnerId = existing[0]?.id || null;
  }
  if (!unassignedOwnerId) {
    // Create the canonical Unassigned owner (for genuinely null assigned_rep only)
    const { rows } = await query(`
      INSERT INTO owners (display_name, email, is_active)
      VALUES ('Unassigned', null, true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    unassignedOwnerId = rows[0]?.id || null;
    if (!unassignedOwnerId) {
      const { rows: existing } = await query(
        `SELECT id FROM owners WHERE lower(display_name) = 'unassigned' AND is_active = true LIMIT 1`
      );
      unassignedOwnerId = existing[0]?.id || null;
    }
  }
  console.log(`[migrate-leads] Canonical Unassigned owner ID: ${unassignedOwnerId || 'NONE'}`);
  console.log('[migrate-leads] Named owners without mapping will FAIL the migration (no silent fallback)');

  // Fetch all Base44 leads (shared reader — correct URL with /api prefix + X-App-Id header)
  const base44Leads = await fetchBase44Entity('Lead');
  console.log(`[migrate-leads] Fetched ${base44Leads.length} leads from Base44`);

  // Upsert each lead
  let created = 0, updated = 0, skipped = 0, errors = 0;
  let genuinelyUnassigned = 0;
  const unresolvedNamedOwners = new Map(); // assigned_rep → count

  for (let i = 0; i < base44Leads.length; i++) {
    const lead = base44Leads[i];
    try {
      const rep = lead.assigned_rep;
      const isGenuinelyUnassigned = !rep || !String(rep).trim();

      let ownerId;
      if (isGenuinelyUnassigned) {
        // Genuinely null/empty assigned_rep → canonical Unassigned owner
        ownerId = unassignedOwnerId;
        genuinelyUnassigned++;
      } else {
        // Named owner — must resolve or FAIL (no silent fallback)
        ownerId = resolveOwnerId(rep);
        if (!ownerId) {
          const repKey = String(rep).trim();
          unresolvedNamedOwners.set(repKey, (unresolvedNamedOwners.get(repKey) || 0) + 1);
          skipped++;
          continue;
        }
      }

      const result = await upsertLead(lead, ownerId);
      if (result.action === 'created') created++;
      else if (result.action === 'updated') updated++;
      else skipped++;

      if ((i + 1) % 100 === 0) {
        console.log(`[migrate-leads] Progress: ${i + 1}/${base44Leads.length} (created=${created} updated=${updated} skipped=${skipped})`);
      }
    } catch (e) {
      errors++;
      console.error(`[migrate-leads] Error on lead ${lead.id}: ${e.message}`);
    }
  }

  // FAIL CLOSED: if any named owner could not be resolved, abort the migration
  if (unresolvedNamedOwners.size > 0) {
    console.error('\n=== MIGRATION FAILED — UNRESOLVED NAMED OWNERS ===');
    console.error(`Found ${unresolvedNamedOwners.size} distinct assigned_rep value(s) with no Railway owner mapping:`);
    console.error('These leads were SKIPPED to preserve ownership integrity. No silent fallback was applied.');
    console.error('');
    console.error('SOURCE VALUE                        LEADS AFFECTED');
    console.error('──────────────────────────────────  ──────────────');
    for (const [rep, count] of [...unresolvedNamedOwners.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${rep.padEnd(34)}  ${count}`);
    }
    console.error('');
    console.error('To fix: run migrateOwnersToRailway.js first to create owners for all assigned_rep values,');
    console.error('then re-run this migration. Do NOT use a fallback — ownership must be preserved exactly.');
    process.exit(1);
  }

  console.log('\n=== MIGRATION COMPLETE ===');
  console.log(`Total Base44 leads: ${base44Leads.length}`);
  console.log(`Created in Railway: ${created}`);
  console.log(`Updated in Railway: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Genuinely unassigned (null assigned_rep → Unassigned owner): ${genuinelyUnassigned}`);
  console.log(`Unresolved named owners: 0 (all resolved ✅)`);

  // Verify
  const { rows } = await query('SELECT COUNT(*) as cnt FROM leads');
  console.log(`Railway leads table now has: ${rows[0].cnt} rows`);

  process.exit(0);
}

main().catch(e => {
  console.error('[migrate-leads] fatal:', e);
  process.exit(1);
});