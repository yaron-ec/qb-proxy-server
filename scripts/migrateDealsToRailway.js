/* eslint-disable no-undef */
/**
 * migrateDealsToRailway.js — Idempotent deal migration from Base44 to Railway.
 *
 * PREREQUISITE: Run migrateLeadsToRailway.js FIRST. Deals have a NOT NULL FK
 * constraint on leads(id) — the Base44 lead_id must be resolved to a Railway
 * leads.id via external_ref before insertion. Deals with unresolvable lead_id
 * are SKIPPED and reported (no Railway Deal row is created).
 *
 * Run on Railway: node scripts/migrateDealsToRailway.js
 *
 * Reads ALL deals from Base44 (via REST API) and upserts them into the
 * Railway `deals` table with legacy_base44_id = Base44 deal ID.
 *
 * Maps:
 *   Base44 Deal.id           → deals.legacy_base44_id (migration metadata)
 *   Base44 Deal.lead_id      → resolved to Railway leads.id via external_ref
 *   Base44 Deal.*             → deals.* (direct column mapping)
 *
 * STAGE NORMALIZATION:
 *   Base44 contains legacy stage values not in the Railway CHECK constraint:
 *     'Contract Signed' → 'Sold / Estimate Approved'
 *     'Completed'       → 'Job Completed'
 *     'Closed Won'      → 'Sold / Estimate Approved'
 *   Unknown stages default to 'Sold / Estimate Approved'.
 *
 * IDEMPOTENT: YES (ON CONFLICT (legacy_base44_id) DO UPDATE).
 * SAFE TO RE-RUN: YES. CAN CREATE DUPLICATES: NO.
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */
'use strict';

const { query: defaultQuery } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');

// Railway deals.stage CHECK constraint allows only these values.
const ALLOWED_STAGES = new Set([
  'Sold / Estimate Approved', 'Deposit Due', 'Deposit Paid', 'Work Scheduled',
  'Work Started', 'Progress Payment Due', 'Progress Payment Paid',
  'Final Payment Due', 'Final Payment Paid', 'Job Completed',
]);

// Legacy Base44 stage values → Railway-canonical stage values.
const STAGE_MAP = {
  'Contract Signed': 'Sold / Estimate Approved',
  'Completed': 'Job Completed',
  'Closed Won': 'Sold / Estimate Approved',
};

function normalizeStage(stage) {
  if (!stage) return null; // unknown — fail closed, do not default
  if (STAGE_MAP[stage]) return STAGE_MAP[stage];
  if (ALLOWED_STAGES.has(stage)) return stage;
  return null; // unknown — fail closed, do not default
}

