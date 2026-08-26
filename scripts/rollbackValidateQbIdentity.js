/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateQbIdentity.js — Production-path rollback validation for
 * the leads.qb_customer_id backfill.
 *
 * PRODUCTION BASELINE: 56 mappings (the accidental write from the missing-BEGIN
 * bug already produced the correct canonical state). This validator does NOT
 * expect 0 — it expects 56 and proves the migration reproduces exactly 56
 * inside a transaction that is ALWAYS ROLLED BACK.
 *
 * Flow:
 *   1. BEFORE: audit current production state (56 mappings, all identities)
 *   2. BEGIN
 *   3. Transaction-locally CLEAR all qb_customer_id to NULL
 *   4. Run the EXACT production runQbCustomerIdMigration() — restores 56
 *   5. IN-TX: verify 56 restored, all identity assertions, fail-closed tests
 *   6. ROLLBACK
 *   7. AFTER ROLLBACK (fresh connection): verify original 56 unchanged
 *
 * CRITICAL FIX (2026-08-26):
 *   - Added explicit BEGIN before any writes (root cause of the original leak).
 *   - `before` declared in function scope (was const-in-try, invisible to finally).
 *   - Post-rollback verification uses a FRESH pool connection.
 *   - Baseline is 56, NOT 0 — the accidental write IS the completed backfill.
 */
const { pool } = require('../db/client');
const { runQbCustomerIdMigration } = require('./migrateQbCustomerIdToRailway');
const { findMatchingLead } = require('../lib/qbMatch');

const EXPECTED_BASELINE = 56;

