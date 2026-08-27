/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateLeadSubmissions.js — Production-path rollback validation for
 * lead_submissions: runs the EXACT same runLeadSubmissionMigration() function
 * used by the production script, inside a transaction that is ALWAYS ROLLED
 * BACK. Validates FK resolution (lead_id), NOT NULL constraints, UNIQUE
 * (external_ref), field values, and all 3 Base44 LeadSubmission records.
 *
 * Zero permanent writes. Safe to run any time.
 *
 * Environment: DATABASE_URL, WORKER_SECRET (for migrationReader).
 */
const { pool, query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, hasBase44Creds } = require('./migrationHelpers');
const { runLeadSubmissionMigration } = require('./migrateLeadSubmissionsToRailway');

async function main() {
  console.log('=== LEAD SUBMISSION ROLLBACK VALIDATION (ALWAYS ROLLBACK) ===');
  console.log('Started:', new Date().toISOString());

  if (!hasBase44Creds()) {
    console.error('FATAL: WORKER_SECRET not set — cannot read Base44 source data');
    process.exit(1);
  }

  // ── Pre-migration: fetch Base44 source data for audit ────────────────────
  console.log('\n=== PHASE 1: FETCH BASE44 SOURCE DATA ===');
  const base44Items = await fetchBase44Entity('LeadSubmission');
  console.log(`Base44 LeadSubmission records: ${base44Items.length}`);

  if (base44Items.length === 0) {
    console.log('No records to validate — EXITING (VERIFIED ZERO)');
    await pool.end();
    return;
  }

  // ── Pre-migration: Railway before-count ──────────────────────────────────
  const beforeCount = parseInt((await query('SELECT COUNT(*) as cnt FROM lead_submissions')).rows[0].cnt, 10);
  console.log(`Railway lead_submissions BEFORE: ${beforeCount} rows`);

  // ── Pre-migration: FK audit ────────────────────────────────────────────────
  console.log('\n=== PHASE 1.5: FK AUDIT ===');
  const leadIdCache = await buildLeadIdCache(query);
  let resolved = 0, unresolved = 0;
  for (const item of base44Items) {
    if (item.lead_id && leadIdCache[String(item.lead_id)]) {
      resolved++;
    } else if (item.lead_id) {
      unresolved++;
      console.log(`  UNRESOLVED: submission ${item.id} → lead_id ${item.lead_id} not in Railway`);
    }
  }
  console.log(`FK resolution: ${resolved} resolved, ${unresolved} unresolved (out of ${base44Items.length})`);

  // ── Pre-migration: field-level audit ──────────────────────────────────────
  console.log('\n=== PHASE 1.6: FIELD-LEVEL AUDIT ===');
  for (const item of base44Items) {
    const issues = [];
    if (!item.id) issues.push('missing id (external_ref)');
    if (!item.lead_id) issues.push('missing lead_id');
    if (!item.submitted_at && !item.created_date) issues.push('missing submitted_at/created_date');
    if (item.submission_number === undefined || item.submission_number === null) issues.push('missing submission_number (will default to 1)');
    if (item.was_reactivation === undefined) issues.push('was_reactivation undefined (will default to false)');
    if (issues.length > 0) {
      console.log(`  ${item.id}: ${issues.join(', ')}`);
    }
  }

  // ── Phase 2: Run migration inside BEGIN / ROLLBACK ────────────────────────
  console.log('\n=== PHASE 2: RUN MIGRATION INSIDE TRANSACTION (ROLLBACK) ===');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qFn = (text, params) => client.query(text, params);

    const result = await runLeadSubmissionMigration(qFn);

    // ── In-transaction verification ──────────────────────────────────────────
    console.log('\n=== PHASE 3: IN-TRANSACTION VERIFICATION ===');
    const inTxCount = parseInt((await qFn('SELECT COUNT(*) as cnt FROM lead_submissions')).rows[0].cnt, 10);
    console.log(`Railway lead_submissions IN-TX: ${inTxCount} rows`);

    const expectedCount = beforeCount + result.created;
    if (inTxCount !== expectedCount) {
      throw new Error(`COUNT MISMATCH: expected ${expectedCount} (before ${beforeCount} + created ${result.created}), got ${inTxCount}`);
    }
    console.log(`Count check: PASS ✅ (${inTxCount} = ${beforeCount} + ${result.created})`);

    // Verify all 3 external_refs are present
    const externalRefs = base44Items.map(i => String(i.id));
    const { rows: foundRows } = await qFn(
      'SELECT external_ref FROM lead_submissions WHERE external_ref = ANY($1)',
      [externalRefs]
    );
    const foundRefs = foundRows.map(r => r.external_ref);
    const missingRefs = externalRefs.filter(r => !foundRefs.includes(r));
    if (missingRefs.length > 0) {
      throw new Error(`MISSING external_refs in Railway: ${missingRefs.join(', ')}`);
    }
    console.log(`All ${externalRefs.length} external_refs present: PASS ✅`);

    // Verify FK: all lead_ids are valid UUIDs pointing to leads
    const { rows: fkCheck } = await qFn(
      `SELECT ls.external_ref, ls.lead_id, l.id as leads_id
       FROM lead_submissions ls
       LEFT JOIN leads l ON l.id = ls.lead_id
       WHERE ls.external_ref = ANY($1) AND l.id IS NULL`,
      [externalRefs]
    );
    if (fkCheck.length > 0) {
      throw new Error(`FK VIOLATION: ${fkCheck.length} submissions have lead_id not in leads table`);
    }
    console.log(`FK integrity (lead_id → leads): PASS ✅`);

    // Verify field values for each record
    console.log('\n=== PHASE 3.1: FIELD-VALUE VERIFICATION ===');
    for (const item of base44Items) {
      const { rows } = await qFn(
        'SELECT lead_id, submitted_at, source, form_type, project_type, submission_number, was_reactivation FROM lead_submissions WHERE external_ref = $1',
        [String(item.id)]
      );
      const row = rows[0];
      if (!row) { throw new Error(`Record ${item.id} not found after insert`); }
      const expectedLeadId = leadIdCache[String(item.lead_id)];
      if (row.lead_id !== expectedLeadId) {
        throw new Error(`lead_id mismatch for ${item.id}: expected ${expectedLeadId}, got ${row.lead_id}`);
      }
      if (row.submission_number !== (item.submission_number || 1)) {
        throw new Error(`submission_number mismatch for ${item.id}: expected ${item.submission_number || 1}, got ${row.submission_number}`);
      }
      if (row.was_reactivation !== (item.was_reactivation === true)) {
        throw new Error(`was_reactivation mismatch for ${item.id}: expected ${item.was_reactivation === true}, got ${row.was_reactivation}`);
      }
      console.log(`  ${item.id}: lead_id ✅, submission_number ✅, was_reactivation ✅`);
    }

    // ── Rollback ─────────────────────────────────────────────────────────────
    console.log('\n=== PHASE 4: ROLLBACK ===');
    await client.query('ROLLBACK');
    console.log('ROLLED BACK ✅');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('\nFATAL — ROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  // ── Phase 5: Post-rollback verification ───────────────────────────────────
  console.log('\n=== PHASE 5: POST-ROLLBACK VERIFICATION ===');
  const afterCount = parseInt((await query('SELECT COUNT(*) as cnt FROM lead_submissions')).rows[0].cnt, 10);
  console.log(`Railway lead_submissions AFTER: ${afterCount} rows`);

  if (afterCount !== beforeCount) {
    console.error(`❌ ROLLBACK FAILED: before=${beforeCount}, after=${afterCount}`);
    process.exitCode = 1;
  } else {
    console.log(`Rollback verified: ${afterCount} === ${beforeCount} ✅`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  console.log(`Base44 records: ${base44Items.length}`);
  console.log(`FK resolved: ${resolved}, unresolved: ${unresolved}`);
  console.log(`Before: ${beforeCount}, After: ${afterCount}`);
  console.log(`Result: ${afterCount === beforeCount ? 'PASS ✅' : 'FAIL ❌'}`);

  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = { main };