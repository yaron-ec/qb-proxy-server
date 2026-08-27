/* eslint-disable no-undef */
'use strict';
/**
 * cleanupTestProbe.js — One-time FULL REMOVAL of the confirmed Railway-native
 * test record "Test Probe".
 *
 * Target: lead "Test Probe" (Railway id c7b3e041-f3fa-4507-8619-6e3c732b3ed4,
 * external_ref NULL, email test@example.com).
 *
 * Why full removal (not just cancellation): appointments are immutable
 * (appointments_no_delete trigger blocks physical DELETE), so a cancelled
 * appointment row still references leads.id via appointments_lead_id_fkey,
 * which blocks deletion of the lead. To fully remove the test fixture we must
 * bypass the immutability trigger for THIS ONE confirmed test appointment only,
 * hard-delete it, then hard-delete the lead — all inside one transaction, with
 * the trigger re-enabled before COMMIT.
 *
 * Safety model (defense in depth):
 *   1. Re-read the lead by exact Railway id AND verify name/email/external_ref
 *      match the reconciliation report. Abort if any field differs.
 *   2. Re-count every dependency table. Abort if ANY table other than
 *      `appointments` has rows, or if `appointments` has a count != 1.
 *   3. Confirm external_ref IS NULL (never touch a Base44-mapped lead).
 *   4. Capture the single appointment id and verify it belongs to the target
 *      lead. Abort if 0 or >1.
 *   5. Inside a single transaction:
 *        a. ALTER TABLE appointments DISABLE TRIGGER appointments_no_delete
 *           (narrow bypass — affects only the appointments table for this tx).
 *        b. DELETE the single confirmed test appointment by id + lead_id.
 *        c. DELETE the test lead, guarded by external_ref IS NULL + name + email.
 *        d. ALTER TABLE appointments ENABLE TRIGGER appointments_no_delete
 *           (restore immutability protection BEFORE commit).
 *        e. COMMIT. Any error at any step → ROLLBACK (trigger auto-restored on
 *           rollback since the ALTER is inside the same tx).
 *   6. Post-cleanup verification: lead gone, appointment gone, trigger active,
 *      no unrelated records changed.
 *
 * READ-ONLY by default (DRY_RUN=1 env or no arg). Pass APPLY=1 (env) to execute.
 *
 * Environment: DATABASE_URL.
 */
const { pool, query } = require('../db/client');

const TARGET_LEAD_ID = 'c7b3e041-f3fa-4507-8619-6e3c732b3ed4';
const TARGET_EMAIL = 'test@example.com';
const TARGET_FIRST = 'Test';
const TARGET_LAST = 'Probe';
const TRIGGER_NAME = 'appointments_no_delete';

// Dependency tables that reference leads.id. appointments is the ONLY allowed
// non-zero dependency (exactly 1 row). All others MUST be 0.
const DEP_TABLES = [
  { table: 'appointments', col: 'lead_id', allowed: 1 },
  { table: 'activities', col: 'lead_id', allowed: 0 },
  { table: 'deals', col: 'lead_id', allowed: 0 },
  { table: 'tasks', col: 'lead_id', allowed: 0 },
  { table: 'estimates', col: 'lead_id', allowed: 0 },
  { table: 'invoices', col: 'lead_id', allowed: 0 },
  { table: 'lead_attachments', col: 'lead_id', allowed: 0 },
  { table: 'deal_expenses', col: 'lead_id', allowed: 0 },
  { table: 'lead_submissions', col: 'lead_id', allowed: 0 },
  { table: 'handoff_estimates', col: 'lead_id', allowed: 0 },
];

async function countDeps(queryFn, leadId) {
  const counts = {};
  for (const d of DEP_TABLES) {
    const { rows } = await queryFn(
      'SELECT COUNT(*)::int AS c FROM ' + d.table + ' WHERE ' + d.col + ' = $1',
      [leadId]
    );
    counts[d.table] = rows[0].c;
  }
  return counts;
}

