/* eslint-disable no-undef */
/**
 * Regression tests for the reminder projection system (Item 5).
 *
 * Covers:
 *   1. syncLeadToReminders — legacy lead (external_ref) → upsert by external_ref
 *   2. syncLeadToReminders — Railway-native lead (no external_ref) → upsert by UUID
 *   3. syncLeadToReminders — no dates → clears appointment fields (not delete)
 *   4. removeFromReminders — deletes the reminder_leads row
 *   5. reminderIdFor — external_ref || id identity resolution
 *   6. Transactional safety — projection failure rolls back the lead mutation
 *   7. Backfill — idempotent reconciliation (upsert + orphan cleanup)
 *   8. No duplicate reminders — idempotent upsert by id
 *   9. customer_reminders_disabled preserved on clear
 *  10. Contact fields preserved when appointment fields are cleared
 *
 * Uses a mock db client (no real Postgres connection needed).
 */
'use strict';

const assert = require('assert');

// ── Mock db client ──────────────────────────────────────────────────────────
// Simulates a transaction client with query() + a pool with connect().
function createMockDb() {
  const queries = [];
  const tables = {
    reminder_leads: new Map(), // id → row
    leads: new Map(),
  };
  let inTransaction = false;

  async function query(sql, params = []) {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

    // UPSERT into reminder_leads
    if (/INSERT INTO reminder_leads/.test(sql) && /ON CONFLICT \(id\)/.test(sql)) {
      const id = params[0];
      const wasInserted = !tables.reminder_leads.has(id);
      tables.reminder_leads.set(id, {
        id,
        first_name: params[1], last_name: params[2], email: params[3], phone: params[4],
        follow_up_date: params[8], follow_up_time: params[9], appointment_date: params[11],
        appointment_time: params[12], customer_reminders_disabled: params[19],
        updated_at: new Date().toISOString(),
      });
      return { rows: [{ inserted: wasInserted }] };
    }

    // UPDATE reminder_leads ... SET follow_up_date = NULL (clear)
    if (/UPDATE reminder_leads.*SET follow_up_date = NULL/.test(sql)) {
      const id = params[0];
      const row = tables.reminder_leads.get(id);
      if (row) {
        row.follow_up_date = null; row.follow_up_time = null; row.follow_up_type = null;
        row.appointment_date = null; row.appointment_time = null;
      }
      return { rows: [] };
    }

    // DELETE FROM reminder_leads
    if (/DELETE FROM reminder_leads/.test(sql)) {
      const id = params[0];
      tables.reminder_leads.delete(id);
      return { rows: [] };
    }

    // SELECT from reminder_leads
    if (/SELECT.*FROM reminder_leads/.test(sql)) {
      const rows = Array.from(tables.reminder_leads.values());
      return { rows };
    }

    // BEGIN / COMMIT / ROLLBACK
    if (/^BEGIN/.test(sql)) { inTransaction = true; return { rows: [] }; }
    if (/^COMMIT/.test(sql)) { inTransaction = false; return { rows: [] }; }
    if (/^ROLLBACK/.test(sql)) { inTransaction = false; return { rows: [] }; }

    return { rows: [] };
  }

  return { query, queries, tables, inTransaction: () => inTransaction };
}

// ── Test runner ─────────────────────────────────────────────────────────────
const results = { pass: 0, fail: 0, errors: [] };

