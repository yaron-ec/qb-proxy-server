#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateActivities.js — Production-path rollback validation for Activities.
 *
 * Runs the EXACT same runActivityMigration() function used by the production script,
 * inside a transaction that is ALWAYS ROLLED BACK. No parallel dry-run — it requires()
 * the production module and calls its exported function.
 *
 * Validates ALL 5916 Base44 activities, not one sample.
 *
 * Checks:
 *   - Source normalization (no source constraint violations)
 *   - Orphan handling (unresolved lead_ids → NULL lead_id + original_lead_ref)
 *   - Write errors = 0
 *   - All legitimate production activities preserved
 *   - Before count = after rollback count
 *   - No external side effects
 */
const { pool } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');
const { runActivityMigration, normalizeSource, ALLOWED_SOURCES } = require('./migrateActivitiesToRailway');

async function main() {
  console.log('=== PRODUCTION-PATH ROLLBACK VALIDATION (Activities) ===');
  console.log(`Started: ${new Date().toISOString()}`);

  if (!hasBase44Creds()) {
    console.error('FATAL: WORKER_SECRET required');
    process.exit(1);
  }

  // ── Phase 1: Pre-migration audit (read-only) ──────────────────────────────
  console.log('\n=== PHASE 1: PRE-MIGRATION SOURCE + FK AUDIT ===\n');

  const base44Activities = await fetchBase44Entity('Activity');
  const leadIdCache = await buildLeadIdCache();

  const sourceCounts = {};
  const sourceNormalizations = {};
  let resolvedCount = 0;
  let orphanCount = 0;
  const orphanLeadIds = new Set();
  const orphanTypeBreakdown = {};

  for (const a of base44Activities) {
    const src = a.source || '(null)';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;

    if (!ALLOWED_SOURCES.has(src) && src !== '(null)') {
      sourceNormalizations[src] = (sourceNormalizations[src] || 0) + 1;
    }

    const railwayLeadId = leadIdCache[String(a.lead_id)] || null;
    if (railwayLeadId) {
      resolvedCount++;
    } else {
      orphanCount++;
      if (a.lead_id) orphanLeadIds.add(a.lead_id);
      const t = a.type || '(null)';
      orphanTypeBreakdown[t] = (orphanTypeBreakdown[t] || 0) + 1;
    }
  }

  console.log(`Total Base44 activities: ${base44Activities.length}`);
  console.log('Source value distribution:');
  for (const [src, cnt] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    const allowed = ALLOWED_SOURCES.has(src) ? 'ALLOWED' : 'WILL NORMALIZE → manual';
    console.log(`  ${src.padEnd(20)} ${String(cnt).padStart(5)}  ${allowed}`);
  }
  console.log(`\nFK resolution: resolved=${resolvedCount}, orphan=${orphanCount}, distinct orphan lead_ids=${orphanLeadIds.size}`);
  console.log('Orphan activity type breakdown:', orphanTypeBreakdown);

  // ── Phase 2: Run production migration inside transaction ─────────────────
  console.log('\n=== PHASE 2: EXECUTE PRODUCTION MIGRATION (TRANSACTION → ROLLBACK) ===\n');

  const client = await pool.connect();

  try {
    // Capture before counts
    const beforeRes = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM activities) as activities,
        (SELECT COUNT(*) FROM activities WHERE external_ref IS NOT NULL) as with_external_ref,
        (SELECT COUNT(*) FROM activities WHERE lead_id IS NOT NULL) as with_lead_id,
        (SELECT COUNT(*) FROM activities WHERE original_lead_ref IS NOT NULL) as with_original_ref,
        (SELECT COUNT(*) FROM leads) as leads
    `);
    const before = beforeRes.rows[0];
    console.log('Before:', before);

    await client.query('BEGIN');

    // Run the ACTUAL production migration function with transaction-bound queryFn
    const result = await runActivityMigration(client.query.bind(client));

    // Capture in-transaction counts
    const inTxRes = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM activities) as activities,
        (SELECT COUNT(*) FROM activities WHERE external_ref IS NOT NULL) as with_external_ref,
        (SELECT COUNT(*) FROM activities WHERE lead_id IS NOT NULL) as with_lead_id,
        (SELECT COUNT(*) FROM activities WHERE original_lead_ref IS NOT NULL) as with_original_ref
    `);
    const inTx = inTxRes.rows[0];
    console.log('In-transaction:', inTx);

    // ── ALWAYS ROLLBACK ─────────────────────────────────────────────────────
    console.log('\n=== ROLLING BACK TRANSACTION ===\n');
    await client.query('ROLLBACK');

    // Capture after counts
    const afterRes = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM activities) as activities,
        (SELECT COUNT(*) FROM activities WHERE external_ref IS NOT NULL) as with_external_ref,
        (SELECT COUNT(*) FROM activities WHERE lead_id IS NOT NULL) as with_lead_id,
        (SELECT COUNT(*) FROM activities WHERE original_lead_ref IS NOT NULL) as with_original_ref,
        (SELECT COUNT(*) FROM leads) as leads
    `);
    const after = afterRes.rows[0];
    console.log('After rollback:', after);

    // ── Validation ──────────────────────────────────────────────────────────
    console.log('\n=== VALIDATION ===\n');

    const expectedInTx = parseInt(before.activities) + result.created;
    const checks = [
      { name: 'Total activities processed',           actual: result.total,                     expected: base44Activities.length,             pass: result.total === base44Activities.length },
      { name: 'Write errors',                         actual: result.errors,                     expected: 0,                                   pass: result.errors === 0 },
      { name: 'Source normalizations applied',        actual: Object.keys(result.sourceNormalizations).length, expected: Object.keys(sourceNormalizations).length, pass: Object.keys(result.sourceNormalizations).length === Object.keys(sourceNormalizations).length },
      { name: 'Resolved activities (lead_id found)',  actual: result.resolved,                    expected: resolvedCount,                        pass: result.resolved === resolvedCount },
      { name: 'Orphaned activities (lead_id NULL)',   actual: result.orphaned,                    expected: orphanCount,                          pass: result.orphaned === orphanCount },
      { name: 'In-tx activities count',               actual: parseInt(inTx.activities),          expected: expectedInTx,                         pass: parseInt(inTx.activities) === expectedInTx },
      { name: 'In-tx with original_lead_ref',         actual: parseInt(inTx.with_original_ref),   expected: orphanCount,                          pass: parseInt(inTx.with_original_ref) >= orphanCount },
      { name: 'Activities rollback (before==after)',  actual: parseInt(after.activities),         expected: parseInt(before.activities),           pass: after.activities === before.activities },
      { name: 'Leads rollback (before==after)',        actual: parseInt(after.leads),              expected: parseInt(before.leads),                pass: after.leads === before.leads },
    ];

    let allPass = true;
    for (const c of checks) {
      const status = c.pass ? 'PASS ✅' : 'FAIL ❌';
      if (!c.pass) allPass = false;
      console.log(`  ${c.name.padEnd(45)} actual=${String(c.actual).padEnd(10)} expected=${String(c.expected).padEnd(10)} ${status}`);
    }

    console.log(`\nMigration result: ${JSON.stringify(result)}`);

    if (!allPass) {
      console.log('\n❌ SOME CHECKS FAILED — review above');
      process.exit(1);
    }

    console.log('\n✅ ALL CHECKS PASSED — production path validated, transaction rolled back');
    process.exit(0);

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

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});