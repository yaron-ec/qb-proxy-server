/* eslint-disable no-undef */
'use strict';
/**
 * migrateLeadSubmissionsToRailway.js — Idempotent lead submission migration.
 *
 * PREREQUISITE: migrateLeadsToRailway.js (lead_submissions.lead_id FK → leads).
 *
 * IMPORT-SAFE: Exports runLeadSubmissionMigration(queryFn) for use by rollback
 * validators. main() is guarded by require.main === module.
 *
 * Idempotent: ON CONFLICT (external_ref) DO UPDATE.
 */
const { query: defaultQuery } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, hasBase44Creds } = require('./migrationHelpers');

/**
 * Run the lead submission migration.
 * @param {Function} queryFn - optional query function (defaults to direct query).
 *        Pass a transaction-bound queryFn for rollback validation.
 * @returns {Promise<{total, created, updated, skipped, errors, leadNotFound, finalCount}>}
 */
async function runLeadSubmissionMigration(queryFn) {
  const query = queryFn || defaultQuery;
  console.log('[migrate-submissions] Starting lead submission migration...');
  if (!hasBase44Creds()) {
    throw new Error('[migrate-submissions] WORKER_SECRET required for migration reader');
  }

  const leadIdCache = await buildLeadIdCache(query);
  console.log(`[migrate-submissions] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Items = await fetchBase44Entity('LeadSubmission');
  console.log(`[migrate-submissions] Fetched ${base44Items.length} submissions from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0;

  for (const item of base44Items) {
    try {
      const externalRef = item.id;
      if (!externalRef) { skipped++; continue; }
      const railwayLeadId = item.lead_id ? (leadIdCache[String(item.lead_id)] || null) : null;
      if (item.lead_id && !railwayLeadId) leadNotFound++;
      if (!railwayLeadId) { skipped++; continue; }

      const { rows } = await query(`
        INSERT INTO lead_submissions (
          external_ref, lead_id, submitted_at, source, form_type, project_type,
          message, assigned_rep_at_time, lead_status_at_time, submission_number,
          was_reactivation, previous_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (external_ref) DO UPDATE SET
          lead_id = EXCLUDED.lead_id,
          submitted_at = EXCLUDED.submitted_at,
          source = COALESCE(EXCLUDED.source, lead_submissions.source),
          form_type = COALESCE(EXCLUDED.form_type, lead_submissions.form_type),
          project_type = COALESCE(EXCLUDED.project_type, lead_submissions.project_type),
          message = COALESCE(EXCLUDED.message, lead_submissions.message),
          assigned_rep_at_time = COALESCE(EXCLUDED.assigned_rep_at_time, lead_submissions.assigned_rep_at_time),
          lead_status_at_time = COALESCE(EXCLUDED.lead_status_at_time, lead_submissions.lead_status_at_time),
          submission_number = COALESCE(EXCLUDED.submission_number, lead_submissions.submission_number),
          was_reactivation = EXCLUDED.was_reactivation,
          previous_status = COALESCE(EXCLUDED.previous_status, lead_submissions.previous_status),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef), railwayLeadId,
        item.submitted_at || item.created_date || new Date().toISOString(),
        item.source || null, item.form_type || null, item.project_type || null,
        item.message || null, item.assigned_rep_at_time || null,
        item.lead_status_at_time || null, item.submission_number || 1,
        item.was_reactivation === true, item.previous_status || null,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-submissions] Error on ${item.id}: ${e.message}`);
    }
  }

  let finalCount = null;
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM lead_submissions');
    finalCount = parseInt(rows[0].cnt, 10);
  } catch (e) {
    console.error('[migrate-submissions] Could not get final count:', e.message);
  }

  const result = {
    total: base44Items.length, created, updated, skipped, errors, leadNotFound, finalCount,
  };
  console.log(`\n=== LEAD SUBMISSION MIGRATION COMPLETE ===`);
  console.log(`Total: ${result.total}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable lead_id: ${leadNotFound}`);
  if (finalCount !== null) console.log(`Railway lead_submissions table now has: ${finalCount} rows`);
  return result;
}

module.exports = { runLeadSubmissionMigration };

if (require.main === module) {
  runLeadSubmissionMigration()
    .then(() => process.exit(0))
    .catch(e => { console.error('[migrate-submissions] fatal:', e); process.exit(1); });
}