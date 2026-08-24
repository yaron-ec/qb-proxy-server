/* eslint-disable no-undef */
/**
 * migrateActivitiesToRailway.js — Idempotent activity migration from Base44 to Railway.
 *
 * PREREQUISITE: Run migrateLeadsToRailway.js FIRST. Activities have a FK constraint
 * on leads(id) — the Base44 lead_id must be resolved to a Railway leads.id via
 * external_ref before insertion.
 *
 * Run on Railway: node scripts/migrateActivitiesToRailway.js
 *
 * Reads ALL activities from Base44 (via REST API) and upserts them into the
 * Railway `activities` table with external_ref = Base44 activity ID.
 *
 * Adds external_ref column to activities table if missing (migration 2026-09
 * did not include it). Uses ON CONFLICT (external_ref) DO UPDATE for idempotency.
 *
 * Maps Base44 Activity.timestamp → Railway activities.created_at.
 * Maps Base44 Activity.lead_id (Base44 ObjectId) → Railway leads.id (via external_ref).
 *
 * IDEMPOTENT: YES. SAFE TO RE-RUN: YES. CAN CREATE DUPLICATES: NO.
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */
'use strict';

const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');

if (!hasBase44Creds()) {
  console.error('[migrate-activities] BASE44_APP_ID and BASE44_API_KEY required');
  process.exit(1);
}

// ── Ensure external_ref column exists on activities ──────────────────────────
async function ensureExternalRefColumn() {
  await query('ALTER TABLE activities ADD COLUMN IF NOT EXISTS external_ref TEXT');
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS activities_external_ref_idx
    ON activities (external_ref) WHERE external_ref IS NOT NULL
  `);
  console.log('[migrate-activities] external_ref column ensured');
}

// ── Build lead_id resolution cache: Base44 Lead ID → Railway leads.id ─────────
// Uses shared helper from migrationHelpers.js

// ── Upsert a single activity ─────────────────────────────────────────────────
async function upsertActivity(activity, railwayLeadId) {
  const externalRef = activity.id;
  if (!externalRef) return { action: 'skipped', reason: 'no_id' };
  if (!railwayLeadId) return { action: 'skipped', reason: 'lead_not_found' };

  const metadata = activity.metadata ? JSON.stringify(activity.metadata) : null;
  const createdAt = activity.timestamp || activity.created_date || new Date().toISOString();

  const sql = `
    INSERT INTO activities (external_ref, lead_id, type, content, author, source, metadata, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (external_ref) DO UPDATE SET
      lead_id = EXCLUDED.lead_id,
      type = EXCLUDED.type,
      content = EXCLUDED.content,
      author = COALESCE(EXCLUDED.author, activities.author),
      source = EXCLUDED.source,
      metadata = COALESCE(EXCLUDED.metadata, activities.metadata),
      created_at = EXCLUDED.created_at,
      updated_at = NOW()
    RETURNING (xmax = 0) AS inserted, id
  `;

  const params = [
    String(externalRef),
    railwayLeadId,
    activity.type || 'note',
    activity.content || '',
    activity.author || null,
    activity.source || 'manual',
    metadata,
    createdAt,
  ];

  const { rows } = await query(sql, params);
  const inserted = !!(rows[0] && rows[0].inserted);
  return { action: inserted ? 'created' : 'updated', id: rows[0]?.id };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[migrate-activities] Starting idempotent activity migration...');

  await ensureExternalRefColumn();
  const leadIdCache = await buildLeadIdCache();
  console.log(`[migrate-activities] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Activities = await fetchBase44Entity('Activity');
  console.log(`[migrate-activities] Fetched ${base44Activities.length} activities from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0;

  for (let i = 0; i < base44Activities.length; i++) {
    const activity = base44Activities[i];
    try {
      const railwayLeadId = leadIdCache[String(activity.lead_id)] || null;
      if (!railwayLeadId) leadNotFound++;

      const result = await upsertActivity(activity, railwayLeadId);
      if (result.action === 'created') created++;
      else if (result.action === 'updated') updated++;
      else skipped++;

      if ((i + 1) % 500 === 0) {
        console.log(`[migrate-activities] Progress: ${i + 1}/${base44Activities.length} (created=${created} updated=${updated})`);
      }
    } catch (e) {
      errors++;
      if (errors <= 10) console.error(`[migrate-activities] Error on activity ${activity.id}: ${e.message}`);
    }
  }

  console.log('\n=== ACTIVITY MIGRATION COMPLETE ===');
  console.log(`Total Base44 activities: ${base44Activities.length}`);
  console.log(`Created: ${created}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Activities with unresolvable lead_id: ${leadNotFound}`);

  const { rows } = await query('SELECT COUNT(*) as cnt FROM activities');
  console.log(`Railway activities table now has: ${rows[0].cnt} rows`);

  process.exit(0);
}

main().catch(e => {
  console.error('[migrate-activities] fatal:', e);
  process.exit(1);
});