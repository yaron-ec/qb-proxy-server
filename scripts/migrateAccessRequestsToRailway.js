/* eslint-disable no-undef */
'use strict';
/**
 * migrateAccessRequestsToRailway.js — Idempotent access request migration.
 *
 * No FK prerequisites. Access requests are standalone records.
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-access] Starting access request migration...');
  if (!hasBase44Creds()) { console.error('[migrate-access] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const base44Items = await fetchBase44Entity('AccessRequest');
  console.log(`[migrate-access] Fetched ${base44Items.length} access requests from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0;
  for (const item of base44Items) {
    try {
      const externalRef = item.id;
      if (!externalRef) { skipped++; continue; }
      if (!item.email) { skipped++; continue; }

      const { rows } = await query(`
        INSERT INTO access_requests (external_ref, email, name, reason, status, reviewed_by, reviewed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (external_ref) DO UPDATE SET
          email = EXCLUDED.email,
          name = COALESCE(EXCLUDED.name, access_requests.name),
          reason = COALESCE(EXCLUDED.reason, access_requests.reason),
          status = EXCLUDED.status,
          reviewed_by = COALESCE(EXCLUDED.reviewed_by, access_requests.reviewed_by),
          reviewed_at = COALESCE(EXCLUDED.reviewed_at, access_requests.reviewed_at),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef),
        item.email,
        item.full_name || null,
        item.reason || null,
        item.status || 'pending',
        item.reviewed_by || null,
        item.reviewed_at || null,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-access] Error on ${item.id}: ${e.message}`);
    }
  }

  console.log(`\n=== ACCESS REQUEST MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Items.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM access_requests');
  console.log(`Railway access_requests table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-access] fatal:', e); process.exit(1); });