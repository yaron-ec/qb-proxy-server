/* eslint-disable no-undef */
/**
 * Synthetic test-lead seeder — DRY-RUN / TEST ONLY.
 *
 * Populates the `test_leads` table with entirely synthetic leads so the
 * reminder engine can be validated end-to-end (timezone math, catch-up
 * logic, atomic-claim gate, health row, zero emails, zero Base44 access)
 * without any Base44 credential and without any real customer data.
 *
 * Guard: runs ONLY when REMINDER_TEST_SEED === 'true' (default false).
 * Idempotent: TRUNCATEs test_leads then inserts the fixed synthetic set,
 * so re-running always yields the same dataset.
 *
 * All names, emails, phones, and addresses are obviously fake. No real
 * customer PII is used or referenced.
 *
 *   node db/seedTestLeads.js        (with REMINDER_TEST_SEED=true)
 */
'use strict';

const db = require('./client');

function laDateTime(offsetHours) {
  const ms = Date.now() + offsetHours * 3600000;
  const date = new Date(ms).toLocaleString('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }); // YYYY-MM-DD
  const time = new Date(ms).toLocaleString('en-CA', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false,
  }); // HH:MM (24h)
  return { date, time };
}

// Deterministic synthetic lead set. Each exercises a different engine path.
// Fields mirror what the reminder engine reads via crmRepository.
function syntheticLeads() {
  const now = new Date().toISOString();
  const mk = (id, first, last, offsetHours, opts = {}) => {
    const { date, time } = laDateTime(offsetHours);
    return {
      id,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.test`,
      phone: `555-0${String(Math.abs(offsetHours)).padStart(3, '0').slice(-3)}`,
      property_address: `${100 + Math.abs(offsetHours)} Synthetic Way`,
      city: 'Testville',
      project_type: opts.project_type || 'Test Project',
      follow_up_date: opts.useFollowUp ? date : null,
      follow_up_time: opts.useFollowUp ? time : null,
      follow_up_type: opts.useFollowUp ? (opts.followUpType || 'Meeting') : null,
      appointment_date: opts.useFollowUp ? null : date,
      appointment_time: opts.useFollowUp ? null : time,
      assigned_rep: opts.assigned_rep || 'Test Rep',
      budget_range: opts.budget || '$25,000–$75,000',
      notes: opts.notes || 'Synthetic test lead — no real customer.',
      customer_reminders_disabled: !!opts.optOut,
      crm_created_date: now,
    };
  };

  return [
    // 1) ~25h out → 24h/48h normal windows miss, catch-up fires 48h.
    mk('test-lead-001', 'Alpha', 'Test', 25, { useFollowUp: true, notes: 'Catch-up 48h path.' }),
    // 2) ~2h10m out → 2h normal window fires (staff notified).
    mk('test-lead-002', 'Beta', 'Sample', 2.17, { useFollowUp: true, notes: '2h normal window.' }),
    // 3) ~35m out → 30min normal window fires (staff notified).
    mk('test-lead-003', 'Gamma', 'Mock', 0.58, { useFollowUp: true, notes: '30min normal window.' }),
    // 4) ~13h out → 12h window just missed; catch-up fires 48h.
    mk('test-lead-004', 'Delta', 'Dummy', 13, { useFollowUp: true, notes: 'Catch-up 48h (12h missed).' }),
    // 5) Phone Call type → engine skips (parity with Base44: phone reminders disabled).
    mk('test-lead-005', 'Epsilon', 'Placeholder', 3, { useFollowUp: true, followUpType: 'Phone Call', notes: 'Phone call — engine skip.' }),
    // 6) Customer opted out → customer email suppressed (dry-run: no email anyway).
    mk('test-lead-006', 'Zeta', 'Fictional', 5, { useFollowUp: true, optOut: true, notes: 'Opt-out — customer email suppressed.' }),
    // 7) >7 days out → out of range, skipped.
    mk('test-lead-007', 'Eta', 'Imaginary', 8 * 24, { useFollowUp: true, notes: 'Out of range (>7d).' }),
    // 8) >1h in the past → skipped.
    mk('test-lead-008', 'Theta', 'Simulated', -3, { useFollowUp: true, notes: 'Past (>1h ago) — skipped.' }),
    // 9) Uses appointment_date instead of follow_up_date (legacy path).
    mk('test-lead-009', 'Iota', 'Fabricated', 26, { useFollowUp: false, notes: 'appointment_date path.' }),
    // 10) ~1h05m out → 30min window missed (target 35m ago, >25m), 2h target 55m future; catch-up 48h.
    mk('test-lead-010', 'Kappa', 'Invented', 1.08, { useFollowUp: true, notes: 'Catch-up edge.' }),
  ];
}

async function seed() {
  if (process.env.REMINDER_TEST_SEED !== 'true') {
    console.log('[seed] REMINDER_TEST_SEED is not "true" — skipping synthetic seed (no-op).');
    return { skipped: true };
  }

  await db.ensureSchema();

  const leads = syntheticLeads();
  await db.query('TRUNCATE TABLE test_leads');

  const cols = [
    'id','first_name','last_name','email','phone','property_address','city','project_type',
    'follow_up_date','follow_up_time','follow_up_type','appointment_date','appointment_time',
    'assigned_rep','budget_range','notes','customer_reminders_disabled','crm_created_date',
  ];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO test_leads (${cols.join(', ')}) VALUES (${placeholders})`;

  for (const lead of leads) {
    await db.query(sql, [
      lead.id, lead.first_name, lead.last_name, lead.email, lead.phone,
      lead.property_address, lead.city, lead.project_type,
      lead.follow_up_date, lead.follow_up_time, lead.follow_up_type,
      lead.appointment_date, lead.appointment_time,
      lead.assigned_rep, lead.budget_range, lead.notes,
      lead.customer_reminders_disabled, lead.crm_created_date,
    ]);
  }

  console.log(`[seed] Inserted ${leads.length} synthetic leads into test_leads (TRUNCATE+INSERT — idempotent).`);
  return { skipped: false, count: leads.length };
}

(async () => {
  try {
    const r = await seed();
    console.log('[seed] done:', JSON.stringify(r));
    process.exit(0);
  } catch (e) {
    console.error('[seed] fatal:', e);
    process.exit(1);
  }
})();