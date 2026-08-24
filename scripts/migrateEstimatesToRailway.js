/* eslint-disable no-undef */
'use strict';
/**
 * migrateEstimatesToRailway.js — Idempotent estimate migration from Base44 to Railway.
 *
 * Run on Railway: node scripts/migrateEstimatesToRailway.js
 *
 * Reads ALL estimates from Base44 (via REST API) and upserts them into the
 * Railway `estimates` table with external_ref = Base44 estimate ID.
 *
 * Maps Base44 `lead_id` (Base44 Lead ObjectId) → Railway leads.id (via external_ref).
 *
 * IDEMPOTENT: uses ON CONFLICT (external_ref) DO UPDATE. Safe to run multiple times.
 * PRESERVES: existing Railway estimate IDs (external_ref is the stable key).
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-estimates] Starting idempotent estimate migration...');
  if (!hasBase44Creds()) {
    console.error('[migrate-estimates] BASE44_APP_ID and BASE44_API_KEY required');
    process.exit(1);
  }

  // Build lead ID cache: Base44 Lead ObjectId → Railway leads.id
  const leadIdCache = await buildLeadIdCache();
  console.log(`[migrate-estimates] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  // Fetch all Base44 estimates
  const base44Estimates = await fetchBase44Entity('Estimate');
  console.log(`[migrate-estimates] Fetched ${base44Estimates.length} estimates from Base44`);

  // Upsert each estimate
  let created = 0, updated = 0, skipped = 0, errors = 0, unresolvedLeadFk = 0;

  for (let i = 0; i < base44Estimates.length; i++) {
    const est = base44Estimates[i];
    try {
      const externalRef = est.id;
      if (!externalRef) { skipped++; continue; }

      const title = est.title || 'Untitled Estimate';

      // Resolve lead_id: Base44 Lead ObjectId → Railway leads.id
      let railwayLeadId = null;
      if (est.lead_id) {
        railwayLeadId = leadIdCache[String(est.lead_id)] || null;
        if (!railwayLeadId) {
          unresolvedLeadFk++;
          console.warn(`[migrate-estimates] Estimate ${est.id} has lead_id ${est.lead_id} with no Railway mapping — lead_id set to NULL`);
        }
      }

      // line_items: pass as JSONB
      const lineItems = Array.isArray(est.line_items) ? JSON.stringify(est.line_items) : '[]';

      const sql = `
        INSERT INTO estimates (
          external_ref, lead_id, project_id, title, status, line_items,
          subtotal, markup_pct, total, deposit_amount, notes, valid_until,
          qb_estimate_id, qb_estimate_number, qb_status, qb_estimate_date,
          qb_last_sync_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, NOW(), NOW()
        )
        ON CONFLICT (external_ref) DO UPDATE SET
          lead_id = COALESCE(EXCLUDED.lead_id, estimates.lead_id),
          project_id = EXCLUDED.project_id,
          title = EXCLUDED.title,
          status = EXCLUDED.status,
          line_items = EXCLUDED.line_items,
          subtotal = EXCLUDED.subtotal,
          markup_pct = EXCLUDED.markup_pct,
          total = EXCLUDED.total,
          deposit_amount = EXCLUDED.deposit_amount,
          notes = EXCLUDED.notes,
          valid_until = EXCLUDED.valid_until,
          qb_estimate_id = EXCLUDED.qb_estimate_id,
          qb_estimate_number = EXCLUDED.qb_estimate_number,
          qb_status = EXCLUDED.qb_status,
          qb_estimate_date = EXCLUDED.qb_estimate_date,
          qb_last_sync_at = EXCLUDED.qb_last_sync_at,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted, id
      `;

      const params = [
        String(externalRef),
        railwayLeadId,
        est.project_id || null,
        title,
        est.status || 'Draft',
        lineItems,
        est.subtotal || 0,
        est.markup_pct || 0,
        est.total || 0,
        est.deposit_amount || 0,
        est.notes || null,
        est.valid_until || null,
        est.qb_estimate_id || null,
        est.qb_estimate_number || null,
        est.qb_status || null,
        est.qb_estimate_date || null,
        est.qb_last_sync_at || null,
      ];

      const { rows } = await query(sql, params);
      const inserted = !!(rows[0] && rows[0].inserted);
      if (inserted) created++; else updated++;

      if ((i + 1) % 50 === 0) {
        console.log(`[migrate-estimates] Progress: ${i + 1}/${base44Estimates.length} (created=${created} updated=${updated})`);
      }
    } catch (e) {
      errors++;
      console.error(`[migrate-estimates] Error on estimate ${est.id}: ${e.message}`);
    }
  }

  console.log('\n=== ESTIMATE MIGRATION COMPLETE ===');
  console.log(`Total Base44 estimates: ${base44Estimates.length}`);
  console.log(`Created in Railway: ${created}`);
  console.log(`Updated in Railway: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Unresolved lead FKs (set to NULL): ${unresolvedLeadFk}`);

  const { rows } = await query('SELECT COUNT(*) as cnt FROM estimates');
  console.log(`Railway estimates table now has: ${rows[0].cnt} rows`);

  process.exit(0);
}

main().catch(e => {
  console.error('[migrate-estimates] fatal:', e);
  process.exit(1);
});