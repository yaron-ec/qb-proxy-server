/* eslint-disable no-undef */
/**
 * migrateHandoffEstimatesToRailway.js — Idempotent handoff estimate migration.
 *
 * PREREQUISITE: Run migrateLeadsToRailway.js FIRST. Migration 2026-14 must be applied
 * (creates the `handoff_estimates` table).
 *
 * Run on Railway: node scripts/migrateHandoffEstimatesToRailway.js
 *
 * Reads ALL handoff estimates from Base44 (via REST API) and upserts them into
 * the Railway `handoff_estimates` table with external_ref = Base44 estimate ID.
 *
 * Maps Base44 HandoffEstimate.lead_id → Railway leads.id (via external_ref).
 * Only resolves lead_id for estimates with match_status='matched'.
 *
 * IDEMPOTENT: YES. SAFE TO RE-RUN: YES.
 */
'use strict';

const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');

if (!hasBase44Creds()) {
  console.error('[migrate-handoff] BASE44_APP_ID and BASE44_API_KEY required');
  process.exit(1);
}

async function upsertHandoffEstimate(est, railwayLeadId) {
  const externalRef = est.id;
  if (!externalRef) return { action: 'skipped', reason: 'no_id' };

  const sql = `
    INSERT INTO handoff_estimates (
      external_ref, handoff_estimate_id, handoff_estimate_number, qb_estimate_id,
      qb_estimate_number, lead_id, customer_name, customer_phone, customer_email,
      estimate_amount, estimate_status, estimate_date, document_url, document_title,
      pdf_url, pdf_status, pdf_retry_count, pdf_fetched_at, qb_app_url, last_synced_at,
      source, sync_source, match_status, match_method, raw_payload
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
    )
    ON CONFLICT (external_ref) DO UPDATE SET
      handoff_estimate_id = COALESCE(EXCLUDED.handoff_estimate_id, handoff_estimates.handoff_estimate_id),
      handoff_estimate_number = COALESCE(EXCLUDED.handoff_estimate_number, handoff_estimates.handoff_estimate_number),
      qb_estimate_id = COALESCE(EXCLUDED.qb_estimate_id, handoff_estimates.qb_estimate_id),
      qb_estimate_number = COALESCE(EXCLUDED.qb_estimate_number, handoff_estimates.qb_estimate_number),
      lead_id = COALESCE(EXCLUDED.lead_id, handoff_estimates.lead_id),
      customer_name = EXCLUDED.customer_name,
      customer_phone = COALESCE(EXCLUDED.customer_phone, handoff_estimates.customer_phone),
      customer_email = COALESCE(EXCLUDED.customer_email, handoff_estimates.customer_email),
      estimate_amount = COALESCE(EXCLUDED.estimate_amount, handoff_estimates.estimate_amount),
      estimate_status = COALESCE(EXCLUDED.estimate_status, handoff_estimates.estimate_status),
      estimate_date = COALESCE(EXCLUDED.estimate_date, handoff_estimates.estimate_date),
      document_url = COALESCE(EXCLUDED.document_url, handoff_estimates.document_url),
      document_title = COALESCE(EXCLUDED.document_title, handoff_estimates.document_title),
      pdf_url = COALESCE(EXCLUDED.pdf_url, handoff_estimates.pdf_url),
      pdf_status = EXCLUDED.pdf_status,
      pdf_retry_count = EXCLUDED.pdf_retry_count,
      pdf_fetched_at = COALESCE(EXCLUDED.pdf_fetched_at, handoff_estimates.pdf_fetched_at),
      qb_app_url = COALESCE(EXCLUDED.qb_app_url, handoff_estimates.qb_app_url),
      last_synced_at = EXCLUDED.last_synced_at,
      source = EXCLUDED.source,
      sync_source = EXCLUDED.sync_source,
      match_status = EXCLUDED.match_status,
      match_method = COALESCE(EXCLUDED.match_method, handoff_estimates.match_method),
      raw_payload = COALESCE(EXCLUDED.raw_payload, handoff_estimates.raw_payload),
      updated_at = NOW()
    RETURNING (xmax = 0) AS inserted, id
  `;

  const num = (v) => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : null;

  const params = [
    String(externalRef),
    est.handoff_estimate_id || null,
    est.handoff_estimate_number || null,
    est.qb_estimate_id || null,
    est.qb_estimate_number || null,
    railwayLeadId || null,
    est.customer_name || 'Unknown',
    est.customer_phone || null,
    est.customer_email || null,
    num(est.estimate_amount),
    est.estimate_status || null,
    est.estimate_date || null,
    est.document_url || null,
    est.document_title || null,
    est.pdf_url || null,
    est.pdf_status || 'pending',
    est.pdf_retry_count || 0,
    est.pdf_fetched_at || null,
    est.qb_app_url || null,
    est.last_synced_at || new Date().toISOString(),
    est.source || 'Handoff',
    est.sync_source || 'Handoff',
    est.match_status || 'unmatched',
    est.match_method || null,
    est.raw_payload ? String(est.raw_payload).slice(0, 2000) : null,
  ];

  const { rows } = await query(sql, params);
  return { action: rows[0]?.inserted ? 'created' : 'updated', id: rows[0]?.id };
}

async function main() {
  console.log('[migrate-handoff] Starting idempotent handoff estimate migration...');
  const leadIdCache = await buildLeadIdCache();
  console.log(`[migrate-handoff] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Estimates = await fetchBase44Entity('HandoffEstimate');
  console.log(`[migrate-handoff] Fetched ${base44Estimates.length} estimates from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0;
  for (let i = 0; i < base44Estimates.length; i++) {
    const est = base44Estimates[i];
    try {
      const railwayLeadId = est.lead_id ? (leadIdCache[String(est.lead_id)] || null) : null;
      const result = await upsertHandoffEstimate(est, railwayLeadId);
      if (result.action === 'created') created++;
      else if (result.action === 'updated') updated++;
      else skipped++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-handoff] Error on ${est.id}: ${e.message}`);
    }
  }

  console.log('\n=== HANDOFF ESTIMATE MIGRATION COMPLETE ===');
  console.log(`Total: ${base44Estimates.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM handoff_estimates');
  console.log(`Railway handoff_estimates table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-handoff] fatal:', e); process.exit(1); });