// ── Upsert a single deal ─────────────────────────────────────────────────────
async function upsertDeal(deal, railwayLeadId, queryFn) {
  const legacyBase44Id = deal.id;
  if (!legacyBase44Id) return { action: 'skipped', reason: 'no_id' };
  if (!railwayLeadId) return { action: 'skipped', reason: 'lead_not_found' };

  const normalizedStage = normalizeStage(deal.stage);
  if (!normalizedStage) {
    return { action: 'skipped', reason: 'unresolved_stage', originalStage: deal.stage || '(null)' };
  }

  const sql = `
    INSERT INTO deals (
      lead_id, legacy_base44_id, legacy_base44_lead_id, name, amount, stage,
      pipeline, close_date, sold_date, work_start_date, work_end_date,
      description, notes, project_type, property_address, assigned_rep,
      deposit_amount, deposit_paid, deposit_paid_date,
      progress_payment_amount, progress_payment_paid, progress_payment_paid_date,
      final_payment_amount, final_payment_paid, final_payment_paid_date,
      contract_amount, total_paid, balance_due, paid_percentage, payment_status,
      stage_override, financial_change_orders_amount, financial_manual_revenue_adjustment,
      financial_revenue_source, financial_other_costs_amount,
      lead_cost_type, lead_cost_percentage, lead_cost_fixed_amount,
      lead_cost_calculation_base, lead_cost_custom_base_amount, lead_cost_amount,
      lead_cost_notes, company_share_amount
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16,
      $17, $18, $19,
      $20, $21, $22,
      $23, $24, $25,
      $26, $27, $28, $29, $30,
      $31, $32, $33,
      $34, $35,
      $36, $37, $38,
      $39, $40, $41,
      $42, $43
    )
    ON CONFLICT (legacy_base44_id) WHERE legacy_base44_id IS NOT NULL DO UPDATE SET
      lead_id = EXCLUDED.lead_id,
      name = EXCLUDED.name,
      amount = COALESCE(EXCLUDED.amount, deals.amount),
      stage = EXCLUDED.stage,
      pipeline = EXCLUDED.pipeline,
      close_date = COALESCE(EXCLUDED.close_date, deals.close_date),
      sold_date = COALESCE(EXCLUDED.sold_date, deals.sold_date),
      work_start_date = COALESCE(EXCLUDED.work_start_date, deals.work_start_date),
      work_end_date = COALESCE(EXCLUDED.work_end_date, deals.work_end_date),
      description = COALESCE(EXCLUDED.description, deals.description),
      notes = COALESCE(EXCLUDED.notes, deals.notes),
      project_type = COALESCE(EXCLUDED.project_type, deals.project_type),
      property_address = COALESCE(EXCLUDED.property_address, deals.property_address),
      assigned_rep = COALESCE(EXCLUDED.assigned_rep, deals.assigned_rep),
      deposit_amount = EXCLUDED.deposit_amount,
      deposit_paid = EXCLUDED.deposit_paid,
      deposit_paid_date = COALESCE(EXCLUDED.deposit_paid_date, deals.deposit_paid_date),
      progress_payment_amount = EXCLUDED.progress_payment_amount,
      progress_payment_paid = EXCLUDED.progress_payment_paid,
      progress_payment_paid_date = COALESCE(EXCLUDED.progress_payment_paid_date, deals.progress_payment_paid_date),
      final_payment_amount = EXCLUDED.final_payment_amount,
      final_payment_paid = EXCLUDED.final_payment_paid,
      final_payment_paid_date = COALESCE(EXCLUDED.final_payment_paid_date, deals.final_payment_paid_date),
      contract_amount = COALESCE(EXCLUDED.contract_amount, deals.contract_amount),
      total_paid = EXCLUDED.total_paid,
      balance_due = EXCLUDED.balance_due,
      paid_percentage = EXCLUDED.paid_percentage,
      payment_status = EXCLUDED.payment_status,
      stage_override = EXCLUDED.stage_override,
      financial_change_orders_amount = EXCLUDED.financial_change_orders_amount,
      financial_manual_revenue_adjustment = EXCLUDED.financial_manual_revenue_adjustment,
      financial_revenue_source = EXCLUDED.financial_revenue_source,
      financial_other_costs_amount = EXCLUDED.financial_other_costs_amount,
      lead_cost_type = EXCLUDED.lead_cost_type,
      lead_cost_percentage = EXCLUDED.lead_cost_percentage,
      lead_cost_fixed_amount = EXCLUDED.lead_cost_fixed_amount,
      lead_cost_calculation_base = EXCLUDED.lead_cost_calculation_base,
      lead_cost_custom_base_amount = EXCLUDED.lead_cost_custom_base_amount,
      lead_cost_amount = EXCLUDED.lead_cost_amount,
      lead_cost_notes = COALESCE(EXCLUDED.lead_cost_notes, deals.lead_cost_notes),
      company_share_amount = EXCLUDED.company_share_amount,
      updated_at = NOW()
    RETURNING (xmax = 0) AS inserted, id
  `;

  const num = (v) => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : 0;
  const bool = (v) => v === true;
  const date = (v) => v || null;
  const ts = (v) => v || null;

  const params = [
    railwayLeadId,                                            // $1 lead_id
    String(legacyBase44Id),                                   // $2 legacy_base44_id
    String(deal.lead_id || ''),                               // $3 legacy_base44_lead_id
    deal.name || 'Unnamed Deal',                              // $4 name
    deal.amount !== undefined ? num(deal.amount) : null,      // $5 amount
    normalizedStage,                                          // $6 stage (NORMALIZED, fail-closed)
    deal.pipeline || 'Default Pipeline',                     // $7 pipeline
    date(deal.close_date),                                     // $8 close_date
    ts(deal.sold_date),                                        // $9 sold_date
    date(deal.work_start_date),                                // $10 work_start_date
    date(deal.work_end_date),                                  // $11 work_end_date
    deal.description || null,                                 // $12 description
    deal.notes || null,                                        // $13 notes
    deal.project_type || null,                                 // $14 project_type
    deal.property_address || null,                             // $15 property_address
    deal.assigned_rep || null,                                 // $16 assigned_rep
    num(deal.deposit_amount),                                  // $17 deposit_amount
    num(deal.deposit_paid),                                    // $18 deposit_paid
    date(deal.deposit_paid_date),                              // $19 deposit_paid_date
    num(deal.progress_payment_amount),                        // $20 progress_payment_amount
    num(deal.progress_payment_paid),                           // $21 progress_payment_paid
    date(deal.progress_payment_paid_date),                     // $22 progress_payment_paid_date
    num(deal.final_payment_amount),                            // $23 final_payment_amount
    num(deal.final_payment_paid),                              // $24 final_payment_paid
    date(deal.final_payment_paid_date),                        // $25 final_payment_paid_date
    deal.contract_amount !== undefined ? num(deal.contract_amount) : null, // $26 contract_amount
    num(deal.total_paid),                                      // $27 total_paid
    num(deal.balance_due),                                     // $28 balance_due
    num(deal.paid_percentage),                                 // $29 paid_percentage
    deal.payment_status || 'unpaid',                           // $30 payment_status
    bool(deal.stage_override),                                 // $31 stage_override
    num(deal.financial_change_orders_amount),                  // $32 financial_change_orders_amount
    num(deal.financial_manual_revenue_adjustment),             // $33 financial_manual_revenue_adjustment
    deal.financial_revenue_source || 'quickbooks',             // $34 financial_revenue_source
    num(deal.financial_other_costs_amount),                    // $35 financial_other_costs_amount
    deal.lead_cost_type || 'percentage',                       // $36 lead_cost_type
    num(deal.lead_cost_percentage),                            // $37 lead_cost_percentage
    num(deal.lead_cost_fixed_amount),                          // $38 lead_cost_fixed_amount
    deal.lead_cost_calculation_base || 'total_contract',       // $39 lead_cost_calculation_base
    num(deal.lead_cost_custom_base_amount),                    // $40 lead_cost_custom_base_amount
    num(deal.lead_cost_amount),                                // $41 lead_cost_amount
    deal.lead_cost_notes || null,                              // $42 lead_cost_notes
    num(deal.company_share_amount),                            // $43 company_share_amount
  ];

  const { rows } = await queryFn(sql, params);
  const inserted = !!(rows[0] && rows[0].inserted);
  return { action: inserted ? 'created' : 'updated', id: rows[0]?.id };
}

