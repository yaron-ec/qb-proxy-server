/* eslint-disable no-undef */
'use strict';
/**
 * cleanupTestProbe.js — One-time FULL REMOVAL of the confirmed Railway-native
 * test fixture "Test Probe", using the COMPLETE dependency order from the
 * read-only FK audit (auditTestProbeFkReferences.js).
 *
 * Target: lead "Test Probe" (Railway id c7b3e041-f3fa-4507-8619-6e3c732b3ed4,
 * external_ref NULL, email test@example.com). Appointment 0767cfe9-422a-4802-
 * a533-f1cd24039b79.
 *
 * Identity is verified by EXACT lead id + first_name + last_name + email +
 * external_ref IS NULL. Email is NOT used alone (two other leads share it).
 *
 * Deletion order (FK-safe, all inside ONE transaction):
 *   1. DELETE calendar_outbox WHERE appointment_id = <apptId>  — expect 2
 *   2. DELETE appointment_events WHERE appointment_id = <apptId> — expect 1
 *   3. DELETE booking_idempotency WHERE appointment_id=<apptId> AND lead_id=<leadId> — expect 1
 *   4. DISABLE TRIGGER appointments_no_delete (this tx only)
 *   5. DELETE appointments WHERE id=<apptId> AND lead_id=<leadId> — expect 1
 *   6. ENABLE TRIGGER appointments_no_delete (before commit)
 *   7. DELETE leads WHERE id=<leadId> AND external_ref IS NULL AND first/last/email guards — expect 1
 *   8. DELETE reminder_leads WHERE id = <leadId> (text column, no FK) — expect 1
 *
 * Pre-commit verification (all must pass or ROLLBACK):
 *   - appointments_no_delete trigger is active
 *   - Test Probe lead gone
 *   - Test Probe appointment gone
 *   - 0 rows for fixture in calendar_outbox, appointment_events, booking_idempotency, reminder_leads
 *   - the two other test@example.com leads still exist unchanged
 *
 * Any row-count mismatch → ROLLBACK immediately.
 *
 * READ-ONLY by default. Pass APPLY=1 (env) to execute.
 * Environment: DATABASE_URL.
 */
const { pool, query } = require('../db/client');

const TARGET_LEAD_ID = 'c7b3e041-f3fa-4507-8619-6e3c732b3ed4';
const TARGET_APPT_ID = '0767cfe9-422a-4802-a533-f1cd24039b79';
const TARGET_EMAIL = 'test@example.com';
const TARGET_FIRST = 'Test';
const TARGET_LAST = 'Probe';
const TRIGGER_NAME = 'appointments_no_delete';
// appointment_events also has an immutability trigger (blocks DELETE). Discovered at runtime.
const APPT_EVENTS_TRIGGER_CANDIDATES = ['appointment_events_no_delete', 'appointment_events_immutable'];

// Expected counts from the read-only FK audit.
const EXPECT = {
  calendar_outbox: 2,
  appointment_events: 1,
  booking_idempotency: 1,
  appointments: 1,
  leads: 1,
  reminder_leads: 1,
};

function assertCount(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`COUNT MISMATCH [${label}]: expected ${expected}, got ${actual} — ROLLBACK`);
  }
  console.log(`  ✓ ${label}: ${actual} (matches expected ${expected})`);
}

