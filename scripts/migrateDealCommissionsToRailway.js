/* eslint-disable no-undef */
'use strict';
/**
 * migrateDealCommissionsToRailway.js — Idempotent deal commission migration.
 *
 * PREREQUISITE: migrateLeadsToRailway.js AND migrateDealsToRailway.js.
 */
const { query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, buildDealIdCache, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-commissions] Starting deal commission migration...');
  if (!hasBase44Creds()) { console.error('[migrate-commissions] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const [leadIdCache, dealIdCache] = await Promise.all([buildLeadIdCache(), buildDealIdCache()]);
  console.log(`[migrate-commissions] Loaded ${Object.keys(leadIdCache).length} lead, ${Object.keys(dealIdCache).length} deal mappings`);

  const base44Items = await fetchBase44Entity('DealCommission');
  console.log(`[migrate-commissions] Fetched ${base44Items.length} commissions from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, dealNotFound = 0;
  for (const item of base44Items) {
    try {
      const externalRef = item.id;
      if (!externalRef) { skipped++; continue; }
      const railwayDealId = item.deal_id ? (dealIdCache[String(item.deal_id)] || null) : null;
      const railwayLeadId = item.lead_id ? (leadIdCache[String(item.lead_id)] || null) : null;
      if (item.deal_id && !railwayDealId) dealNotFound++;
      if (!railwayDealId) { skipped++; continue; }

      const num = (v) => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : 0;
      const { rows } = await query(`
        INSERT INTO deal_commissions (
          external_ref, deal_id, lead_id, recipient_user_id, recipient_name,
          commission_type, commission_percentage, commission_fixed_amount,
          calculation_base, custom_base_amount, calculated_amount, paid_amount,
          status, paid_date, notes, receipt_url, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (external_ref) DO UPDATE SET
          deal_id = EXCLUDED.deal_id,
          lead_id = COALESCE(EXCLUDED.lead_id, deal_commissions.lead_id),
          recipient_name = EXCLUDED.recipient_name,
          commission_type = EXCLUDED.commission_type,
          commission_percentage = EXCLUDED.commission_percentage,
          commission_fixed_amount = EXCLUDED.commission_fixed_amount,
          calculated_amount = EXCLUDED.calculated_amount,
          paid_amount = EXCLUDED.paid_amount,
          status = EXCLUDED.status,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef), railwayDealId, railwayLeadId,
        item.recipient_user_id || null, item.recipient_name || 'Unknown',
        item.commission_type || 'percentage', num(item.commission_percentage),
        num(item.commission_fixed_amount), item.calculation_base || 'total_contract',
        num(item.custom_base_amount), num(item.calculated_amount), num(item.paid_amount),
        item.status || 'Estimated', item.paid_date || null,
        item.notes || null, item.receipt_url || null,
        item.created_by || null, item.updated_by || null,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-commissions] Error on ${item.id}: ${e.message}`);
    }
  }

  console.log(`\n=== DEAL COMMISSION MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Items.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable deal_id: ${dealNotFound}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM deal_commissions');
  console.log(`Railway deal_commissions table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-commissions] fatal:', e); process.exit(1); });