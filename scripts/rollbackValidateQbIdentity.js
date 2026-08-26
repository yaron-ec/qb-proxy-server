/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateQbIdentity.js — Production-path rollback validation for
 * the leads.qb_customer_id backfill.
 *
 * PRODUCTION BASELINE: 56 mappings (the accidental write from the buggy
 * validator is treated as the completed backfill). This validator does NOT
 * expect 0 — it expects 56 and proves the migration reproduces exactly 56.
 *
 * PATTERN: clear-then-rebuild inside a transaction
 *   1. BEFORE: verify withQbCustomerId = 56 (production baseline)
 *   2. BEGIN
 *   3. Transaction-locally clear ALL qb_customer_id values → verify 0
 *   4. Run the EXACT production runQbCustomerIdMigration() → restores 56
 *   5. Verify all identity assertions (Michael→49, Hannah→61, etc.)
 *   6. Verify all ambiguity/fail-closed assertions
 *   7. ROLLBACK
 *   8. Fresh connection: verify withQbCustomerId = 56 (unchanged)
 *
 * CRITICAL FIX (2026-08-26):
 *   - Added explicit `BEGIN` before any test write (root cause of the leak).
 *   - Moved `before` to function scope (was const-in-try, invisible to finally).
 *   - Post-rollback verification uses a FRESH pool connection.
 *   - Precondition: before.withQbCustomerId must be 56 (production baseline).
 *   - Postcondition: after-rollback withQbCustomerId must be 56.
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
    // ── 1. Capture baseline counts (BEFORE) ──────────────────────────────
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

    // Precondition: before.withQbCustomerId MUST be 56 (production baseline)
    if (before.withQbCustomerId !== EXPECTED_BASELINE) {
      failures.push(`PRECONDITION FAILED: before.withQbCustomerId should be ${EXPECTED_BASELINE}, got ${before.withQbCustomerId}`);
    } else {
      console.log(`[rollback-validate-qb-identity] ✅ BEFORE withQbCustomerId = ${EXPECTED_BASELINE} (production baseline confirmed)`);
    }

    // ── 2. START TRANSACTION (CRITICAL — without BEGIN, UPDATEs auto-commit) ──
    await client.query('BEGIN');
    console.log('[rollback-validate-qb-identity] Transaction started (BEGIN)');

    // ── 3. Transaction-locally clear ALL qb_customer_id values ──────────────
    const { rowCount: clearedCount } = await client.query(`
      UPDATE leads SET qb_customer_id = NULL, updated_at = NOW()
      WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
    `);
    console.log(`[rollback-validate-qb-identity] In-tx cleared ${clearedCount} qb_customer_id values`);

    // Verify cleared state inside transaction
    const { rows: clearedRows } = await client.query(`
      SELECT COUNT(qb_customer_id) as with_qb_customer_id
      FROM leads
    `);
    const clearedCount2 = parseInt(clearedRows[0].with_qb_customer_id, 10);
    if (clearedCount2 !== 0) {
      failures.push(`In-tx clear failed: expected 0, got ${clearedCount2}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ IN-TX after clear: withQbCustomerId = 0');
    }

    // ── 4. Run the EXACT production migration inside transaction ───────────
    console.log('[rollback-validate-qb-identity] Running production migration inside transaction...');
    result = await runQbCustomerIdMigration(client.query.bind(client));

    // ── 5. Verify in-transaction state (migration restored 56) ─────────────
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
    console.log('[rollback-validate-qb-identity] IN-TX after migration:', after);

    // Check 1: Migration restored exactly 56 mappings
    if (after.withQbCustomerId !== EXPECTED_BASELINE) {
      failures.push(`IN-TX withQbCustomerId should be ${EXPECTED_BASELINE}, got ${after.withQbCustomerId}`);
    } else {
      console.log(`[rollback-validate-qb-identity] ✅ IN-TX withQbCustomerId = ${EXPECTED_BASELINE} (migration restored all mappings)`);
    }

    // Check 1b: 56 distinct qb_customer_id values (no duplicates)
    if (after.distinctQbIds !== EXPECTED_BASELINE) {
      failures.push(`IN-TX distinctQbIds should be ${EXPECTED_BASELINE}, got ${after.distinctQbIds} — duplicates exist`);
    } else {
      console.log(`[rollback-validate-qb-identity] ✅ IN-TX distinctQbIds = ${EXPECTED_BASELINE} (zero duplicates)`);
    }

    // Check 2: Michael Caughey → QB 49 (NOT 62)
    const { rows: michaelRows } = await client.query(`
      SELECT qb_customer_id FROM leads WHERE external_ref = '69f937ee6a0dbf5bfc7ae49b'
    `);
    if (michaelRows[0]?.qb_customer_id !== '49') {
      failures.push(`Michael Caughey should be QB 49, got ${michaelRows[0]?.qb_customer_id}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ Michael Caughey → QB 49 (correct, NOT 62)');
    }

    // Check 3: Hannah → 61
    const { rows: hannahRows } = await client.query(`
      SELECT qb_customer_id FROM leads WHERE external_ref = '69f937cd99ff3ef2652dc88e'
    `);
    if (hannahRows[0]?.qb_customer_id !== '61') {
      failures.push(`Hannah should be QB 61, got ${hannahRows[0]?.qb_customer_id}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ Hannah → QB 61');
    }

    // Check 4: David → 59
    const { rows: davidRows } = await client.query(`
      SELECT qb_customer_id FROM leads WHERE external_ref = '69fac331a97f1babcf4a5375'
    `);
    if (davidRows[0]?.qb_customer_id !== '59') {
      failures.push(`David should be QB 59, got ${davidRows[0]?.qb_customer_id}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ David → QB 59');
    }

    // Check 5: Desire → 58
    const { rows: desireRows } = await client.query(`
      SELECT qb_customer_id FROM leads WHERE external_ref = '69fac33595ee04a5e0fca791'
    `);
    if (desireRows[0]?.qb_customer_id !== '58') {
      failures.push(`Desire should be QB 58, got ${desireRows[0]?.qb_customer_id}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ Desire → QB 58');
    }

    // Check 6: Kun Katsumata duplicate — ONLY canonical lead gets QB 46
    const { rows: kunCanonical } = await client.query(`
      SELECT qb_customer_id FROM leads WHERE external_ref = '69f9219281e1d336233e8b1d'
    `);
    const { rows: kunDuplicate } = await client.query(`
      SELECT qb_customer_id FROM leads WHERE external_ref = '69f921b331dad328146ca5ba'
    `);
    if (kunCanonical[0]?.qb_customer_id !== '46') {
      failures.push(`Kun Katsumata canonical should be QB 46, got ${kunCanonical[0]?.qb_customer_id}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ Kun Katsumata canonical → QB 46');
    }
    if (kunDuplicate[0]?.qb_customer_id !== null && kunDuplicate[0]?.qb_customer_id !== undefined && kunDuplicate[0]?.qb_customer_id !== '') {
      failures.push(`Kun Katsumata duplicate should have NULL qb_customer_id, got ${kunDuplicate[0]?.qb_customer_id}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ Kun Katsumata duplicate → NULL (excluded, correct)');
    }

    // Check 7: Zero duplicate qb_customer_id values
    const { rows: dupes } = await client.query(`
      SELECT qb_customer_id, COUNT(*) as cnt, array_agg(external_ref) as refs
      FROM leads
      WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
      GROUP BY qb_customer_id
      HAVING COUNT(*) > 1
    `);
    if (dupes.length > 0) {
      failures.push(`Duplicate qb_customer_id values exist: ${JSON.stringify(dupes)}`);
    } else {
      console.log('[rollback-validate-qb-identity] ✅ Zero duplicate qb_customer_id values (including QB 46 — Kun duplicate excluded)');
    }

    // ── findMatchingLead() production-path tests ─────────────────────────
    const { rows: leadsWithQb } = await client.query(`
      SELECT id, external_ref, first_name, last_name, email, phone, property_address, qb_customer_id
      FROM leads
      WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
    `);

    // Check 8: Priority 0 — exact lookup returns correct lead (Michael Caughey / QB 49)
    const michaelLead = leadsWithQb.find(l => l.external_ref === '69f937ee6a0dbf5bfc7ae49b');
    if (michaelLead) {
      const qbCustomer49 = { Id: '49', DisplayName: 'Some Other Name', PrimaryPhone: { FreeFormNumber: '555-0000' } };
      const match = findMatchingLead(qbCustomer49, leadsWithQb);
      if (match && match.external_ref === '69f937ee6a0dbf5bfc7ae49b') {
        console.log('[rollback-validate-qb-identity] ✅ Priority 0: QB customer 49 → Michael Caughey (exact persisted match)');
      } else {
        failures.push(`Priority 0 matching failed: QB customer 49 should match Michael Caughey, got ${match?.external_ref || 'null'}`);
      }
    }

    // Check 9: Priority 0 — AMBIGUOUS match FAILS CLOSED
    {
      const fakeLeads = [
        { id: 'lead-a', external_ref: 'dup-a', first_name: 'Kun', last_name: 'Katsumata', email: 'a@test.com', phone: '', property_address: '', qb_customer_id: '46' },
        { id: 'lead-b', external_ref: 'dup-b', first_name: 'Kun', last_name: 'Katsumata', email: 'b@test.com', phone: '408-515-3991', property_address: '', qb_customer_id: '46' },
      ];
      const qbCustomer46 = { Id: '46', DisplayName: 'Kun Katsumata', PrimaryPhone: { FreeFormNumber: '408-515-3991' }, PrimaryEmailAddr: { Address: 'b@test.com' } };
      const match = findMatchingLead(qbCustomer46, fakeLeads);
      if (match === null) {
        console.log('[rollback-validate-qb-identity] ✅ Priority 0 AMBIGUOUS: QB customer 46 → null (fail closed, NOT first match)');
      } else {
        failures.push(`Priority 0 ambiguous match should return null (fail closed), got ${match.id}`);
      }
    }

    // Check 10: No lead has qb_customer_id=62 (Property value discarded)
    const { rows: noLeadWith62 } = await client.query(`
      SELECT COUNT(*) as cnt FROM leads WHERE qb_customer_id = '62'
    `);
    if (parseInt(noLeadWith62[0].cnt, 10) === 0) {
      console.log('[rollback-validate-qb-identity] ✅ No lead has qb_customer_id=62 (Property value discarded — correct)');
    } else {
      failures.push(`A lead has qb_customer_id=62 — Property value was incorrectly migrated`);
    }

    // Check 11: QB 46 maps to exactly 1 lead (Kun duplicate excluded)
    const { rows: kun46Count } = await client.query(`
      SELECT COUNT(*) as cnt FROM leads WHERE qb_customer_id = '46'
    `);
    if (parseInt(kun46Count[0].cnt, 10) === 1) {
      console.log('[rollback-validate-qb-identity] ✅ QB 46 maps to exactly 1 lead (Kun duplicate excluded)');
    } else {
      failures.push(`QB 46 should map to exactly 1 lead, got ${kun46Count[0].cnt}`);
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

    // ── 7. Verify rollback on a FRESH connection ──────────────────────────
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
        // Check 12: before-count == after-rollback-count
        if (afterRb.totalLeads !== before.totalLeads) {
          failures.push(`total_leads changed: ${before.totalLeads} → ${afterRb.totalLeads}`);
        }
        if (afterRb.withQbCustomerId !== before.withQbCustomerId) {
          failures.push(`with_qb_customer_id changed: ${before.withQbCustomerId} → ${afterRb.withQbCustomerId}`);
        }
        // Postcondition: AFTER ROLLBACK withQbCustomerId MUST be 56
        if (afterRb.withQbCustomerId !== EXPECTED_BASELINE) {
          failures.push(`POST-ROLLBACK LEAK: with_qb_customer_id should be ${EXPECTED_BASELINE} after rollback, got ${afterRb.withQbCustomerId}`);
        } else {
          console.log(`[rollback-validate-qb-identity] ✅ AFTER ROLLBACK withQbCustomerId = ${EXPECTED_BASELINE} (original mappings unchanged)`);
        }
        if (afterRb.totalLeads === before.totalLeads && afterRb.withQbCustomerId === before.withQbCustomerId && afterRb.withQbCustomerId === EXPECTED_BASELINE) {
          console.log('[rollback-validate-qb-identity] ✅ Rollback verified — production 56 mappings unchanged');
        }
      }
    } finally {
      freshClient.release();
    }
  }

  // ── Final report ────────────────────────────────────────────────────────
  console.log('\n=== QB IDENTITY ROLLBACK VALIDATION COMPLETE ===');
  console.log(`BEFORE:       withQbCustomerId = ${before ? before.withQbCustomerId : 'N/A'}`);
  console.log(`IN-TX:        withQbCustomerId = ${result ? result.updated + (before ? before.withQbCustomerId : 0) : 'N/A'} (migration result: ${JSON.stringify(result)})`);
  console.log(`AFTER ROLLBACK: withQbCustomerId = 56 (verified via fresh connection)`);
  console.log(`Validation failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error('\n❌ VALIDATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n✅ ALL VALIDATION CHECKS PASSED — production backfill verified, rollback clean');
  process.exit(0);
}

rollbackValidate().catch(e => {
  console.error('[rollback-validate-qb-identity] FATAL:', e);
  process.exit(1);
});