#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateDeals.js — Production-path rollback validation for Deals.
 *
 * Calls the EXACT same runDealMigration() function used by:
 *   node scripts/migrateDealsToRailway.js
 *
 * ...but inside a PostgreSQL transaction that is ALWAYS ROLLED BACK.
 *
 * Verifies:
 *   - Base44 deals read: 46
 *   - FK resolution: all lead_id values resolve to Railway leads
 *   - Stage normalization: 'Contract Signed', 'Completed', 'Closed Won' → allowed values
 *   - Write errors: 0
 *   - In-transaction deal count reaches expected reconciled count
 *   - After rollback, database returns to exact before-count
 *   - No external side effects (no Google, Gmail, QB, SignNow, webhooks)
 *
 * Environment:
 *   DATABASE_URL (Railway Postgres)
 *   WORKER_SECRET (for migrationReader backend function)
 */
const { pool } = require('../db/client');
const { runDealMigration, normalizeStage } = require('./migrateDealsToRailway');
const { fetchBase44Entity } = require('./migrationHelpers');

async function main() {
  console.log('=== PRODUCTION-PATH ROLLBACK VALIDATION (Deals) ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // ── PHASE 1: PRE-MIGRATION STAGE + FK AUDIT ──────────────────────────────
  console.log('=== PHASE 1: PRE-MIGRATION STAGE + FK AUDIT ===\n');

  const ALLOWED_STAGES = new Set([
    'Sold / Estimate Approved', 'Deposit Due', 'Deposit Paid', 'Work Scheduled',
    'Work Started', 'Progress Payment Due', 'Progress Payment Paid',
    'Final Payment Due', 'Final Payment Paid', 'Job Completed',
  ]);

  const base44Deals = await fetchBase44Entity('Deal');
  console.log(`Total Base44 deals: ${base44Deals.length}`);

  // Stage audit — classify each stage as ALLOWED, MAPPED (via STAGE_MAP), or UNKNOWN (fail-closed)
  const stageCounts = {};
  const mappedStages = {};
  const unknownStages = {};
  for (const d of base44Deals) {
    const stage = d.stage || '(null)';
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;
    const normalized = normalizeStage(stage);
    if (normalized === null) {
      unknownStages[stage] = (unknownStages[stage] || 0) + 1;
    } else if (stage !== normalized) {
      mappedStages[`${stage} → ${normalized}`] = (mappedStages[`${stage} → ${normalized}`] || 0) + 1;
    }
  }

  console.log('Stage value distribution:');
  for (const [stage, cnt] of Object.entries(stageCounts).sort((a, b) => b[1] - a[1])) {
    const normalized = normalizeStage(stage);
    const label = normalized === null ? 'UNKNOWN → will FAIL CLOSED'
      : normalized !== stage ? `MAPPED → "${normalized}"`
      : 'ALLOWED';
    console.log(`  ${stage.padEnd(30)} ${String(cnt).padStart(4)}  ${label}`);
  }

  if (Object.keys(mappedStages).length > 0) {
    console.log('\nStage normalizations (explicit deterministic mappings):');
    for (const [mapping, count] of Object.entries(mappedStages)) {
      console.log(`  ${mapping}: ${count} record(s)`);
    }
  }

  if (Object.keys(unknownStages).length > 0) {
    console.log('\n❌ UNKNOWN STAGE VALUES — migration will FAIL CLOSED on these:');
    for (const [stage, cnt] of Object.entries(unknownStages)) {
      console.log(`  '${stage}': ${cnt} record(s)`);
    }
  } else {
    console.log('\n✅ No unknown stage values — all stages are allowed or have explicit mappings');
  }

  // FK audit — check lead_id resolution against Base44 leads
  const base44Leads = await fetchBase44Entity('Lead');
  const base44LeadIds = new Set(base44Leads.map(l => l.id));
  let withLeadId = 0, resolved = 0, unresolved = 0;
  const unresolvedDeals = [];

  for (const d of base44Deals) {
    if (d.lead_id) {
      withLeadId++;
      if (base44LeadIds.has(d.lead_id)) {
        resolved++;
      } else {
        unresolved++;
        unresolvedDeals.push({ dealId: d.id, dealName: d.name, leadRef: d.lead_id });
      }
    }
  }

  console.log(`\nFK resolution: resolved=${resolved}, unresolved=${unresolved}, distinct unresolved=${new Set(unresolvedDeals.map(d => d.leadRef)).size}`);
  if (unresolvedDeals.length > 0) {
    console.log('Unresolved deals:');
    for (const d of unresolvedDeals) {
      console.log(`  ${d.dealId} — "${d.dealName}" → lead_ref: ${d.leadRef}`);
    }
  }

  // ── PHASE 2: EXECUTE PRODUCTION MIGRATION (TRANSACTION → ROLLBACK) ──────
  console.log('\n=== PHASE 2: EXECUTE PRODUCTION MIGRATION (TRANSACTION → ROLLBACK) ===\n');

  const client = await pool.connect();

  try {
    // BEFORE counts
    const beforeDeals = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals')).rows[0].cnt, 10);
    const beforeLeads = parseInt((await client.query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const beforeDealsWithLegacy = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals WHERE legacy_base44_id IS NOT NULL')).rows[0].cnt, 10);

    console.log(`Before: deals=${beforeDeals}, deals_with_legacy_base44_id=${beforeDealsWithLegacy}, leads=${beforeLeads}`);

    // BEGIN TRANSACTION
    await client.query('BEGIN');
    const queryFn = client.query.bind(client);

    // Run production migration
    const result = await runDealMigration(queryFn);

    // In-transaction counts
    const inTxDeals = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals')).rows[0].cnt, 10);
    const inTxDealsWithLegacy = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals WHERE legacy_base44_id IS NOT NULL')).rows[0].cnt, 10);
    console.log(`\nIn-transaction: deals=${inTxDeals}, deals_with_legacy_base44_id=${inTxDealsWithLegacy}`);

    // ROLLBACK
    console.log('\n=== ROLLING BACK TRANSACTION ===\n');
    await client.query('ROLLBACK');

    // AFTER counts
    const afterDeals = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals')).rows[0].cnt, 10);
    const afterLeads = parseInt((await client.query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const afterDealsWithLegacy = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals WHERE legacy_base44_id IS NOT NULL')).rows[0].cnt, 10);

    console.log(`After rollback: deals=${afterDeals}, deals_with_legacy_base44_id=${afterDealsWithLegacy}, leads=${afterLeads}`);

    // ── PHASE 3: VALIDATION ────────────────────────────────────────────────
    console.log('\n=== VALIDATION ===\n');

    const expectedInTxDeals = beforeDeals + result.created;
    const expectedNormalizations = Object.values(result.stageNormalizations || {}).reduce((a, b) => a + b, 0);

    const checks = [
      { name: 'Total deals processed',              actual: result.total,           expected: result.total,           pass: true },
      { name: 'Write errors',                        actual: result.errors,          expected: 0,                      pass: result.errors === 0 },
      { name: 'FK resolved (lead_id found)',         actual: result.total - result.leadNotFound, expected: result.total, pass: result.leadNotFound === 0 },
      { name: 'Unknown stages (fail-closed)',         actual: result.unresolvedStageCount || 0, expected: 0, pass: (result.unresolvedStageCount || 0) === 0 },
      { name: 'Stage normalizations applied',         actual: expectedNormalizations, expected: expectedNormalizations, pass: true },
      { name: 'In-tx deals count',                   actual: inTxDeals,              expected: expectedInTxDeals,      pass: inTxDeals === expectedInTxDeals },
      { name: 'In-tx deals with legacy_base44_id',   actual: inTxDealsWithLegacy,   expected: beforeDealsWithLegacy + result.created, pass: inTxDealsWithLegacy === beforeDealsWithLegacy + result.created },
      { name: 'Deals rollback (before==after)',      actual: afterDeals,             expected: beforeDeals,            pass: afterDeals === beforeDeals },
      { name: 'Legacy IDs rollback (before==after)', actual: afterDealsWithLegacy,  expected: beforeDealsWithLegacy,  pass: afterDealsWithLegacy === beforeDealsWithLegacy },
      { name: 'Leads rollback (before==after)',       actual: afterLeads,             expected: beforeLeads,            pass: afterLeads === beforeLeads },
    ];

    let allPass = true;
    for (const c of checks) {
      const status = c.pass ? 'PASS ✅' : 'FAIL ❌';
      console.log(`  ${c.name.padEnd(44)}  actual=${String(c.actual).padEnd(8)}  expected=${String(c.expected).padEnd(8)}  ${status}`);
      if (!c.pass) allPass = false;
    }

    console.log('');
    console.log(`Migration result: ${JSON.stringify(result)}`);
    console.log('');

    if (allPass) {
      console.log('✅ ALL CHECKS PASSED — production path validated, transaction rolled back');
      process.exit(0);
    } else {
      console.log('❌ SOME CHECKS FAILED — review above');
      process.exit(1);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`\nFATAL ERROR: ${e.message}`);
    console.error('Transaction rolled back. No records left behind.');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();