async function rollbackValidate() {
  const client = await pool.connect();
  let result = null;
  const failures = [];
  let before = null; // function-scoped so `finally` can access it

  try {
    // ── 1. BEFORE: audit current production state ────────────────────────
    const { rows: beforeRows } = await client.query(`
      SELECT COUNT(*) as total_leads,
             COUNT(qb_customer_id) as with_qb_customer_id,
             COUNT(DISTINCT qb_customer_id) as distinct_qb_ids
      FROM leads
    `);
    before = {
      totalLeads: parseInt(beforeRows[0].total_leads, 10),
      withQbCustomerId: parseInt(beforeRows[0].with_qb_customer_id, 10),
      distinctQbIds: parseInt(beforeRows[0].distinct_qb_ids, 10),
    };
    console.log('[rollback-validate-qb-identity] BEFORE:', before);

    // Precondition: before.withQbCustomerId must be 56 (accidental backfill)
    if (before.withQbCustomerId !== EXPECTED_BASELINE) {
      failures.push(`PRECONDITION: before.withQbCustomerId should be ${EXPECTED_BASELINE}, got ${before.withQbCustomerId}`);
    }
    if (before.distinctQbIds !== EXPECTED_BASELINE) {
      failures.push(`PRECONDITION: before.distinctQbIds should be ${EXPECTED_BASELINE}, got ${before.distinctQbIds}`);
    }

    // BEFORE identity assertions
    const { rows: beforeMichael } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f937ee6a0dbf5bfc7ae49b'`);
    const { rows: beforeHannah } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f937cd99ff3ef2652dc88e'`);
    const { rows: beforeDavid } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69fac331a97f1babcf4a5375'`);
    const { rows: beforeDesire } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69fac33595ee04a5e0fca791'`);
    const { rows: beforeKunCanon } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f9219281e1d336233e8b1d'`);
    const { rows: beforeKunDup } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f921b331dad328146ca5ba'`);
    const { rows: beforeDupes } = await client.query(`
      SELECT qb_customer_id, COUNT(*) as cnt FROM leads
      WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
      GROUP BY qb_customer_id HAVING COUNT(*) > 1
    `);

    if (beforeMichael[0]?.qb_customer_id !== '49') failures.push(`BEFORE Michael Caughey should be QB 49, got ${beforeMichael[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ BEFORE Michael Caughey → QB 49');
    if (beforeHannah[0]?.qb_customer_id !== '61') failures.push(`BEFORE Hannah should be QB 61, got ${beforeHannah[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ BEFORE Hannah → QB 61');
    if (beforeDavid[0]?.qb_customer_id !== '59') failures.push(`BEFORE David should be QB 59, got ${beforeDavid[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ BEFORE David → QB 59');
    if (beforeDesire[0]?.qb_customer_id !== '58') failures.push(`BEFORE Desire should be QB 58, got ${beforeDesire[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ BEFORE Desire → QB 58');
    if (beforeKunCanon[0]?.qb_customer_id !== '46') failures.push(`BEFORE Kun canonical should be QB 46, got ${beforeKunCanon[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ BEFORE Kun canonical → QB 46');
    if (beforeKunDup[0]?.qb_customer_id !== null && beforeKunDup[0]?.qb_customer_id !== '') failures.push(`BEFORE Kun duplicate should be NULL, got ${beforeKunDup[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ BEFORE Kun duplicate → NULL');
    if (beforeDupes.length > 0) failures.push(`BEFORE has ${beforeDupes.length} duplicate qb_customer_id values`);
    else console.log('[rollback-validate-qb-identity] ✅ BEFORE zero duplicate qb_customer_id values');

    // If BEFORE audit failed, don't proceed to transaction
    if (failures.length > 0) {
      console.error('[rollback-validate-qb-identity] BEFORE audit FAILED — aborting before transaction');
      throw new Error('BEFORE audit failed');
    }

    // ── 2. BEGIN TRANSACTION (CRITICAL — without BEGIN, UPDATEs auto-commit) ──
    await client.query('BEGIN');
    console.log('[rollback-validate-qb-identity] Transaction started (BEGIN)');

    // ── 3. Transaction-locally CLEAR all qb_customer_id to NULL ──────────────
    // This creates a reversible transaction-only state (0 mappings) so the
    // migration can be proven to restore exactly 56 from scratch.
    const { rowCount: clearedCount } = await client.query(`
      UPDATE leads SET qb_customer_id = NULL, updated_at = NOW()
      WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
    `);
    console.log(`[rollback-validate-qb-identity] IN-TX cleared ${clearedCount} qb_customer_id values to NULL`);

    const { rows: afterClearRows } = await client.query(`
      SELECT COUNT(qb_customer_id) as with_qb_customer_id FROM leads
    `);
    const afterClear = parseInt(afterClearRows[0].with_qb_customer_id, 10);
    console.log(`[rollback-validate-qb-identity] IN-TX after clear: withQbCustomerId = ${afterClear}`);
    if (afterClear !== 0) {
      failures.push(`IN-TX after clear should be 0, got ${afterClear}`);
    }

    // ── 4. Run the EXACT production migration inside the transaction ──────────
    console.log('[rollback-validate-qb-identity] Running production migration inside transaction...');
    result = await runQbCustomerIdMigration(client.query.bind(client));

    // ── 5. IN-TX: verify migration restored exactly 56 ───────────────────────
    const { rows: afterRows } = await client.query(`
      SELECT COUNT(*) as total_leads,
             COUNT(qb_customer_id) as with_qb_customer_id,
             COUNT(DISTINCT qb_customer_id) as distinct_qb_ids
      FROM leads
    `);
    const after = {
      totalLeads: parseInt(afterRows[0].total_leads, 10),
      withQbCustomerId: parseInt(afterRows[0].with_qb_customer_id, 10),
      distinctQbIds: parseInt(afterRows[0].distinct_qb_ids, 10),
    };
    console.log('[rollback-validate-qb-identity] IN-TX (after migration):', after);

    if (after.withQbCustomerId !== EXPECTED_BASELINE) {
      failures.push(`IN-TX withQbCustomerId should be ${EXPECTED_BASELINE}, got ${after.withQbCustomerId}`);
    } else {
      console.log(`[rollback-validate-qb-identity] ✅ IN-TX withQbCustomerId = ${EXPECTED_BASELINE}`);
    }
    if (after.distinctQbIds !== EXPECTED_BASELINE) {
      failures.push(`IN-TX distinctQbIds should be ${EXPECTED_BASELINE}, got ${after.distinctQbIds}`);
    }

    // IN-TX identity assertions
    const { rows: michaelRows } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f937ee6a0dbf5bfc7ae49b'`);
    if (michaelRows[0]?.qb_customer_id !== '49') failures.push(`IN-TX Michael should be QB 49, got ${michaelRows[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX Michael Caughey → QB 49');

    const { rows: hannahRows } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f937cd99ff3ef2652dc88e'`);
    if (hannahRows[0]?.qb_customer_id !== '61') failures.push(`IN-TX Hannah should be QB 61, got ${hannahRows[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX Hannah → QB 61');

    const { rows: davidRows } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69fac331a97f1babcf4a5375'`);
    if (davidRows[0]?.qb_customer_id !== '59') failures.push(`IN-TX David should be QB 59, got ${davidRows[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX David → QB 59');

    const { rows: desireRows } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69fac33595ee04a5e0fca791'`);
    if (desireRows[0]?.qb_customer_id !== '58') failures.push(`IN-TX Desire should be QB 58, got ${desireRows[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX Desire → QB 58');

    const { rows: kunCanonical } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f9219281e1d336233e8b1d'`);
    if (kunCanonical[0]?.qb_customer_id !== '46') failures.push(`IN-TX Kun canonical should be QB 46, got ${kunCanonical[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX Kun canonical → QB 46');

    const { rows: kunDuplicate } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f921b331dad328146ca5ba'`);
    if (kunDuplicate[0]?.qb_customer_id !== null && kunDuplicate[0]?.qb_customer_id !== '') failures.push(`IN-TX Kun duplicate should be NULL, got ${kunDuplicate[0]?.qb_customer_id}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX Kun duplicate → NULL');

    // IN-TX duplicate check
    const { rows: dupes } = await client.query(`
      SELECT qb_customer_id, COUNT(*) as cnt FROM leads
      WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
      GROUP BY qb_customer_id HAVING COUNT(*) > 1
    `);
    if (dupes.length > 0) failures.push(`IN-TX has ${dupes.length} duplicate qb_customer_id values: ${JSON.stringify(dupes)}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX zero duplicate qb_customer_id values');

    // IN-TX: Michael Caughey does NOT have qb_customer_id=62 (Property value discarded)
    // Note: Ryan Ramos legitimately has qb_customer_id=62 — that's a different lead.
    const { rows: michaelNot62 } = await client.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f937ee6a0dbf5bfc7ae49b'`);
    if (michaelNot62[0]?.qb_customer_id === '62') failures.push(`IN-TX Michael Caughey has qb_customer_id=62 (Property value not discarded)`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX Michael Caughey does NOT have qb_customer_id=62 (Property value discarded)');

    // IN-TX: QB 46 maps to exactly 1 lead
    const { rows: qb46Count } = await client.query(`SELECT COUNT(*) as cnt FROM leads WHERE qb_customer_id = '46'`);
    if (parseInt(qb46Count[0].cnt, 10) !== 1) failures.push(`IN-TX QB 46 should map to 1 lead, got ${qb46Count[0].cnt}`);
    else console.log('[rollback-validate-qb-identity] ✅ IN-TX QB 46 maps to exactly 1 lead');

    // ── findMatchingLead() production-path tests ─────────────────────────
    const { rows: leadsWithQb } = await client.query(`
      SELECT id, external_ref, first_name, last_name, email, phone, property_address, qb_customer_id
      FROM leads WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
    `);

    // Priority 0: exact lookup returns correct lead
    const michaelLead = leadsWithQb.find(l => l.external_ref === '69f937ee6a0dbf5bfc7ae49b');
    if (michaelLead) {
      const qbCustomer49 = { Id: '49', DisplayName: 'Some Other Name', PrimaryPhone: { FreeFormNumber: '555-0000' } };
      const match = findMatchingLead(qbCustomer49, leadsWithQb);
      if (match && match.external_ref === '69f937ee6a0dbf5bfc7ae49b') {
        console.log('[rollback-validate-qb-identity] ✅ Priority 0: QB 49 → Michael Caughey (exact persisted match)');
      } else {
        failures.push(`Priority 0: QB 49 should match Michael, got ${match?.external_ref || 'null'}`);
      }
    }

    // Priority 0: AMBIGUOUS match FAILS CLOSED
    {
      const fakeLeads = [
        { id: 'lead-a', external_ref: 'dup-a', first_name: 'Kun', last_name: 'Katsumata', email: 'a@test.com', phone: '', property_address: '', qb_customer_id: '46' },
        { id: 'lead-b', external_ref: 'dup-b', first_name: 'Kun', last_name: 'Katsumata', email: 'b@test.com', phone: '408-515-3991', property_address: '', qb_customer_id: '46' },
      ];
      const qbCustomer46 = { Id: '46', DisplayName: 'Kun Katsumata', PrimaryPhone: { FreeFormNumber: '408-515-3991' }, PrimaryEmailAddr: { Address: 'b@test.com' } };
      const match = findMatchingLead(qbCustomer46, fakeLeads);
      if (match === null) {
        console.log('[rollback-validate-qb-identity] ✅ Priority 0 AMBIGUOUS: QB 46 → null (fail closed)');
      } else {
        failures.push(`Priority 0 ambiguous should return null, got ${match.id}`);
      }
    }

  } catch (e) {
    console.error('[rollback-validate-qb-identity] Error during validation:', e.message);
    failures.push(`Exception: ${e.message}`);
  } finally {
    // ── 6. ALWAYS ROLLBACK ───────────────────────────────────────────────
    console.log('[rollback-validate-qb-identity] Rolling back transaction...');
    try {
      await client.query('ROLLBACK');
      console.log('[rollback-validate-qb-identity] ROLLBACK executed');
    } catch (rbErr) {
      console.error('[rollback-validate-qb-identity] ROLLBACK failed:', rbErr.message);
      failures.push(`ROLLBACK failed: ${rbErr.message}`);
    }
    client.release();

    // ── 7. Verify rollback on a FRESH connection ───────────────────────────
    const freshClient = await pool.connect();
    try {
      const { rows: afterRollback } = await freshClient.query(`
        SELECT COUNT(*) as total_leads,
               COUNT(qb_customer_id) as with_qb_customer_id,
               COUNT(DISTINCT qb_customer_id) as distinct_qb_ids
        FROM leads
      `);
      const afterRb = {
        totalLeads: parseInt(afterRollback[0].total_leads, 10),
        withQbCustomerId: parseInt(afterRollback[0].with_qb_customer_id, 10),
        distinctQbIds: parseInt(afterRollback[0].distinct_qb_ids, 10),
      };
      console.log('[rollback-validate-qb-identity] AFTER ROLLBACK (fresh connection):', afterRb);

      if (!before) {
        failures.push('before was never captured (unexpected early failure)');
      } else {
        if (afterRb.totalLeads !== before.totalLeads) {
          failures.push(`total_leads changed: ${before.totalLeads} → ${afterRb.totalLeads}`);
        }
        if (afterRb.withQbCustomerId !== before.withQbCustomerId) {
          failures.push(`with_qb_customer_id changed: ${before.withQbCustomerId} → ${afterRb.withQbCustomerId} — ROLLBACK LEAK`);
        }
        if (afterRb.withQbCustomerId !== EXPECTED_BASELINE) {
          failures.push(`POST-ROLLBACK withQbCustomerId should be ${EXPECTED_BASELINE}, got ${afterRb.withQbCustomerId}`);
        } else {
          console.log(`[rollback-validate-qb-identity] ✅ AFTER ROLLBACK withQbCustomerId = ${EXPECTED_BASELINE} (original 56 preserved)`);
        }
        if (afterRb.distinctQbIds !== EXPECTED_BASELINE) {
          failures.push(`POST-ROLLBACK distinctQbIds should be ${EXPECTED_BASELINE}, got ${afterRb.distinctQbIds}`);
        }

        // Post-rollback identity spot-checks
        const { rows: rbMichael } = await freshClient.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f937ee6a0dbf5bfc7ae49b'`);
        if (rbMichael[0]?.qb_customer_id !== '49') failures.push(`POST-ROLLBACK Michael should be QB 49, got ${rbMichael[0]?.qb_customer_id}`);
        else console.log('[rollback-validate-qb-identity] ✅ POST-ROLLBACK Michael Caughey → QB 49');

        const { rows: rbKunCanon } = await freshClient.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f9219281e1d336233e8b1d'`);
        if (rbKunCanon[0]?.qb_customer_id !== '46') failures.push(`POST-ROLLBACK Kun canonical should be QB 46, got ${rbKunCanon[0]?.qb_customer_id}`);
        else console.log('[rollback-validate-qb-identity] ✅ POST-ROLLBACK Kun canonical → QB 46');

        const { rows: rbKunDup } = await freshClient.query(`SELECT qb_customer_id FROM leads WHERE external_ref = '69f921b331dad328146ca5ba'`);
        if (rbKunDup[0]?.qb_customer_id !== null && rbKunDup[0]?.qb_customer_id !== '') failures.push(`POST-ROLLBACK Kun duplicate should be NULL, got ${rbKunDup[0]?.qb_customer_id}`);
        else console.log('[rollback-validate-qb-identity] ✅ POST-ROLLBACK Kun duplicate → NULL');

        const { rows: rbDupes } = await freshClient.query(`
          SELECT COUNT(*) as cnt FROM (
            SELECT qb_customer_id FROM leads WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
            GROUP BY qb_customer_id HAVING COUNT(*) > 1
          ) d
        `);
        if (parseInt(rbDupes[0].cnt, 10) > 0) failures.push(`POST-ROLLBACK has duplicate qb_customer_id values`);
        else console.log('[rollback-validate-qb-identity] ✅ POST-ROLLBACK zero duplicate qb_customer_id values');

        if (afterRb.totalLeads === before.totalLeads
            && afterRb.withQbCustomerId === before.withQbCustomerId
            && afterRb.withQbCustomerId === EXPECTED_BASELINE
            && afterRb.distinctQbIds === EXPECTED_BASELINE) {
          console.log('[rollback-validate-qb-identity] ✅ Rollback verified — original 56 mappings unchanged in production');
        }
      }
    } finally {
      freshClient.release();
    }
  }

  // ── Final report ────────────────────────────────────────────────────────
  console.log('\n=== QB IDENTITY ROLLBACK VALIDATION COMPLETE ===');
  console.log(`BEFORE:       withQbCustomerId = ${before ? before.withQbCustomerId : 'N/A'}`);
  console.log(`IN-TX:        withQbCustomerId = ${result ? result.updated + (before ? before.withQbCustomerId - before.withQbCustomerId : 0) : 'N/A'} (migration updated ${result ? result.updated : 'N/A'})`);
  console.log(`AFTER ROLLBACK: withQbCustomerId = (see fresh connection output above)`);
  console.log(`Migration result: ${JSON.stringify(result)}`);
  console.log(`Validation failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error('\n❌ VALIDATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n✅ ALL VALIDATION CHECKS PASSED — production backfill verified, rollback is clean');
  process.exit(0);
}

rollbackValidate().catch(e => {
  console.error('[rollback-validate-qb-identity] FATAL:', e);
  process.exit(1);
});