async function runCleanup(queryFn, apply) {
  console.log('=== TEST PROBE FULL REMOVAL (COMPLETE DEPENDENCY ORDER) ===');
  console.log('Mode: ' + (apply ? 'APPLY (writes enabled)' : 'DRY-RUN (read-only)'));
  console.log('Target lead id: ' + TARGET_LEAD_ID);
  console.log('Target appt id: ' + TARGET_APPT_ID);
  console.log('');

  // ── Re-read & re-verify lead identity immediately before mutation ─────────
  const { rows: leadRows } = await queryFn(
    'SELECT id, external_ref, first_name, last_name, email, phone, status, created_at ' +
    'FROM leads WHERE id = $1',
    [TARGET_LEAD_ID]
  );
  if (leadRows.length === 0) {
    console.log('RESULT: lead not found (already cleaned up?)');
    return { action: 'noop', reason: 'lead not found' };
  }
  const lead = leadRows[0];
  console.log('Re-read lead:');
  console.log('  id:           ' + lead.id);
  console.log('  external_ref: ' + (lead.external_ref || 'NULL'));
  console.log('  name:         ' + lead.first_name + ' ' + lead.last_name);
  console.log('  email:        ' + (lead.email || 'NULL'));
  console.log('  status:       ' + lead.status);

  const identityOk =
    lead.id === TARGET_LEAD_ID &&
    lead.external_ref === null &&
    lead.first_name === TARGET_FIRST &&
    lead.last_name === TARGET_LAST &&
    (lead.email || '').toLowerCase() === TARGET_EMAIL;
  if (!identityOk) {
    throw new Error('IDENTITY MISMATCH — not the confirmed Test Probe record; ROLLBACK');
  }
  console.log('Identity: CONFIRMED ✅\n');

  // ── Re-read & re-verify appointment identity ──────────────────────────────
  const { rows: apptRows } = await queryFn(
    'SELECT id, lead_id, status, start_at FROM appointments WHERE id = $1 AND lead_id = $2',
    [TARGET_APPT_ID, TARGET_LEAD_ID]
  );
  if (apptRows.length !== 1) {
    throw new Error('APPOINTMENT MISMATCH: expected exactly 1 appointment for this lead, found ' + apptRows.length);
  }
  console.log('Re-read appointment: ' + apptRows[0].id + ' status=' + apptRows[0].status + ' lead_id=' + apptRows[0].lead_id);
  console.log('Appointment identity: CONFIRMED ✅\n');

  // ── Pre-mutation snapshot of the two other test@example.com leads ────────
  const { rows: otherLeads } = await queryFn(
    "SELECT id, external_ref, first_name, last_name, email, status FROM leads " +
    "WHERE lower(email) = $1 AND id <> $2 ORDER BY id",
    [TARGET_EMAIL, TARGET_LEAD_ID]
  );
  console.log('Other leads sharing test@example.com (must remain unchanged): ' + otherLeads.length);
  for (const o of otherLeads) console.log('  ' + o.id + ' ' + o.first_name + ' ' + o.last_name + ' ext=' + (o.external_ref || 'NULL'));
  console.log('');

  if (!apply) {
    console.log('DRY-RUN: no writes performed. Pass APPLY=1 to execute.');
    return { action: 'dryrun', lead, appt: apptRows[0], otherLeads };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 — DELETE calendar_outbox rows for exact appointment_id (expect 2)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('STEP 1: DELETE calendar_outbox WHERE appointment_id = <apptId>');
  const co = await queryFn('DELETE FROM calendar_outbox WHERE appointment_id = $1 RETURNING id', [TARGET_APPT_ID]);
  assertCount(co.rowCount, EXPECT.calendar_outbox, 'calendar_outbox');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2 — DELETE appointment_events row for exact appointment_id (expect 1)
  // appointment_events has its own immutability trigger — discover & bypass it
  // narrowly (re-enabled before commit).
  // ══════════════════════════════════════════════════════════════════════════
  const { rows: aeTrigRows } = await queryFn(
    "SELECT tgname FROM pg_trigger WHERE tgrelid = 'appointment_events'::regclass AND tgenabled IN ('O','D') AND NOT tgisinternal"
  );
  const aeTrig = aeTrigRows.map(t => t.tgname).find(n => APPT_EVENTS_TRIGGER_CANDIDATES.includes(n)) || aeTrigRows[0]?.tgname;
  console.log('STEP 2: discovered appointment_events immutability trigger: ' + (aeTrig || 'NONE'));
  if (aeTrig) await queryFn('ALTER TABLE appointment_events DISABLE TRIGGER ' + aeTrig);
  const ae = await queryFn('DELETE FROM appointment_events WHERE appointment_id = $1 RETURNING id', [TARGET_APPT_ID]);
  assertCount(ae.rowCount, EXPECT.appointment_events, 'appointment_events');
  if (aeTrig) await queryFn('ALTER TABLE appointment_events ENABLE TRIGGER ' + aeTrig);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 3 — DELETE booking_idempotency matching BOTH appt_id AND lead_id (expect 1)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('STEP 3: DELETE booking_idempotency WHERE appointment_id=<apptId> AND lead_id=<leadId>');
  const bi = await queryFn(
    'DELETE FROM booking_idempotency WHERE appointment_id = $1 AND lead_id = $2 RETURNING idempotency_key',
    [TARGET_APPT_ID, TARGET_LEAD_ID]
  );
  assertCount(bi.rowCount, EXPECT.booking_idempotency, 'booking_idempotency');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 4 — Temporarily disable appointments_no_delete (this tx only)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('STEP 4: DISABLE TRIGGER appointments_no_delete');
  await queryFn('ALTER TABLE appointments DISABLE TRIGGER ' + TRIGGER_NAME);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 5 — DELETE exact appointment matching appt_id AND lead_id (expect 1)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('STEP 5: DELETE appointments WHERE id=<apptId> AND lead_id=<leadId>');
  const ap = await queryFn(
    'DELETE FROM appointments WHERE id = $1 AND lead_id = $2 RETURNING id',
    [TARGET_APPT_ID, TARGET_LEAD_ID]
  );
  assertCount(ap.rowCount, EXPECT.appointments, 'appointments');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 6 — Re-enable appointments_no_delete BEFORE commit
  // ══════════════════════════════════════════════════════════════════════════
  console.log('STEP 6: ENABLE TRIGGER appointments_no_delete');
  await queryFn('ALTER TABLE appointments ENABLE TRIGGER ' + TRIGGER_NAME);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 7 — DELETE exact Test Probe lead with identity guards (expect 1)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('STEP 7: DELETE leads WHERE id=<leadId> AND external_ref IS NULL AND name/email guards');
  const ld = await queryFn(
    'DELETE FROM leads WHERE id = $1 AND external_ref IS NULL ' +
    'AND first_name = $2 AND last_name = $3 AND lower(email) = $4 RETURNING id',
    [TARGET_LEAD_ID, TARGET_FIRST, TARGET_LAST, TARGET_EMAIL]
  );
  assertCount(ld.rowCount, EXPECT.leads, 'leads');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 8 — DELETE reminder_leads projection row (text id, no FK) (expect 1)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('STEP 8: DELETE reminder_leads WHERE id = <leadId> (text column)');
  const rl = await queryFn('DELETE FROM reminder_leads WHERE id = $1 RETURNING id', [TARGET_LEAD_ID]);
  assertCount(rl.rowCount, EXPECT.reminder_leads, 'reminder_leads');

  // ══════════════════════════════════════════════════════════════════════════
  // PRE-COMMIT VERIFICATION (any failure → ROLLBACK)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n=== PRE-COMMIT VERIFICATION ===');

  // trigger active?
  const { rows: trigRows } = await queryFn(
    "SELECT tgenabled FROM pg_trigger WHERE tgname = $1", [TRIGGER_NAME]
  );
  const triggerActive = trigRows.length > 0 && trigRows[0].tgenabled === 'O';
  console.log('  appointments_no_delete active: ' + (triggerActive ? 'YES ✅' : 'NO ❌'));
  if (!triggerActive) throw new Error('PRE-COMMIT FAIL: appointments_no_delete not active — ROLLBACK');

  // appointment_events trigger active?
  if (aeTrig) {
    const { rows: aeTrigCheck } = await queryFn("SELECT tgenabled FROM pg_trigger WHERE tgname = $1", [aeTrig]);
    const aeActive = aeTrigCheck.length > 0 && aeTrigCheck[0].tgenabled === 'O';
    console.log('  ' + aeTrig + ' active: ' + (aeActive ? 'YES ✅' : 'NO ❌'));
    if (!aeActive) throw new Error('PRE-COMMIT FAIL: appointment_events trigger not active — ROLLBACK');
  }

  // lead gone?
  const { rows: leadCheck } = await queryFn('SELECT id FROM leads WHERE id = $1', [TARGET_LEAD_ID]);
  console.log('  Test Probe lead gone: ' + (leadCheck.length === 0 ? 'YES ✅' : 'NO ❌'));
  if (leadCheck.length !== 0) throw new Error('PRE-COMMIT FAIL: lead still exists — ROLLBACK');

  // appt gone?
  const { rows: apptCheck } = await queryFn('SELECT id FROM appointments WHERE id = $1', [TARGET_APPT_ID]);
  console.log('  Test Probe appt gone: ' + (apptCheck.length === 0 ? 'YES ✅' : 'NO ❌'));
  if (apptCheck.length !== 0) throw new Error('PRE-COMMIT FAIL: appointment still exists — ROLLBACK');

  // no fixture rows remain in the 4 tables
  const { rows: coRem } = await queryFn('SELECT COUNT(*)::int c FROM calendar_outbox WHERE appointment_id = $1', [TARGET_APPT_ID]);
  const { rows: aeRem } = await queryFn('SELECT COUNT(*)::int c FROM appointment_events WHERE appointment_id = $1', [TARGET_APPT_ID]);
  const { rows: biRem } = await queryFn('SELECT COUNT(*)::int c FROM booking_idempotency WHERE appointment_id = $1 OR lead_id = $2', [TARGET_APPT_ID, TARGET_LEAD_ID]);
  const { rows: rlRem } = await queryFn('SELECT COUNT(*)::int c FROM reminder_leads WHERE id = $1', [TARGET_LEAD_ID]);
  console.log('  calendar_outbox remaining: ' + coRem[0].c + (coRem[0].c === 0 ? ' ✅' : ' ❌'));
  console.log('  appointment_events remaining: ' + aeRem[0].c + (aeRem[0].c === 0 ? ' ✅' : ' ❌'));
  console.log('  booking_idempotency remaining: ' + biRem[0].c + (biRem[0].c === 0 ? ' ✅' : ' ❌'));
  console.log('  reminder_leads remaining: ' + rlRem[0].c + (rlRem[0].c === 0 ? ' ✅' : ' ❌'));
  if (coRem[0].c !== 0 || aeRem[0].c !== 0 || biRem[0].c !== 0 || rlRem[0].c !== 0) {
    throw new Error('PRE-COMMIT FAIL: fixture rows remain — ROLLBACK');
  }

  // two other test@example.com leads still exist unchanged
  const { rows: otherCheck } = await queryFn(
    "SELECT id, first_name, last_name, email, status FROM leads WHERE lower(email) = $1 AND id <> $2 ORDER BY id",
    [TARGET_EMAIL, TARGET_LEAD_ID]
  );
  console.log('  other test@example.com leads still present: ' + otherCheck.length);
  const othersUnchanged = otherCheck.length === otherLeads.length &&
    otherCheck.every((o, i) => o.id === otherLeads[i].id && o.first_name === otherLeads[i].first_name &&
      o.last_name === otherLeads[i].last_name && o.status === otherLeads[i].status);
  console.log('  other leads unchanged: ' + (othersUnchanged ? 'YES ✅' : 'NO ❌'));
  if (!othersUnchanged) throw new Error('PRE-COMMIT FAIL: other leads changed — ROLLBACK');

  console.log('\nALL PRE-COMMIT CHECKS PASSED ✅ — ready for COMMIT');
  return { action: 'applied', steps: { calendar_outbox: co.rowCount, appointment_events: ae.rowCount, booking_idempotency: bi.rowCount, appointments: ap.rowCount, leads: ld.rowCount, reminder_leads: rl.rowCount } };
}

async function postVerify(queryFn = query) {
  console.log('\n=== POST-COMMIT VERIFICATION (READ-ONLY) ===');
  const out = {};

  const { rows: leadRows } = await queryFn('SELECT id FROM leads WHERE id = $1', [TARGET_LEAD_ID]);
  out.leadGone = leadRows.length === 0;
  console.log('Test Probe lead gone: ' + (out.leadGone ? 'YES ✅' : 'NO ❌'));

  const { rows: apptRows } = await queryFn('SELECT id FROM appointments WHERE id = $1', [TARGET_APPT_ID]);
  out.apptGone = apptRows.length === 0;
  console.log('Test Probe appt gone: ' + (out.apptGone ? 'YES ✅' : 'NO ❌'));

  const { rows: trigRows } = await queryFn("SELECT tgenabled FROM pg_trigger WHERE tgname = $1", [TRIGGER_NAME]);
  out.triggerActive = trigRows.length > 0 && trigRows[0].tgenabled === 'O';
  console.log('appointments_no_delete active: ' + (out.triggerActive ? 'YES ✅' : 'NO ❌'));

  const { rows: lc } = await queryFn('SELECT COUNT(*)::int c FROM leads');
  out.totalLeads = lc[0].c;
  console.log('Total Railway leads: ' + out.totalLeads);

  return out;
}

async function main() {
  const apply = process.env.APPLY === '1';
  const client = apply ? await pool.connect() : null;
  try {
    if (apply) {
      await client.query('BEGIN');
      const qFn = (text, params) => client.query(text, params);
      const res = await runCleanup(qFn, true);
      await client.query('COMMIT');
      console.log('COMMIT successful ✅');
      console.log('Cleanup result: ' + JSON.stringify(res.steps));
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

module.exports = { runCleanup, postVerify, TARGET_LEAD_ID, TARGET_APPT_ID, TRIGGER_NAME, EXPECT };

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}