/* eslint-disable no-undef */
'use strict';
/**
 * migrateDealLoanPaymentsToRailway.js — Idempotent deal loan payment migration.
 *
 * PREREQUISITE: migrateLeadsToRailway.js AND migrateDealsToRailway.js.
 */
const { query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, buildDealIdCache, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-dlp] Starting deal loan payment migration...');
  if (!hasBase44Creds()) { console.error('[migrate-dlp] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const [leadIdCache, dealIdCache] = await Promise.all([buildLeadIdCache(), buildDealIdCache()]);
  console.log(`[migrate-dlp] Loaded ${Object.keys(leadIdCache).length} lead, ${Object.keys(dealIdCache).length} deal mappings`);

  const base44Items = await fetchBase44Entity('DealLoanPayment');
  console.log(`[migrate-dlp] Fetched ${base44Items.length} loan payments from Base44`);

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
        INSERT INTO deal_loan_payments (
          external_ref, deal_id, lead_id, payment_date, lender_name, loan_account_name,
          total_payment_amount, principal_amount, interest_amount, fee_amount,
          other_cost_amount, reference_number, receipt_url, receipt_key,
          receipt_filename, notes, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (external_ref) DO UPDATE SET
          deal_id = EXCLUDED.deal_id,
          lead_id = COALESCE(EXCLUDED.lead_id, deal_loan_payments.lead_id),
          payment_date = EXCLUDED.payment_date,
          lender_name = COALESCE(EXCLUDED.lender_name, deal_loan_payments.lender_name),
          total_payment_amount = EXCLUDED.total_payment_amount,
          principal_amount = EXCLUDED.principal_amount,
          interest_amount = EXCLUDED.interest_amount,
          fee_amount = EXCLUDED.fee_amount,
          other_cost_amount = EXCLUDED.other_cost_amount,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef), railwayDealId, railwayLeadId,
        item.payment_date || null, item.lender_name || null, item.loan_account_name || null,
        num(item.total_payment_amount), num(item.principal_amount), num(item.interest_amount),
        num(item.fee_amount), num(item.other_cost_amount),
        item.reference_number || null, item.receipt_url || null,
        item.receipt_key || null, item.receipt_filename || null,
        item.notes || null, item.created_by || null, item.updated_by || null,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-dlp] Error on ${item.id}: ${e.message}`);
    }
  }

  console.log(`\n=== DEAL LOAN PAYMENT MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Items.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable deal_id: ${dealNotFound}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM deal_loan_payments');
  console.log(`Railway deal_loan_payments table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-dlp] fatal:', e); process.exit(1); });