async function runCleanup(queryFn = query, apply = false) {
  console.log('=== TEST PROBE FULL REMOVAL ===');
  console.log('Mode: ' + (apply ? 'APPLY (writes enabled)' : 'DRY-RUN (read-only)'));
  console.log('Target lead id: ' + TARGET_LEAD_ID);
  console.log('');

  // ── Phase 1: Re-read and verify identity ────────────────────────────────
  const { rows: leadRows } = await queryFn(
    'SELECT id, external_ref, first_name, last_name, email, phone, status, owner_id, created_at ' +
    'FROM leads WHERE id = $1',
    [TARGET_LEAD_ID]
  );
  if (leadRows.length === 0) {
    console.log('RESULT: lead not found (already cleaned up?)');
    return { action: 'noop', reason: 'lead not found' };
  }
  const lead = leadRows[0];
  console.log('Re-read lead:');
  console.log('  external_ref: ' + (lead.external_ref || 'NULL'));
  console.log('  name:         ' + lead.first_name + ' ' + lead.last_name);
  console.log('  email:        ' + (lead.email || 'NULL'));
  console.log('  status:       ' + lead.status);
  console.log('  created_at:   ' + lead.created_at);

  const identityOk =
    lead.external_ref === null &&
    lead.first_name === TARGET_FIRST &&
    lead.last_name === TARGET_LAST &&
    (lead.email || '').toLowerCase() === TARGET_EMAIL;
  if (!identityOk) {
    console.log('ABORT: identity mismatch — not the confirmed Test Probe record');
    return { action: 'abort', reason: 'identity mismatch', lead };
  }
  console.log('Identity: CONFIRMED ✅');
  console.log('');

  // ── Phase 2: Re-count dependencies ──────────────────────────────────────
  const counts = await countDeps(queryFn, TARGET_LEAD_ID);
  console.log('Dependency re-count:');
  for (const d of DEP_TABLES) {
    const c = counts[d.table];
    const ok = c === d.allowed;
    console.log('  ' + d.table + ': ' + c + ' (allowed ' + d.allowed + ') ' + (ok ? '✅' : '❌'));
  }
  const depsOk = DEP_TABLES.every(d => counts[d.table] === d.allowed);
  if (!depsOk) {
    console.log('ABORT: dependency count mismatch — only the single appointment is allowed');
    return { action: 'abort', reason: 'dependency mismatch', counts };
  }
  console.log('Dependencies: CONFIRMED ✅ (only 1 appointment, all others 0)');
  console.log('');

  // ── Phase 3: external_ref guard ─────────────────────────────────────────
  console.log('external_ref IS NULL: ' + (lead.external_ref === null ? 'CONFIRMED ✅' : 'NO ❌'));
  console.log('');

  // ── Phase 4: Capture the single appointment id ──────────────────────────
  const { rows: apptRows } = await queryFn(
    'SELECT id, status, start_at FROM appointments WHERE lead_id = $1',
    [TARGET_LEAD_ID]
  );
  if (apptRows.length !== 1) {
    console.log('ABORT: expected exactly 1 appointment, found ' + apptRows.length);
    return { action: 'abort', reason: 'appointment count != 1', apptRows };
  }
  const targetApptId = apptRows[0].id;
  console.log('Target appointment id: ' + targetApptId + ' (status=' + apptRows[0].status + ')');
  console.log('');

  if (!apply) {
    console.log('DRY-RUN: no writes performed. Pass APPLY=1 to execute full removal.');
    return { action: 'dryrun', lead, counts, targetApptId };
  }

  // ── Phase 5: Execute full removal inside the transaction ───────────────
  // 5a. Narrowly disable the immutability trigger for this transaction only.
  await queryFn('ALTER TABLE appointments DISABLE TRIGGER ' + TRIGGER_NAME);
  console.log('Trigger disabled: ' + TRIGGER_NAME);

  // 5b. Hard-delete the single confirmed test appointment (guarded by id + lead_id).
  const { rows: delApptRows } = await queryFn(
    'DELETE FROM appointments WHERE id = $1 AND lead_id = $2 RETURNING id',
    [targetApptId, TARGET_LEAD_ID]
  );
  if (delApptRows.length !== 1) {
    throw new Error('appointment delete affected ' + delApptRows.length + ' rows — expected 1; rolling back');
  }
  console.log('Appointment deleted: ' + delApptRows.length);

  // 5c. Hard-delete the test lead, guarded by external_ref IS NULL + name + email.
  const { rows: delLeadRows } = await queryFn(
    'DELETE FROM leads WHERE id = $1 AND external_ref IS NULL ' +
    'AND first_name = $2 AND last_name = $3 AND lower(email) = $4 ' +
    'RETURNING id',
    [TARGET_LEAD_ID, TARGET_FIRST, TARGET_LAST, TARGET_EMAIL]
  );
  if (delLeadRows.length !== 1) {
    throw new Error('lead delete affected ' + delLeadRows.length + ' rows — expected 1; rolling back');
  }
  console.log('Lead deleted: ' + delLeadRows.length);

  // 5d. Re-enable the immutability trigger BEFORE commit.
  await queryFn('ALTER TABLE appointments ENABLE TRIGGER ' + TRIGGER_NAME);
  console.log('Trigger re-enabled: ' + TRIGGER_NAME);

  console.log('');
  console.log('FULL REMOVAL APPLIED ✅ (pending COMMIT)');
  return { action: 'applied', appointmentDeleted: delApptRows.length, leadDeleted: delLeadRows.length, lead, counts, targetApptId };
}

