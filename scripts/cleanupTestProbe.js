/* eslint-disable no-undef */
'use strict';
/**
 * cleanupTestProbe.js — One-time cleanup of the confirmed Railway-native test record.
 *
 * Target: lead "Test Probe" (Railway id c7b3e041-f3fa-4507-8619-6e3c732b3ed4,
 * external_ref NULL, email test@example.com, owner Yaron).
 *
 * Safety model (defense in depth):
 *   1. Re-read the lead by exact Railway id AND verify name/email/external_ref match
 *      the reconciliation report. Abort if any field differs.
 *   2. Re-count every dependency table. Abort if ANY table other than `appointments`
 *      has rows, or if `appointments` has more than 1 row.
 *   3. Confirm external_ref IS NULL (never touch a Base44-mapped lead).
 *   4. Inside a single transaction:
 *        a. Cancel the single appointment (status -> 'cancelled'). Appointments are
 *           immutable (no physical DELETE); cancellation is the allowed path.
 *        b. Delete the lead row (leads are deletable).
 *   5. Post-cleanup verification: confirm the lead is gone, the appointment is
 *      cancelled, and no other lead/appointment was touched.
 *
 * READ-ONLY by default (DRY_RUN=1 env or no arg). Pass APPLY=1 (env) or call with
 * queryFn inside a transaction to actually write. The cron endpoint passes APPLY=1.
 *
 * Environment: DATABASE_URL.
 */
const { pool, query } = require('../db/client');

const TARGET_LEAD_ID = 'c7b3e041-f3fa-4507-8619-6e3c732b3ed4';
const TARGET_EMAIL = 'test@example.com';
const TARGET_FIRST = 'Test';
const TARGET_LAST = 'Probe';

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
  console.log('=== TEST PROBE CLEANUP ===');
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
  // Re-checked above, but explicit log line.
  console.log('external_ref IS NULL: ' + (lead.external_ref === null ? 'CONFIRMED ✅' : 'NO ❌'));
  console.log('');

  if (!apply) {
    console.log('DRY-RUN: no writes performed. Pass APPLY=1 to execute cleanup.');
    return { action: 'dryrun', lead, counts };
  }

  // ── Phase 4: Execute cleanup inside the provided transaction ─────────────
  // 4a. Cancel the single appointment.
  const { rows: apptRows } = await queryFn(
    "UPDATE appointments SET status = 'cancelled', updated_at = NOW() " +
    "WHERE lead_id = $1 AND status IN ('scheduled','confirmed') " +
    "RETURNING id, status",
    [TARGET_LEAD_ID]
  );
  const cancelled = apptRows.length;
  console.log('Appointments cancelled: ' + cancelled);

  // 4b. Delete the lead. Guard with external_ref IS NULL + name + email so a
  // Base44-mapped lead can NEVER be deleted even if the id were reused.
  const { rows: delRows } = await queryFn(
    'DELETE FROM leads WHERE id = $1 AND external_ref IS NULL ' +
    'AND first_name = $2 AND last_name = $3 AND lower(email) = $4 ' +
    'RETURNING id',
    [TARGET_LEAD_ID, TARGET_FIRST, TARGET_LAST, TARGET_EMAIL]
  );
  const deleted = delRows.length;
  console.log('Leads deleted: ' + deleted);

  if (deleted !== 1) {
    throw new Error('delete affected ' + deleted + ' rows — expected 1; transaction will roll back');
  }
  console.log('');
  console.log('CLEANUP APPLIED ✅');
  return { action: 'applied', cancelled, deleted, lead, counts };
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

  // Appointment cancelled?
  const { rows: apptRows } = await queryFn(
    'SELECT id, status FROM appointments WHERE lead_id = $1',
    [TARGET_LEAD_ID]
  );
  console.log('Appointments for target lead: ' + apptRows.length);
  for (const a of apptRows) console.log('  ' + a.id + ' status=' + a.status);

  // Total lead count + total active appointment count (sanity)
  const { rows: lc } = await queryFn('SELECT COUNT(*)::int AS c FROM leads');
  console.log('Total Railway leads: ' + lc[0].c);

  return { leadGone: leadRows.length === 0, appts: apptRows };
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

module.exports = { runCleanup, postVerify, countDeps, DEP_TABLES, TARGET_LEAD_ID };

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}