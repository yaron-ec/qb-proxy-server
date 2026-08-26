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
 * SOURCE NORMALIZATION:
 *   Base44 Activity.source has schema enum ['hubspot','gmail','calendar','manual'].
 *   However, one record has source='test' (a system test artifact). The Railway
 *   activities_source_check constraint allows only ['hubspot','gmail','calendar','manual'].
 *   We normalize 'test' → 'manual' (it's a system-generated manual test event).
 *   Any other unknown source value is also normalized to 'manual' with a warning.
 *
 * ORPHAN HANDLING:
 *   520 activities reference Base44 lead_ids for leads that were deleted from Base44.
 *   These are historical HubSpot email/meeting records worth preserving.
 *   Migration 2026-22 makes activities.lead_id nullable and adds original_lead_ref.
 *   For activities with unresolved lead_ids:
 *     - lead_id = NULL (no FK violation)
 *     - original_lead_ref = the original Base44 lead_id (preserved for traceability)
 *   No activity is silently dropped.
 *
 * IDEMPOTENT: YES. SAFE TO RE-RUN: YES. CAN CREATE DUPLICATES: NO.
 *   Unique key: external_ref (Base44 activity ID). ON CONFLICT (external_ref) DO UPDATE.
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */
'use strict';

const { query: defaultQuery } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');

// ── Source normalization ─────────────────────────────────────────────────────
// Railway activities_source_check allows: 'hubspot', 'gmail', 'calendar', 'manual'
const ALLOWED_SOURCES = new Set(['hubspot', 'gmail', 'calendar', 'manual']);
const SOURCE_MAP = { test: 'manual' }; // 'test' is a system test artifact → manual

function normalizeSource(src) {
  if (!src) return 'manual';
  if (ALLOWED_SOURCES.has(src)) return src;
  if (SOURCE_MAP[src]) return SOURCE_MAP[src];
  // Unknown source — normalize to 'manual' (safest default for system-generated events)
  return 'manual';
}

// ── Ensure external_ref column exists on activities ──────────────────────────
async function ensureExternalRefColumn(queryFn) {
  await queryFn('ALTER TABLE activities ADD COLUMN IF NOT EXISTS external_ref TEXT');
  await queryFn(`
    CREATE UNIQUE INDEX IF NOT EXISTS activities_external_ref_idx
    ON activities (external_ref) WHERE external_ref IS NOT NULL
  `);
  // Ensure orphan handling columns exist (migration 2026-22)
  await queryFn('ALTER TABLE activities ALTER COLUMN lead_id DROP NOT NULL');
  await queryFn('ALTER TABLE activities ADD COLUMN IF NOT EXISTS original_lead_ref TEXT');
  await queryFn(`
    CREATE INDEX IF NOT EXISTS activities_original_lead_ref_idx
    ON activities (original_lead_ref) WHERE original_lead_ref IS NOT NULL
  `);
}

// ── Upsert a single activity ─────────────────────────────────────────────────
async function upsertActivity(activity, railwayLeadId, queryFn) {
  const externalRef = activity.id;
  if (!externalRef) return { action: 'skipped', reason: 'no_id' };

  const metadata = activity.metadata ? JSON.stringify(activity.metadata) : null;
  const createdAt = activity.timestamp || activity.created_date || new Date().toISOString();
  const source = normalizeSource(activity.source);
  const originalLeadRef = activity.lead_id || null;

  // If lead_id doesn't resolve, store as orphan (lead_id = NULL, original_lead_ref = Base44 ID)
  const sql = `
    INSERT INTO activities (external_ref, lead_id, original_lead_ref, type, content, author, source, metadata, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (external_ref) DO UPDATE SET
      lead_id = EXCLUDED.lead_id,
      original_lead_ref = EXCLUDED.original_lead_ref,
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
    railwayLeadId,        // NULL if orphan
    originalLeadRef,      // original Base44 lead_id (stored for traceability)
    activity.type || 'note',
    activity.content || '',
    activity.author || null,
    source,
    metadata,
    createdAt,
  ];

  const { rows } = await queryFn(sql, params);
  const inserted = !!(rows[0] && rows[0].inserted);
  return { action: inserted ? 'created' : 'updated', id: rows[0]?.id, orphan: !railwayLeadId };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function runActivityMigration(queryFn = defaultQuery) {
  console.log('[migrate-activities] Starting idempotent activity migration...');

  await ensureExternalRefColumn(queryFn);
  const leadIdCache = await buildLeadIdCache(queryFn);
  console.log(`[migrate-activities] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Activities = await fetchBase44Entity('Activity');
  console.log(`[migrate-activities] Fetched ${base44Activities.length} activities from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let orphaned = 0, resolved = 0;
  const sourceNormalizations = {};

  for (let i = 0; i < base44Activities.length; i++) {
    const activity = base44Activities[i];
    try {
      const railwayLeadId = leadIdCache[String(activity.lead_id)] || null;

      // Track source normalizations
      if (activity.source && !ALLOWED_SOURCES.has(activity.source)) {
        const origSrc = activity.source;
        sourceNormalizations[origSrc] = (sourceNormalizations[origSrc] || 0) + 1;
      }

      const result = await upsertActivity(activity, railwayLeadId, queryFn);
      if (result.action === 'created') created++;
      else if (result.action === 'updated') updated++;
      else skipped++;

      if (result.orphan) orphaned++;
      else resolved++;

      if ((i + 1) % 500 === 0) {
        console.log(`[migrate-activities] Progress: ${i + 1}/${base44Activities.length} (created=${created} updated=${updated} orphaned=${orphaned})`);
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
  console.log(`Resolved (lead_id found): ${resolved}`);
  console.log(`Orphaned (lead_id NULL, original_lead_ref preserved): ${orphaned}`);
  if (Object.keys(sourceNormalizations).length > 0) {
    console.log('Source normalizations:');
    for (const [src, cnt] of Object.entries(sourceNormalizations)) {
      console.log(`  '${src}' → 'manual': ${cnt} record(s)`);
    }
  }

  const { rows } = await queryFn('SELECT COUNT(*) as cnt FROM activities');
  console.log(`Railway activities table now has: ${rows[0].cnt} rows`);

  return { created, updated, skipped, errors, orphaned, resolved, sourceNormalizations, total: base44Activities.length };
}

module.exports = { runActivityMigration, normalizeSource, ALLOWED_SOURCES };

if (require.main === module) {
  if (!hasBase44Creds()) {
    console.error('[migrate-activities] WORKER_SECRET required');
    process.exit(1);
  }
  runActivityMigration().then(() => process.exit(0)).catch(e => {
    console.error('[migrate-activities] fatal:', e);
    process.exit(1);
  });
}