async function postVerify(queryFn = query) {
  console.log('\n=== POST-CLEANUP VERIFICATION (READ-ONLY) ===');

  // Lead gone?
  const { rows: leadRows } = await queryFn(
    'SELECT id, external_ref, first_name, last_name, email FROM leads WHERE id = $1',
    [TARGET_LEAD_ID]
  );
  console.log('Test Probe lead present: ' + (leadRows.length === 0 ? 'NO ✅ (deleted)' : 'YES ❌'));
  if (leadRows.length > 0) console.log('  ' + JSON.stringify(leadRows[0]));

  // Appointment gone?
  const { rows: apptRows } = await queryFn(
    'SELECT id, status FROM appointments WHERE lead_id = $1',
    [TARGET_LEAD_ID]
  );
  console.log('Test Probe appointment present: ' + (apptRows.length === 0 ? 'NO ✅ (deleted)' : 'YES ❌'));
  for (const a of apptRows) console.log('  ' + a.id + ' status=' + a.status);

  // Trigger active?
  const { rows: trigRows } = await queryFn(
    "SELECT tgenabled FROM pg_trigger WHERE tgname = $1",
    [TRIGGER_NAME]
  );
  const triggerActive = trigRows.length > 0 && trigRows[0].tgenabled === 'O';
  console.log('appointments_no_delete trigger active: ' + (triggerActive ? 'YES ✅' : 'NO ❌'));

  // Total lead count (sanity)
  const { rows: lc } = await queryFn('SELECT COUNT(*)::int AS c FROM leads');
  console.log('Total Railway leads: ' + lc[0].c);

  return { leadGone: leadRows.length === 0, apptGone: apptRows.length === 0, triggerActive };
}

async function main() {
  const apply = process.env.APPLY === '1';
  const client = apply ? await pool.connect() : null;
  try {
    if (apply) {
      await client.query('BEGIN');
      const qFn = (text, params) => client.query(text, params);
      await runCleanup(qFn, true);
      await client.query('COMMIT');
      console.log('COMMIT successful ✅');
    } else {
      await runCleanup(query, false);
    }
    await postVerify(query);
  } catch (e) {
    if (apply && client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.log('ROLLED BACK due to error');
    }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

module.exports = { runCleanup, postVerify, countDeps, DEP_TABLES, TARGET_LEAD_ID, TRIGGER_NAME };

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}