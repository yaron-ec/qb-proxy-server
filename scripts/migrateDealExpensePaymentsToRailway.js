/* eslint-disable no-undef */
'use strict';
/**
 * migrateDealExpensePaymentsToRailway.js — Idempotent deal expense payment migration.
 *
 * PREREQUISITE: migrateDealsToRailway.js AND migrateSmallDatasetsToRailway.js
 * (deal_expense_payments.deal_id FK → deals, .expense_id FK → deal_expenses)
 */
const { query } = require('../db/client');
const { fetchBase44Entity, buildDealIdCache, buildExpenseIdCache, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-dep] Starting deal expense payment migration...');
  if (!hasBase44Creds()) { console.error('[migrate-dep] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const [dealIdCache, expenseIdCache] = await Promise.all([buildDealIdCache(), buildExpenseIdCache()]);
  console.log(`[migrate-dep] Loaded ${Object.keys(dealIdCache).length} deal, ${Object.keys(expenseIdCache).length} expense mappings`);

  const base44Items = await fetchBase44Entity('DealExpensePayment');
  console.log(`[migrate-dep] Fetched ${base44Items.length} deal expense payments from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, dealNotFound = 0, expenseNotFound = 0;
  for (const item of base44Items) {
    try {
      const externalRef = item.id;
      if (!externalRef) { skipped++; continue; }
      const railwayDealId = item.deal_id ? (dealIdCache[String(item.deal_id)] || null) : null;
      const railwayExpenseId = item.expense_id ? (expenseIdCache[String(item.expense_id)] || null) : null;
      if (item.deal_id && !railwayDealId) dealNotFound++;
      if (item.expense_id && !railwayExpenseId) expenseNotFound++;
      if (!railwayDealId || !railwayExpenseId) { skipped++; continue; }

      const num = (v) => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : 0;
      const { rows } = await query(`
        INSERT INTO deal_expense_payments (
          external_ref, deal_id, expense_id, payment_date, amount, payment_method,
          reference_number, receipt_url, receipt_key, receipt_filename, notes, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (external_ref) DO UPDATE SET
          deal_id = EXCLUDED.deal_id,
          expense_id = EXCLUDED.expense_id,
          payment_date = COALESCE(EXCLUDED.payment_date, deal_expense_payments.payment_date),
          amount = EXCLUDED.amount,
          payment_method = COALESCE(EXCLUDED.payment_method, deal_expense_payments.payment_method),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef), railwayDealId, railwayExpenseId,
        item.payment_date || null, num(item.amount), item.payment_method || null,
        item.reference_number || null, item.receipt_url || null,
        item.receipt_key || null, item.receipt_filename || null,
        item.notes || null, item.created_by || null, item.updated_by || null,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-dep] Error on ${item.id}: ${e.message}`);
    }
  }

  console.log(`\n=== DEAL EXPENSE PAYMENT MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Items.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable deal_id: ${dealNotFound}, expense_id: ${expenseNotFound}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM deal_expense_payments');
  console.log(`Railway deal_expense_payments table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-dep] fatal:', e); process.exit(1); });