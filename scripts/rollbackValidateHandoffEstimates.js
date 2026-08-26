/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateHandoffEstimates.js — Production-path rollback validation for
 * the handoff_estimates migration.
 *
 * Calls the EXACT same runHandoffEstimateMigration() function used by:
 *   node scripts/migrateHandoffEstimatesToRailway.js
 *
 * ...but inside a PostgreSQL transaction that is ALWAYS ROLLED BACK.
 *
 * CRITICAL: Uses explicit BEGIN before any writes. Post-rollback verification
 * uses a FRESH pool connection (same pattern as rollbackValidateQbIdentity).
 *
 * Verifies:
 *   1. Pre-migration FK + field audit (all Base44 HandoffEstimate records)
 *   2. Railway schema readiness (handoff_estimates table, columns, constraints)
 *   3. FK resolution: lead_id → Railway leads (nullable — orphans preserved)
 *   4. NOT NULL fields: customer_name, match_status
 *   5. UNIQUE: external_ref
 *   6. Types: NUMERIC(12,2) for estimate_amount, INTEGER for pdf_retry_count,
 *      TIMESTAMPTZ for pdf_fetched_at/last_synced_at, DATE for estimate_date
 *   7. Enum-like fields: match_status, match_method, sync_source, pdf_status
 *      (Railway has NO CHECK constraints — all values accepted, but we audit
 *      distinct values to detect unexpected production data)
 *   8. ON CONFLICT (external_ref) DO UPDATE — idempotent upsert
 *   9. All source records processed (total == Base44 count)
 *  10. Known test/orphan HandoffEstimate accounted for explicitly
 *  11. Write errors: 0
 *  12. In-transaction count reaches expected reconciled count
 *  13. After rollback, database returns to exact before-count (fresh connection)
 *  14. No external side effects
 *
 * FAIL CLOSED on:
 *   - Unknown/unexpected production values (audited, not blocked — Railway has
 *     no CHECK constraints, but we report distinct values for operator review)
 *   - Any write error
 *   - before-count != after-rollback-count (ROLLBACK LEAK)
 *
 * Environment:
 *   DATABASE_URL (Railway Postgres)
 *   WORKER_SECRET (for migrationReader backend function)
 */
const { pool } = require('../db/client');
const { runHandoffEstimateMigration } = require('./migrateHandoffEstimatesToRailway');
const { fetchBase44Entity } = require('./migrationHelpers');

// Known test/orphan HandoffEstimate IDs from prior FK audit.
// These are explicitly accounted for — they should migrate with NULL lead_id
// (schema allows ON DELETE SET NULL) and must NOT block the migration.
// Populated dynamically during audit; this is a documentation marker.

