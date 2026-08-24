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
 * IDEMPOTENT: YES (ON CONFLICT (legacy_base44_id) DO UPDATE).
 * SAFE TO RE-RUN: YES. CAN CREATE DUPLICATES: NO.
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */
'use strict';

const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');

if (!hasBase44Creds()) {
  console.error('[migrate-deals] BASE44_APP_ID and BASE44_API_KEY required');
  process.exit(1);
}

// ── Upsert a single deal ─────────────────────────────────────────────────────
async function upsertDeal(deal, railwayLeadId) {
  const legacyBase44Id = deal.id;
  if (!legacyBase44Id) return { action: 'skipped', reason: 'no_id' };
  if (!railwayLeadId) return { action: 'skipped', reason: 'lead_not_found' };

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
    deal.stage || 'Sold / Estimate Approved',                 // $6 stage
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

  const { rows } = await query(sql, params);
  const inserted = !!(rows[0] && rows[0].inserted);
  return { action: inserted ? 'created' : 'updated', id: rows[0]?.id };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[migrate-deals] Starting idempotent deal migration...');

  const leadIdCache = await buildLeadIdCache();
  console.log(`[migrate-deals] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Deals = await fetchBase44Entity('Deal');
  console.log(`[migrate-deals] Fetched ${base44Deals.length} deals from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0;

  for (let i = 0; i < base44Deals.length; i++) {
    const deal = base44Deals[i];
    try {
      const railwayLeadId = leadIdCache[String(deal.lead_id)] || null;
      if (!railwayLeadId) leadNotFound++;

      const result = await upsertDeal(deal, railwayLeadId);
      if (result.action === 'created') created++;
      else if (result.action === 'updated') updated++;
      else skipped++;

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

  const { rows } = await query('SELECT COUNT(*) as cnt FROM deals');
  console.log(`Railway deals table now has: ${rows[0].cnt} rows`);

  process.exit(0);
}

main().catch(e => {
  console.error('[migrate-deals] fatal:', e);
  process.exit(1);
});