// ── Main migration (exported for rollback validation) ──────────────────────
async function runDealMigration(queryFn = defaultQuery) {
  console.log('[migrate-deals] Starting idempotent deal migration...');

  const leadIdCache = await buildLeadIdCache(queryFn);
  console.log(`[migrate-deals] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Deals = await fetchBase44Entity('Deal');
  console.log(`[migrate-deals] Fetched ${base44Deals.length} deals from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0;
  let unresolvedStageCount = 0;
  const stageNormalizations = {};
  const unresolvedStages = {};

  for (let i = 0; i < base44Deals.length; i++) {
    const deal = base44Deals[i];
    try {
      const railwayLeadId = leadIdCache[String(deal.lead_id)] || null;
      if (!railwayLeadId) leadNotFound++;

      // Track stage normalizations (only for resolvable stages)
      const originalStage = deal.stage || '(null)';
      const normalizedStageValue = normalizeStage(deal.stage);
      if (normalizedStageValue && originalStage !== normalizedStageValue) {
        stageNormalizations[`${originalStage} → ${normalizedStageValue}`] =
          (stageNormalizations[`${originalStage} → ${normalizedStageValue}`] || 0) + 1;
      }

      const result = await upsertDeal(deal, railwayLeadId, queryFn);
      if (result.action === 'created') created++;
      else if (result.action === 'updated') updated++;
      else if (result.action === 'skipped' && result.reason === 'unresolved_stage') {
        unresolvedStageCount++;
        unresolvedStages[result.originalStage] = (unresolvedStages[result.originalStage] || 0) + 1;
      } else skipped++;

      if ((i + 1) % 50 === 0) {
        console.log(`[migrate-deals] Progress: ${i + 1}/${base44Deals.length} (created=${created} updated=${updated})`);
      }
    } catch (e) {
      errors++;
      console.error(`[migrate-deals] Error on deal ${deal.id}: ${e.message}`);
    }
  }

  console.log('\n=== DEAL MIGRATION COMPLETE ===');
  console.log(`Total Base44 deals: ${base44Deals.length}`);
  console.log(`Created: ${created}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Deals with unresolvable lead_id: ${leadNotFound}`);
  if (Object.keys(stageNormalizations).length > 0) {
    console.log('Stage normalizations:');
    for (const [mapping, count] of Object.entries(stageNormalizations)) {
      console.log(`  ${mapping}: ${count} record(s)`);
    }
  }

  if (unresolvedStageCount > 0) {
    console.error(`\n❌ ${unresolvedStageCount} deal(s) have UNKNOWN stage values — FAILING CLOSED`);
    console.error('   Unresolved stage values:');
    for (const [stage, count] of Object.entries(unresolvedStages)) {
      console.error(`     '${stage}': ${count} record(s)`);
    }
    console.error('   No deals were inserted with unknown stages. Fix the source data or extend STAGE_MAP.');
    throw new Error(`${unresolvedStageCount} deal(s) with unknown stage values — migration failed closed`);
  }

  const { rows } = await queryFn('SELECT COUNT(*) as cnt FROM deals');
  console.log(`Railway deals table now has: ${rows[0].cnt} rows`);

  return { created, updated, skipped, errors, leadNotFound, unresolvedStageCount, unresolvedStages, stageNormalizations, total: base44Deals.length };
}

module.exports = { runDealMigration, normalizeStage };

if (require.main === module) {
  if (!hasBase44Creds()) {
    console.error('[migrate-deals] BASE44_APP_ID and BASE44_API_KEY required');
    process.exit(1);
  }
  runDealMigration().then(() => process.exit(0)).catch(e => {
    console.error('[migrate-deals] fatal:', e);
    process.exit(1);
  });
}