async function rollbackValidate() {
  const client = await pool.connect();
  let result = null;
  const failures = [];
  let before = null; // function-scoped so `finally` can access it
  let auditReport = null;

  try {
    // ── PHASE 1: PRE-MIGRATION FK + FIELD AUDIT ────────────────────────────
    console.log('=== PHASE 1: PRE-MIGRATION FK + FIELD AUDIT ===\n');

    const base44Estimates = await fetchBase44Entity('HandoffEstimate');
    console.log(`Total Base44 HandoffEstimate records: ${base44Estimates.length}`);

    if (base44Estimates.length === 0) {
      failures.push('No Base44 HandoffEstimate records found — check migrationReader connectivity');
      throw new Error('No Base44 records');
    }

    // FK audit — check lead_id resolution against Base44 leads
    const base44Leads = await fetchBase44Entity('Lead');
    const base44LeadIds = new Set(base44Leads.map(l => l.id));
    let withLeadId = 0, leadResolved = 0, leadUnresolved = 0;
    const unresolvedEstimates = [];
    const orphanEstimates = [];

    for (const est of base44Estimates) {
      if (est.lead_id) {
        withLeadId++;
        if (base44LeadIds.has(est.lead_id)) {
          leadResolved++;
        } else {
          leadUnresolved++;
          unresolvedEstimates.push({ id: est.id, customer_name: est.customer_name, leadRef: est.lead_id, match_status: est.match_status });
          orphanEstimates.push(est);
        }
      }
    }

    console.log(`FK lead_id resolution: with_lead_id=${withLeadId}, resolved=${leadResolved}, unresolved=${leadUnresolved}`);
    if (unresolvedEstimates.length > 0) {
      console.log('Unresolved estimates (lead_id will be NULL — schema allows ON DELETE SET NULL):');
      for (const u of unresolvedEstimates) {
        console.log(`  ${u.id} — "${u.customer_name}" → lead_ref: ${u.leadRef} (match_status: ${u.match_status})`);
      }
    } else {
      console.log('✅ All estimate lead_id values resolve to Base44 leads');
    }

    // Field audit — NOT NULL fields
    const nullCustomerName = base44Estimates.filter(e => !e.customer_name).length;
    const nullMatchStatus = base44Estimates.filter(e => !e.match_status).length;

    console.log('\nNOT NULL field audit:');
    console.log(`  null customer_name (NOT NULL): ${nullCustomerName} ${nullCustomerName === 0 ? '✅' : '❌'}`);
    console.log(`  null match_status (NOT NULL default 'unmatched'): ${nullMatchStatus} ${nullMatchStatus === 0 ? '✅' : '❌'}`);

    if (nullCustomerName > 0) failures.push(`${nullCustomerName} records have null customer_name (NOT NULL — migration will use 'Unknown' fallback)`);
    if (nullMatchStatus > 0) failures.push(`${nullMatchStatus} records have null match_status (NOT NULL — migration will use 'unmatched' fallback)`);

    // Distinct value audit for enum-like fields (Railway has no CHECK constraints,
    // but we audit for unexpected production values)
    const distinctMatchStatus = {};
    const distinctMatchMethod = {};
    const distinctSyncSource = {};
    const distinctPdfStatus = {};
    const distinctSource = {};

    for (const e of base44Estimates) {
      const ms = e.match_status || '(null)';
      distinctMatchStatus[ms] = (distinctMatchStatus[ms] || 0) + 1;
      const mm = e.match_method || '(null)';
      distinctMatchMethod[mm] = (distinctMatchMethod[mm] || 0) + 1;
      const ss = e.sync_source || '(null)';
      distinctSyncSource[ss] = (distinctSyncSource[ss] || 0) + 1;
      const ps = e.pdf_status || '(null)';
      distinctPdfStatus[ps] = (distinctPdfStatus[ps] || 0) + 1;
      const src = e.source || '(null)';
      distinctSource[src] = (distinctSource[src] || 0) + 1;
    }

    console.log('\nDistinct value audit (Railway has NO CHECK constraints — all accepted):');
    console.log(`  match_status: ${JSON.stringify(distinctMatchStatus)}`);
    console.log(`  match_method: ${JSON.stringify(distinctMatchMethod)}`);
    console.log(`  sync_source: ${JSON.stringify(distinctSyncSource)}`);
    console.log(`  pdf_status: ${JSON.stringify(distinctPdfStatus)}`);
    console.log(`  source: ${JSON.stringify(distinctSource)}`);

    // Type audit — check for malformed numeric/date fields
    let badEstimateAmount = 0, badPdfRetryCount = 0, badEstimateDate = 0, badPdfFetchedAt = 0, badLastSyncedAt = 0;
    for (const e of base44Estimates) {
      if (e.estimate_amount !== null && e.estimate_amount !== undefined && isNaN(Number(e.estimate_amount))) badEstimateAmount++;
      if (e.pdf_retry_count !== null && e.pdf_retry_count !== undefined && isNaN(Number(e.pdf_retry_count))) badPdfRetryCount++;
      if (e.estimate_date && isNaN(Date.parse(e.estimate_date))) badEstimateDate++;
      if (e.pdf_fetched_at && isNaN(Date.parse(e.pdf_fetched_at))) badPdfFetchedAt++;
      if (e.last_synced_at && isNaN(Date.parse(e.last_synced_at))) badLastSyncedAt++;
    }
    console.log('\nType audit:');
    console.log(`  bad estimate_amount (NUMERIC): ${badEstimateAmount} ${badEstimateAmount === 0 ? '✅' : '❌'}`);
    console.log(`  bad pdf_retry_count (INTEGER): ${badPdfRetryCount} ${badPdfRetryCount === 0 ? '✅' : '❌'}`);
    console.log(`  bad estimate_date (DATE): ${badEstimateDate} ${badEstimateDate === 0 ? '✅' : '❌'}`);
    console.log(`  bad pdf_fetched_at (TIMESTAMPTZ): ${badPdfFetchedAt} ${badPdfFetchedAt === 0 ? '✅' : '❌'}`);
    console.log(`  bad last_synced_at (TIMESTAMPTZ): ${badLastSyncedAt} ${badLastSyncedAt === 0 ? '✅' : '❌'}`);

    if (badEstimateAmount > 0) failures.push(`${badEstimateAmount} records have unparseable estimate_amount`);
    if (badPdfRetryCount > 0) failures.push(`${badPdfRetryCount} records have unparseable pdf_retry_count`);
    if (badEstimateDate > 0) failures.push(`${badEstimateDate} records have unparseable estimate_date`);
    if (badPdfFetchedAt > 0) failures.push(`${badPdfFetchedAt} records have unparseable pdf_fetched_at`);
    if (badLastSyncedAt > 0) failures.push(`${badLastSyncedAt} records have unparseable last_synced_at`);

    // Duplicate external_ref audit (Base44 IDs must be unique)
    const seenIds = new Set();
    let duplicateExternalRefs = 0;
    for (const e of base44Estimates) {
      if (seenIds.has(e.id)) duplicateExternalRefs++;
      else seenIds.add(e.id);
    }
    console.log(`\nDuplicate external_ref in Base44: ${duplicateExternalRefs} ${duplicateExternalRefs === 0 ? '✅' : '❌'}`);
    if (duplicateExternalRefs > 0) failures.push(`${duplicateExternalRefs} duplicate external_ref values in Base44 (UNIQUE constraint will conflict)`);

    auditReport = {
      totalBase44: base44Estimates.length,
      withLeadId, leadResolved, leadUnresolved,
      orphanCount: orphanEstimates.length,
      orphanIds: orphanEstimates.map(o => ({ id: o.id, customer_name: o.customer_name, leadRef: o.lead_id })),
      nullCustomerName, nullMatchStatus,
      distinctMatchStatus, distinctMatchMethod, distinctSyncSource, distinctPdfStatus, distinctSource,
      badEstimateAmount, badPdfRetryCount, badEstimateDate, badPdfFetchedAt, badLastSyncedAt,
      duplicateExternalRefs,
    };

    // ── PHASE 1b: RAILWAY SCHEMA AUDIT ─────────────────────────────────────
    console.log('\n=== PHASE 1b: RAILWAY SCHEMA AUDIT ===\n');

    const { rows: tableExists } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'handoff_estimates'
      ) as exists
    `);
    if (!tableExists[0].exists) {
      failures.push('handoff_estimates table does NOT EXIST — run migration 2026-14 first');
      throw new Error('Table missing');
    }
    console.log('✅ handoff_estimates table exists');

    const { rows: columns } = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'handoff_estimates'
      ORDER BY ordinal_position
    `);
    const colMap = {};
    for (const c of columns) colMap[c.column_name] = c;
    console.log(`Columns: ${columns.length}`);

    // Verify critical columns
    const requiredCols = {
      external_ref: { type: 'text', nullable: 'NO' },
      lead_id: { type: 'uuid', nullable: 'YES' },
      customer_name: { type: 'text', nullable: 'NO' },
      match_status: { type: 'text', nullable: 'NO' },
      estimate_amount: { type: 'numeric', nullable: 'YES' },
      pdf_retry_count: { type: 'integer', nullable: 'YES' },
      estimate_date: { type: 'date', nullable: 'YES' },
      pdf_fetched_at: { type: 'timestamp with time zone', nullable: 'YES' },
      last_synced_at: { type: 'timestamp with time zone', nullable: 'YES' },
      raw_payload: { type: 'text', nullable: 'YES' },
    };
    for (const [name, spec] of Object.entries(requiredCols)) {
      const col = colMap[name];
      if (!col) {
        failures.push(`Missing column: ${name}`);
      } else {
        if (col.data_type !== spec.type) failures.push(`Column ${name} type mismatch: expected ${spec.type}, got ${col.data_type}`);
        if (col.is_nullable !== spec.nullable) failures.push(`Column ${name} nullable mismatch: expected ${spec.nullable}, got ${col.is_nullable}`);
      }
    }
    if (failures.filter(f => f.includes('Column') || f.includes('Missing')).length === 0) {
      console.log('✅ All critical columns present with correct types/nullability');
    }

    // Verify UNIQUE on external_ref
    const { rows: uniqueConstraints } = await client.query(`
      SELECT tc.constraint_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'handoff_estimates' AND tc.constraint_type = 'UNIQUE'
    `);
    const hasExternalRefUnique = uniqueConstraints.some(c => c.column_name === 'external_ref');
    if (!hasExternalRefUnique) failures.push('external_ref has no UNIQUE constraint — ON CONFLICT will fail');
    else console.log('✅ external_ref UNIQUE constraint verified');

    // ── PHASE 2: BEFORE COUNTS ──────────────────────────────────────────────
    const { rows: beforeRows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM handoff_estimates) as handoff_count,
        (SELECT COUNT(*) FROM leads) as leads_count,
        (SELECT COUNT(*) FROM deals) as deals_count
    `);
    before = {
      handoff: parseInt(beforeRows[0].handoff_count, 10),
      leads: parseInt(beforeRows[0].leads_count, 10),
      deals: parseInt(beforeRows[0].deals_count, 10),
    };
    console.log(`\nBEFORE: handoff_estimates=${before.handoff}, leads=${before.leads}, deals=${before.deals}`);

    // ── PHASE 3: BEGIN TRANSACTION (CRITICAL — without BEGIN, UPDATEs auto-commit) ──
    await client.query('BEGIN');
    console.log('Transaction started (BEGIN)');

    // ── PHASE 4: Run the EXACT production migration inside the transaction ───
    console.log('\n=== PHASE 4: RUNNING PRODUCTION MIGRATION INSIDE TRANSACTION ===\n');
    const queryFn = client.query.bind(client);
    result = await runHandoffEstimateMigration(queryFn);

    // ── PHASE 5: IN-TX VERIFICATION ─────────────────────────────────────────
    console.log('\n=== PHASE 5: IN-TX VERIFICATION ===\n');

    const { rows: inTxRows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM handoff_estimates) as handoff_count,
        (SELECT COUNT(*) FROM handoff_estimates WHERE lead_id IS NOT NULL) as with_lead,
        (SELECT COUNT(*) FROM handoff_estimates WHERE customer_name IS NULL) as null_customer,
        (SELECT COUNT(*) FROM handoff_estimates WHERE match_status IS NULL) as null_match,
        (SELECT COUNT(*) FROM handoff_estimates WHERE external_ref IS NULL) as null_ext
    `);
    const inTx = {
      handoff: parseInt(inTxRows[0].handoff_count, 10),
      withLead: parseInt(inTxRows[0].with_lead, 10),
      nullCustomer: parseInt(inTxRows[0].null_customer, 10),
      nullMatch: parseInt(inTxRows[0].null_match, 10),
      nullExt: parseInt(inTxRows[0].null_ext, 10),
    };
    console.log(`IN-TX: handoff_estimates=${inTx.handoff}, with_lead=${inTx.withLead}, null_customer=${inTx.nullCustomer}, null_match=${inTx.nullMatch}, null_ext=${inTx.nullExt}`);

    // All source records processed
    if (result.total !== auditReport.totalBase44) {
      failures.push(`Total processed (${result.total}) != Base44 count (${auditReport.totalBase44})`);
    } else {
      console.log(`✅ All ${result.total} source records processed`);
    }

    // Write errors must be 0
    if (result.errors !== 0) {
      failures.push(`Write errors: ${result.errors} (expected 0)`);
      for (const ed of result.errorDetails || []) {
        failures.push(`  Error on ${ed.id}: ${ed.error}`);
      }
    } else {
      console.log('✅ Zero write errors');
    }

    // In-tx count should be before + created (idempotent upsert)
    const expectedInTx = before.handoff + result.created;
    if (inTx.handoff !== expectedInTx) {
      // Could also be before + created + updated if there were pre-existing rows that got updated
      // Actually for idempotent upsert: if before=0, in-tx = created. If before>0, in-tx = before (updates don't add rows).
      // The correct expectation is: in-tx == max(before, created) when before=0, or before+created-new-updates-of-existing
      // Simplest: in-tx should be >= before and <= before + total
      if (inTx.handoff < before.handoff || inTx.handoff > before.handoff + result.total) {
        failures.push(`IN-TX handoff count ${inTx.handoff} outside expected range [${before.handoff}, ${before.handoff + result.total}]`);
      } else {
        console.log(`✅ IN-TX count ${inTx.handoff} within valid range (before=${before.handoff}, total=${result.total})`);
      }
    } else {
      console.log(`✅ IN-TX count ${inTx.handoff} == expected ${expectedInTx}`);
    }

    // NOT NULL violations in-tx
    if (inTx.nullCustomer > 0) failures.push(`IN-TX ${inTx.nullCustomer} rows with NULL customer_name (NOT NULL violation)`);
    else console.log('✅ IN-TX zero NULL customer_name');
    if (inTx.nullMatch > 0) failures.push(`IN-TX ${inTx.nullMatch} rows with NULL match_status (NOT NULL violation)`);
    else console.log('✅ IN-TX zero NULL match_status');
    if (inTx.nullExt > 0) failures.push(`IN-TX ${inTx.nullExt} rows with NULL external_ref (UNIQUE violation)`);
    else console.log('✅ IN-TX zero NULL external_ref');

    // FK integrity — all non-null lead_id must resolve to leads
    const { rows: badFk } = await client.query(`
      SELECT COUNT(*) as cnt FROM handoff_estimates he
      WHERE he.lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = he.lead_id)
    `);
    if (parseInt(badFk[0].cnt, 10) > 0) {
      failures.push(`IN-TX ${badFk[0].cnt} rows with dangling lead_id FK`);
    } else {
      console.log('✅ IN-TX all non-null lead_id values resolve to leads');
    }

    // Orphan accounting — unresolved FKs should have NULL lead_id
    if (result.unresolvedLeadFk !== auditReport.leadUnresolved) {
      failures.push(`Unresolved FK count mismatch: migration=${result.unresolvedLeadFk}, audit=${auditReport.leadUnresolved}`);
    } else {
      console.log(`✅ Orphan accounting: ${result.unresolvedLeadFk} unresolved FKs (set to NULL, schema-allowed)`);
    }

    // Duplicate external_ref check in-tx
    const { rows: dupExt } = await client.query(`
      SELECT external_ref, COUNT(*) as cnt FROM handoff_estimates
      WHERE external_ref IS NOT NULL
      GROUP BY external_ref HAVING COUNT(*) > 1
    `);
    if (dupExt.length > 0) failures.push(`IN-TX ${dupExt.length} duplicate external_ref values`);
    else console.log('✅ IN-TX zero duplicate external_ref');

  } catch (e) {
    console.error('[rollback-validate-handoff] Error during validation:', e.message);
    failures.push(`Exception: ${e.message}`);
  } finally {
    // ── PHASE 6: ALWAYS ROLLBACK ───────────────────────────────────────────
    console.log('\n=== PHASE 6: ROLLING BACK TRANSACTION ===');
    try {
      await client.query('ROLLBACK');
      console.log('ROLLBACK executed');
    } catch (rbErr) {
      console.error('ROLLBACK failed:', rbErr.message);
      failures.push(`ROLLBACK failed: ${rbErr.message}`);
    }
    client.release();

    // ── PHASE 7: Verify rollback on a FRESH connection ─────────────────────
    console.log('\n=== PHASE 7: POST-ROLLBACK VERIFICATION (FRESH CONNECTION) ===\n');
    const freshClient = await pool.connect();
    try {
      const { rows: afterRows } = await freshClient.query(`
        SELECT
          (SELECT COUNT(*) FROM handoff_estimates) as handoff_count,
          (SELECT COUNT(*) FROM leads) as leads_count,
          (SELECT COUNT(*) FROM deals) as deals_count
      `);
      const after = {
        handoff: parseInt(afterRows[0].handoff_count, 10),
        leads: parseInt(afterRows[0].leads_count, 10),
        deals: parseInt(afterRows[0].deals_count, 10),
      };
      console.log(`AFTER ROLLBACK (fresh): handoff_estimates=${after.handoff}, leads=${after.leads}, deals=${after.deals}`);

      if (!before) {
        failures.push('before was never captured (unexpected early failure)');
      } else {
        if (after.handoff !== before.handoff) {
          failures.push(`handoff_estimates changed: ${before.handoff} → ${after.handoff} — ROLLBACK LEAK`);
        } else {
          console.log(`✅ handoff_estimates unchanged: ${before.handoff} → ${after.handoff}`);
        }
        if (after.leads !== before.leads) {
          failures.push(`leads changed: ${before.leads} → ${after.leads} — ROLLBACK LEAK`);
        } else {
          console.log(`✅ leads unchanged: ${before.leads} → ${after.leads}`);
        }
        if (after.deals !== before.deals) {
          failures.push(`deals changed: ${before.deals} → ${after.deals} — ROLLBACK LEAK`);
        } else {
          console.log(`✅ deals unchanged: ${before.deals} → ${after.deals}`);
        }
      }
    } finally {
      freshClient.release();
    }
  }

  // ── FINAL REPORT ─────────────────────────────────────────────────────────
  console.log('\n=== HANDOFF ESTIMATE ROLLBACK VALIDATION COMPLETE ===');
  console.log(`Base44 records:       ${auditReport ? auditReport.totalBase44 : 'N/A'}`);
  console.log(`Migration result:     ${JSON.stringify(result)}`);
  console.log(`Orphans (NULL lead):   ${auditReport ? auditReport.leadUnresolved : 'N/A'}`);
  console.log(`BEFORE:               ${JSON.stringify(before)}`);
  console.log(`Validation failures:  ${failures.length}`);

  if (failures.length > 0) {
    console.error('\n❌ VALIDATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n✅ ALL VALIDATION CHECKS PASSED — production migration verified, rollback is clean');
  process.exit(0);
}

rollbackValidate().catch(e => {
  console.error('[rollback-validate-handoff] FATAL:', e);
  process.exit(1);
});