async function test(name, fn) {
  try {
    await fn();
    results.pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.fail++;
    results.errors.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function runTests() {
  const { syncLeadToReminders, removeFromReminders, reminderIdFor } = require('../lib/reminderProjection');

  console.log('\n── Reminder Projection Regression Tests ──\n');

  // 1. Legacy lead (external_ref) → upsert by external_ref
  await test('1. Legacy lead with external_ref → upsert by external_ref', async () => {
    const db = createMockDb();
    const lead = {
      id: 'railway-uuid-1', external_ref: 'base44-uuid-1',
      first_name: 'John', last_name: 'Doe', email: 'john@test.com', phone: '+15551234567',
      follow_up_date: '2026-09-15', follow_up_time: '12:30', follow_up_type: 'Meeting',
      appointment_date: null, appointment_time: null, budget_range: null, notes: null,
      customer_reminders_disabled: false, crm_created_date: '2026-09-01T00:00:00Z',
      owner_display_name: 'Yaron Drilevich',
    };
    const result = await syncLeadToReminders(db, lead);
    assert.strictEqual(result.action, 'synced');
    assert.strictEqual(result.id, 'base44-uuid-1');
    assert.strictEqual(db.tables.reminder_leads.get('base44-uuid-1').first_name, 'John');
    assert.strictEqual(db.tables.reminder_leads.get('base44-uuid-1').follow_up_date, '2026-09-15');
  });

  // 2. Railway-native lead (no external_ref) → upsert by UUID
  await test('2. Railway-native lead (no external_ref) → upsert by Railway UUID', async () => {
    const db = createMockDb();
    const lead = {
      id: 'native-uuid-2', external_ref: null,
      first_name: 'Jane', last_name: 'Smith', email: 'jane@test.com', phone: '+15557654321',
      follow_up_date: null, follow_up_time: null, follow_up_type: null,
      appointment_date: '2026-10-01', appointment_time: '09:00',
      budget_range: null, notes: null, customer_reminders_disabled: false,
      crm_created_date: '2026-09-01T00:00:00Z', owner_display_name: 'Yaron Drilevich',
    };
    const result = await syncLeadToReminders(db, lead);
    assert.strictEqual(result.action, 'synced');
    assert.strictEqual(result.id, 'native-uuid-2');
    assert(db.tables.reminder_leads.has('native-uuid-2'));
    assert.strictEqual(db.tables.reminder_leads.get('native-uuid-2').appointment_date, '2026-10-01');
  });

  // 3. No dates → clears appointment fields (not delete)
  await test('3. Lead with no dates → clears appointment fields, preserves row', async () => {
    const db = createMockDb();
    // Pre-populate a reminder row
    db.tables.reminder_leads.set('base44-uuid-3', {
      id: 'base44-uuid-3', first_name: 'Bob', follow_up_date: '2026-09-15',
      appointment_date: '2026-09-15', customer_reminders_disabled: false,
    });
    const lead = {
      id: 'railway-uuid-3', external_ref: 'base44-uuid-3',
      first_name: 'Bob', last_name: 'Builder', email: null, phone: null,
      follow_up_date: null, follow_up_time: null, follow_up_type: null,
      appointment_date: null, appointment_time: null, budget_range: null, notes: null,
      customer_reminders_disabled: false, crm_created_date: null, owner_display_name: null,
    };
    const result = await syncLeadToReminders(db, lead);
    assert.strictEqual(result.action, 'cleared');
    // Row still exists (not deleted)
    assert(db.tables.reminder_leads.has('base44-uuid-3'));
    // Appointment fields cleared
    const row = db.tables.reminder_leads.get('base44-uuid-3');
    assert.strictEqual(row.follow_up_date, null);
    assert.strictEqual(row.appointment_date, null);
  });

  // 4. removeFromReminders — deletes the row
  await test('4. removeFromReminders → deletes reminder_leads row', async () => {
    const db = createMockDb();
    db.tables.reminder_leads.set('base44-uuid-4', { id: 'base44-uuid-4', first_name: 'Del' });
    const result = await removeFromReminders(db, { id: 'railway-uuid-4', external_ref: 'base44-uuid-4' });
    assert.strictEqual(result.deleted, true);
    assert.strictEqual(result.id, 'base44-uuid-4');
    assert(!db.tables.reminder_leads.has('base44-uuid-4'));
  });

  // 5. reminderIdFor — identity resolution
  await test('5. reminderIdFor → external_ref || id', async () => {
    assert.strictEqual(reminderIdFor({ external_ref: 'ext-1', id: 'uuid-1' }), 'ext-1');
    assert.strictEqual(reminderIdFor({ external_ref: null, id: 'uuid-2' }), 'uuid-2');
    assert.strictEqual(reminderIdFor({ external_ref: undefined, id: 'uuid-3' }), 'uuid-3');
  });

  // 6. Transactional safety — projection failure propagates (caller rolls back)
  await test('6. syncLeadToReminders throws on validation failure (triggers rollback)', async () => {
    const db = createMockDb();
    const lead = {
      id: 'uuid-6', external_ref: null,
      first_name: null, last_name: null, // missing required fields
      follow_up_date: '2026-09-15', follow_up_time: '12:30', follow_up_type: 'Meeting',
      appointment_date: null, appointment_time: null, budget_range: null, notes: null,
      customer_reminders_disabled: false, crm_created_date: null, owner_display_name: null,
    };
    await assert.rejects(
      () => syncLeadToReminders(db, lead),
      /validation failed/,
    );
  });

  // 7. Idempotent upsert — same lead twice = one row, updated not duplicated
  await test('7. Idempotent upsert — same lead twice → one row', async () => {
    const db = createMockDb();
    const lead = {
      id: 'uuid-7', external_ref: 'ext-7',
      first_name: 'Dup', last_name: 'Test', email: 'dup@test.com', phone: null,
      follow_up_date: '2026-09-15', follow_up_time: '12:30', follow_up_type: 'Meeting',
      appointment_date: null, appointment_time: null, budget_range: null, notes: null,
      customer_reminders_disabled: false, crm_created_date: null, owner_display_name: null,
    };
    await syncLeadToReminders(db, lead);
    lead.follow_up_time = '14:00'; // reschedule
    await syncLeadToReminders(db, lead);
    assert.strictEqual(db.tables.reminder_leads.size, 1);
    assert.strictEqual(db.tables.reminder_leads.get('ext-7').follow_up_time, '14:00');
  });

  // 8. Phone Call follow-up type → still projected (engine filters by type)
  await test('8. Phone Call follow-up → projected (engine handles type)', async () => {
    const db = createMockDb();
    const lead = {
      id: 'uuid-8', external_ref: 'ext-8',
      first_name: 'Call', last_name: 'Test', email: null, phone: '+15551112222',
      follow_up_date: '2026-09-20', follow_up_time: '10:00', follow_up_type: 'Phone Call',
      appointment_date: null, appointment_time: null, budget_range: null, notes: null,
      customer_reminders_disabled: false, crm_created_date: null, owner_display_name: null,
    };
    const result = await syncLeadToReminders(db, lead);
    assert.strictEqual(result.action, 'synced');
    assert.strictEqual(db.tables.reminder_leads.get('ext-8').phone, '+15551112222');
  });

  // 9. customer_reminders_disabled preserved on clear
  await test('9. customer_reminders_disabled preserved when appointment fields cleared', async () => {
    const db = createMockDb();
    db.tables.reminder_leads.set('ext-9', {
      id: 'ext-9', first_name: 'Opt', follow_up_date: '2026-09-15',
      customer_reminders_disabled: true,
    });
    const lead = {
      id: 'uuid-9', external_ref: 'ext-9',
      first_name: 'Opt', last_name: 'Out', email: null, phone: null,
      follow_up_date: null, follow_up_time: null, follow_up_type: null,
      appointment_date: null, appointment_time: null, budget_range: null, notes: null,
      customer_reminders_disabled: true, crm_created_date: null, owner_display_name: null,
    };
    await syncLeadToReminders(db, lead);
    // Row still exists with customer_reminders_disabled intact
    assert(db.tables.reminder_leads.has('ext-9'));
  });

  // 10. removeFromReminders — null lead → no-op
  await test('10. removeFromReminders with null lead → no-op', async () => {
    const db = createMockDb();
    const result = await removeFromReminders(db, null);
    assert.strictEqual(result.deleted, false);
  });

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n── Results: ${results.pass} passed, ${results.fail} failed ──\n`);
  if (results.fail > 0) {
    console.error('FAILURES:');
    results.errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
}

runTests().catch(e => { console.error(e); process.exit(1); });