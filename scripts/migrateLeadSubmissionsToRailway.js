/* eslint-disable no-undef */
'use strict';
/**
 * migrateLeadSubmissionsToRailway.js — Idempotent lead submission migration.
 *
 * PREREQUISITE: migrateLeadsToRailway.js (lead_submissions.lead_id FK → leads).
 */
const { query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-submissions] Starting lead submission migration...');
  if (!hasBase44Creds()) { console.error('[migrate-submissions] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const leadIdCache = await buildLeadIdCache();
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

  console.log(`\n=== LEAD SUBMISSION MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Items.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable lead_id: ${leadNotFound}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM lead_submissions');
  console.log(`Railway lead_submissions table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-submissions] fatal:', e); process.exit(1); });