/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateShlomiMerge.js — Production-path rollback validation for the
 * Shlomi → Simon identity merge.
 *
 * Runs the EXACT same runShlomiMerge() function used by:
 *   node scripts/mergeShlomiIntoSimon.js
 *
 * ...but inside a PostgreSQL transaction that is ALWAYS ROLLED BACK.
 *
 * CRITICAL: Uses explicit BEGIN before any writes. Post-rollback verification
 * uses a FRESH pool connection (same pattern as rollbackValidateSmallDatasets).
 *
 * Validates:
 *   1. Pre-merge comprehensive audit (Railway + Base44) — every Shlomi reference.
 *   2. Simon owner exists (merge target must be present).
 *   3. Shlomi owner (if present) re-point: leads.owner_id, appointments.owner_id
 *      re-pointed, no appointment overlap collision, Shlomi owner deleted.
 *   4. Text re-points: deals.assigned_rep, tasks.assigned_to,
 *      deal_commissions.recipient_name → 'Simon Ashkenazi'.
 *   5. Historical references PRESERVED (lead_submissions.assigned_rep_at_time,
 *      appointment_events.actor unchanged).
 *   6. In-tx zero-active-reference audit (no 'Shlomi Ashkenazi' in re-point cols).
 *   7. Idempotency: re-run inside same tx → same state (no further changes).
 *   8. After rollback, database returns to exact before-state (fresh connection).
 *
 * FAIL CLOSED on:
 *   - Simon owner missing
 *   - Multiple Shlomi owners (ambiguous)
 *   - Appointment overlap collision (EXCLUDE constraint would fire)
 *   - Any write error
 *   - before-state != after-rollback-state (ROLLBACK LEAK)
 *   - Active Shlomi references remaining after merge in re-point columns
 *
 * NOTE: This validator does NOT touch Base44 (the UserAllowlist Shlomi delete
 * is a separate, non-transactional step performed only during the permanent
 * merge — it cannot be rolled back via Railway).
 *
 * Environment: DATABASE_URL, WORKER_SECRET (for the Base44 read audit)
 */
const { pool } = require('../db/client');
const { runShlomiMerge } = require('./mergeShlomiIntoSimon');
const { auditShlomiIdentity, SHLOMI_NAME, SIMON_NAME } = require('./auditShlomiIdentity');

async function rollbackValidate() {
  const client = await pool.connect();
  let mergeReport = null;
  const failures = [];
  let before = null;
  let preAudit = null;

  try {
    // ── PHASE 1: PRE-MERGE COMPREHENSIVE AUDIT ────────────────────────────────
    console.log('=== PHASE 1: PRE-MERGE COMPREHENSIVE AUDIT ===\n');
    preAudit = await auditShlomiIdentity();
    console.log(`\nPre-merge: ${preAudit.shlomiRefs.length} Shlomi references (${preAudit.rePoint.length} re-point, ${preAudit.preserve.length} preserve)`);

    // ── PHASE 2: BEFORE-STATE COUNTS ───────────────────────────────────────────
    console.log('\n=== PHASE 2: BEFORE-STATE COUNTS ===\n');
    const { rows: beforeRows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM owners) AS owners,
        (SELECT COUNT(*) FROM owners WHERE lower(display_name) LIKE '%shlomi%') AS shlomi_owners,
        (SELECT COUNT(*) FROM owners WHERE lower(display_name) = lower($1) OR email = $2) AS simon_owners,
        (SELECT COUNT(*) FROM leads) AS leads,
        (SELECT COUNT(*) FROM appointments) AS appointments,
        (SELECT COUNT(*) FROM deals WHERE assigned_rep = $3) AS deals_shlomi,
        (SELECT COUNT(*) FROM tasks WHERE assigned_to = $3) AS tasks_shlomi,
        (SELECT COUNT(*) FROM deal_commissions WHERE recipient_name = $3) AS comm_shlomi,
        (SELECT COUNT(*) FROM lead_submissions WHERE assigned_rep_at_time = $3) AS ls_shlomi,
        (SELECT COUNT(*) FROM appointment_events WHERE actor = $3) AS ae_shlomi
    `, [SIMON_NAME, 'office@tsvisionbuilders.com', SHLOMI_NAME]);
    before = {
      owners: parseInt(beforeRows[0].owners, 10),
      shlomiOwners: parseInt(beforeRows[0].shlomi_owners, 10),
      simonOwners: parseInt(beforeRows[0].simon_owners, 10),
      leads: parseInt(beforeRows[0].leads, 10),
      appointments: parseInt(beforeRows[0].appointments, 10),
      dealsShlomi: parseInt(beforeRows[0].deals_shlomi, 10),
      tasksShlomi: parseInt(beforeRows[0].tasks_shlomi, 10),
      commShlomi: parseInt(beforeRows[0].comm_shlomi, 10),
      lsShlomi: parseInt(beforeRows[0].ls_shlomi, 10),
      aeShlomi: parseInt(beforeRows[0].ae_shlomi, 10),
    };
    console.log(`BEFORE: ${JSON.stringify(before)}`);

    // Pre-flight: Simon owner must exist
    if (before.simonOwners === 0) {
      failures.push(`Simon owner NOT FOUND in Railway owners table — merge target missing. Run migrateOwnersToRailway.js or create Simon owner first.`);
    } else if (before.simonOwners > 1) {
      failures.push(`Multiple Simon owners found (${before.simonOwners}) — ambiguous merge target. Operator must resolve.`);
    } else {
      console.log(`✅ Exactly one Simon owner found (merge target present)`);
    }

    // Pre-flight: multiple Shlomi owners = ambiguous
    if (before.shlomiOwners > 1) {
      failures.push(`${before.shlomiOwners} Shlomi owners found — ambiguous. Operator must resolve.`);
    }

    // If pre-flight failed, abort before transaction
    const preflightFailures = failures.filter(f => f.includes('NOT FOUND') || f.includes('ambiguous') || f.includes('Multiple Simon'));
    if (preflightFailures.length > 0) {
      console.error('\n[rollback-validate-shlomi] Pre-flight FAILED — aborting before transaction');
      throw new Error('Pre-flight audit failed');
    }

    // ── PHASE 3: BEGIN TRANSACTION ────────────────────────────────────────────
    console.log('\n=== PHASE 3: BEGIN TRANSACTION ===');
    await client.query('BEGIN');
    console.log('Transaction started (BEGIN)');

    // ── PHASE 4: RUN EXACT PRODUCTION MERGE INSIDE TRANSACTION ─────────────────
    console.log('\n=== PHASE 4: RUNNING PRODUCTION MERGE INSIDE TRANSACTION ===\n');
    const queryFn = client.query.bind(client);
    mergeReport = await runShlomiMerge(queryFn);
    console.log(`Merge result: ${JSON.stringify(mergeReport)}`);

    // ── PHASE 5: IN-TX VERIFICATION ───────────────────────────────────────────
    console.log('\n=== PHASE 5: IN-TX VERIFICATION ===\n');

    const { rows: inTxRows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM owners) AS owners,
        (SELECT COUNT(*) FROM owners WHERE lower(display_name) LIKE '%shlomi%') AS shlomi_owners,
        (SELECT COUNT(*) FROM owners WHERE lower(display_name) = lower($1) OR email = $2) AS simon_owners,
        (SELECT COUNT(*) FROM leads) AS leads,
        (SELECT COUNT(*) FROM appointments) AS appointments,
        (SELECT COUNT(*) FROM deals WHERE assigned_rep = $3) AS deals_shlomi,
        (SELECT COUNT(*) FROM tasks WHERE assigned_to = $3) AS tasks_shlomi,
        (SELECT COUNT(*) FROM deal_commissions WHERE recipient_name = $3) AS comm_shlomi,
        (SELECT COUNT(*) FROM lead_submissions WHERE assigned_rep_at_time = $3) AS ls_shlomi,
        (SELECT COUNT(*) FROM appointment_events WHERE actor = $3) AS ae_shlomi,
        (SELECT COUNT(*) FROM deals WHERE assigned_rep = $1) AS deals_simon,
        (SELECT COUNT(*) FROM tasks WHERE assigned_to = $1) AS tasks_simon,
        (SELECT COUNT(*) FROM deal_commissions WHERE recipient_name = $1) AS comm_simon
    `, [SIMON_NAME, 'office@tsvisionbuilders.com', SHLOMI_NAME]);
    const inTx = {
      owners: parseInt(inTxRows[0].owners, 10),
      shlomiOwners: parseInt(inTxRows[0].shlomi_owners, 10),
      simonOwners: parseInt(inTxRows[0].simon_owners, 10),
      leads: parseInt(inTxRows[0].leads, 10),
      appointments: parseInt(inTxRows[0].appointments, 10),
      dealsShlomi: parseInt(inTxRows[0].deals_shlomi, 10),
      tasksShlomi: parseInt(inTxRows[0].tasks_shlomi, 10),
      commShlomi: parseInt(inTxRows[0].comm_shlomi, 10),
      lsShlomi: parseInt(inTxRows[0].ls_shlomi, 10),
      aeShlomi: parseInt(inTxRows[0].ae_shlomi, 10),
      dealsSimon: parseInt(inTxRows[0].deals_simon, 10),
      tasksSimon: parseInt(inTxRows[0].tasks_simon, 10),
      commSimon: parseInt(inTxRows[0].comm_simon, 10),
    };
    console.log(`IN-TX: ${JSON.stringify(inTx)}`);

    // Shlomi owner must be gone (if it existed)
    if (mergeReport.owners.shlomiOwnerFound) {
      if (inTx.shlomiOwners !== 0) failures.push(`IN-TX shlomi_owners=${inTx.shlomiOwners}, expected 0 (Shlomi owner should be deleted)`);
      else console.log('✅ Shlomi owner deleted');
      if (inTx.owners !== before.owners - 1) failures.push(`IN-TX owners=${inTx.owners}, expected ${before.owners - 1} (one Shlomi owner removed)`);
      else console.log(`✅ owners count: ${before.owners} → ${inTx.owners}`);
      // leads + appointments counts unchanged (re-pointed, not deleted)
      if (inTx.leads !== before.leads) failures.push(`IN-TX leads changed: ${before.leads} → ${inTx.leads} (should be unchanged — re-point only)`);
      else console.log(`✅ leads unchanged: ${inTx.leads}`);
      if (inTx.appointments !== before.appointments) failures.push(`IN-TX appointments changed: ${before.appointments} → ${inTx.appointments} (should be unchanged — re-point only)`);
      else console.log(`✅ appointments unchanged: ${inTx.appointments}`);
    } else {
      console.log('ℹ️  No Shlomi owner found in Railway — owners re-point skipped (no-op)');
    }

    // Text re-point columns: zero Shlomi remaining
    if (inTx.dealsShlomi !== 0) failures.push(`IN-TX deals.assigned_rep still has ${inTx.dealsShlomi} Shlomi reference(s)`);
    else console.log('✅ deals.assigned_rep: zero Shlomi references');
    if (inTx.tasksShlomi !== 0) failures.push(`IN-TX tasks.assigned_to still has ${inTx.tasksShlomi} Shlomi reference(s)`);
    else console.log('✅ tasks.assigned_to: zero Shlomi references');
    if (inTx.commShlomi !== 0) failures.push(`IN-TX deal_commissions.recipient_name still has ${inTx.commShlomi} Shlomi reference(s)`);
    else console.log('✅ deal_commissions.recipient_name: zero Shlomi references');

    // Historical references PRESERVED (unchanged)
    if (inTx.lsShlomi !== before.lsShlomi) failures.push(`IN-TX lead_submissions.assigned_rep_at_time CHANGED: ${before.lsShlomi} → ${inTx.lsShlomi} (must be PRESERVED)`);
    else console.log(`✅ lead_submissions.assigned_rep_at_time preserved: ${inTx.lsShlomi}`);
    if (inTx.aeShlomi !== before.aeShlomi) failures.push(`IN-TX appointment_events.actor CHANGED: ${before.aeShlomi} → ${inTx.aeShlomi} (must be PRESERVED)`);
    else console.log(`✅ appointment_events.actor preserved: ${inTx.aeShlomi}`);

    // Simon owner still exactly one
    if (inTx.simonOwners !== 1) failures.push(`IN-TX simon_owners=${inTx.simonOwners}, expected 1`);
    else console.log('✅ Simon owner intact (exactly 1)');

    // ── PHASE 5b: IDEMPOTENCY — re-run inside same tx ──────────────────────────
    console.log('\n=== PHASE 5b: IDEMPOTENCY RE-RUN ===\n');
    const report2 = await runShlomiMerge(queryFn);
    if (report2.deals.repointed !== 0 || report2.tasks.repointed !== 0 || report2.dealCommissions.repointed !== 0) {
      failures.push(`IDEMPOTENCY FAILED: second run re-pointed deals=${report2.deals.repointed}, tasks=${report2.tasks.repointed}, commissions=${report2.dealCommissions.repointed} (should be 0)`);
    } else {
      console.log('✅ Idempotent: second run made no further changes');
    }
    if (report2.owners.shlomiOwnerFound) {
      failures.push(`IDEMPOTENCY FAILED: second run found a Shlomi owner (should be gone)`);
    } else {
      console.log('✅ Idempotent: no Shlomi owner on second run');
    }

  } catch (e) {
    console.error('[rollback-validate-shlomi] Error during validation:', e.message);
    failures.push(`Exception: ${e.message}`);
  } finally {
    // ── PHASE 6: ALWAYS ROLLBACK ──────────────────────────────────────────────
    console.log('\n=== PHASE 6: ROLLING BACK TRANSACTION ===');
    try {
      await client.query('ROLLBACK');
      console.log('ROLLBACK executed');
    } catch (rbErr) {
      console.error('ROLLBACK failed:', rbErr.message);
      failures.push(`ROLLBACK failed: ${rbErr.message}`);
    }
    client.release();

    // ── PHASE 7: POST-ROLLBACK VERIFICATION (FRESH CONNECTION) ─────────────────
    console.log('\n=== PHASE 7: POST-ROLLBACK VERIFICATION (FRESH CONNECTION) ===\n');
    const freshClient = await pool.connect();
    try {
      const { rows: afterRows } = await freshClient.query(`
        SELECT
          (SELECT COUNT(*) FROM owners) AS owners,
          (SELECT COUNT(*) FROM owners WHERE lower(display_name) LIKE '%shlomi%') AS shlomi_owners,
          (SELECT COUNT(*) FROM owners WHERE lower(display_name) = lower($1) OR email = $2) AS simon_owners,
          (SELECT COUNT(*) FROM leads) AS leads,
          (SELECT COUNT(*) FROM appointments) AS appointments,
          (SELECT COUNT(*) FROM deals WHERE assigned_rep = $3) AS deals_shlomi,
          (SELECT COUNT(*) FROM tasks WHERE assigned_to = $3) AS tasks_shlomi,
          (SELECT COUNT(*) FROM deal_commissions WHERE recipient_name = $3) AS comm_shlomi,
          (SELECT COUNT(*) FROM lead_submissions WHERE assigned_rep_at_time = $3) AS ls_shlomi,
          (SELECT COUNT(*) FROM appointment_events WHERE actor = $3) AS ae_shlomi
      `, [SIMON_NAME, 'office@tsvisionbuilders.com', SHLOMI_NAME]);
      const after = {
        owners: parseInt(afterRows[0].owners, 10),
        shlomiOwners: parseInt(afterRows[0].shlomi_owners, 10),
        simonOwners: parseInt(afterRows[0].simon_owners, 10),
        leads: parseInt(afterRows[0].leads, 10),
        appointments: parseInt(afterRows[0].appointments, 10),
        dealsShlomi: parseInt(afterRows[0].deals_shlomi, 10),
        tasksShlomi: parseInt(afterRows[0].tasks_shlomi, 10),
        commShlomi: parseInt(afterRows[0].comm_shlomi, 10),
        lsShlomi: parseInt(afterRows[0].ls_shlomi, 10),
        aeShlomi: parseInt(afterRows[0].ae_shlomi, 10),
      };
      console.log(`AFTER ROLLBACK (fresh): ${JSON.stringify(after)}`);

      if (!before) {
        failures.push('before was never captured (unexpected early failure)');
      } else {
        const keys = ['owners', 'shlomiOwners', 'simonOwners', 'leads', 'appointments', 'dealsShlomi', 'tasksShlomi', 'commShlomi', 'lsShlomi', 'aeShlomi'];
        for (const k of keys) {
          if (after[k] !== before[k]) failures.push(`${k} changed: ${before[k]} → ${after[k]} — ROLLBACK LEAK`);
          else console.log(`✅ ${k} unchanged: ${before[k]} → ${after[k]}`);
        }
      }
    } finally {
      freshClient.release();
    }
  }

  // ── FINAL REPORT ────────────────────────────────────────────────────────────
  console.log('\n=== SHLOMI MERGE ROLLBACK VALIDATION COMPLETE ===');
  if (mergeReport) {
    console.log(`Merge result:\n  ${JSON.stringify(mergeReport, null, 2)}`);
  }
  if (preAudit) {
    console.log(`\nPre-merge Shlomi references: ${preAudit.shlomiRefs.length} (${preAudit.rePoint.length} re-point, ${preAudit.preserve.length} preserve)`);
  }
  console.log(`\nBEFORE: ${JSON.stringify(before)}`);
  console.log(`Validation failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error('\n❌ VALIDATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n✅ ALL VALIDATION CHECKS PASSED — Shlomi→Simon merge verified, rollback is clean');
  console.log('   Next: run the permanent merge (node scripts/mergeShlomiIntoSimon.js), then');
  console.log('   re-run SmallDatasets rollback validation (node scripts/rollbackValidateSmallDatasets.js).');
  process.exit(0);
}

rollbackValidate().catch(e => {
  console.error('[rollback-validate-shlomi] FATAL:', e);
  process.exit(1);
});