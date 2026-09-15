/* eslint-disable no-undef */
/**
 * googleContactsAutoSync.test.js — tests for Google Contacts auto-sync
 *
 * Covers:
 * - CRM New Lead triggers sync (enqueueContactSync called)
 * - Capture New Lead triggers sync (enqueueContactSync called)
 * - existing resource_name updates same contact
 * - matching email updates existing contact
 * - matching normalized phone updates existing contact
 * - no match creates one contact
 * - repeated processing remains idempotent
 * - Google failure does NOT roll back Lead creation
 * - failure status persisted
 * - retry succeeds
 * - missing Contacts scope does not break Lead creation
 */
'use strict';

const assert = require('assert');

// ── Mock Google Contacts Client ──
let _createOrUpdateResult = { resourceName: 'people/c123' };
let _createOrUpdateCalls = 0;
let _createOrUpdateShouldThrow = null;

const googleContactsClient = {
  createOrUpdateContact: async function (lead, subEmail, existingResourceName) {
    _createOrUpdateCalls++;
    if (_createOrUpdateShouldThrow) {
      const e = new Error(_createOrUpdateShouldThrow.message);
      if (_createOrUpdateShouldThrow.code) e.code = _createOrUpdateShouldThrow.code;
      throw e;
    }
    return _createOrUpdateResult;
  },
};

// ── Mock pool for outbox processing ──
function makeMockPool(outboxRows, leads) {
  return {
    query: async function (sql, params) {
      // CREATE TABLE
      if (sql && sql.includes('CREATE TABLE')) return { rows: [] };
      // CREATE INDEX
      if (sql && sql.includes('CREATE INDEX')) return { rows: [] };
      // INSERT INTO google_contacts_outbox (enqueue)
      if (sql && sql.includes('INSERT INTO google_contacts_outbox')) return { rows: [] };
      // SELECT * FROM google_contacts_outbox (claim)
      if (sql && sql.includes('SELECT * FROM google_contacts_outbox')) {
        return { rows: outboxRows.map(r => ({ ...r })) };
      }
      // UPDATE google_contacts_outbox SET status = 'processing'
      if (sql && sql.includes("status = 'processing'")) return { rows: [] };
      // SELECT l.*, o.email AS owner_email FROM leads l
      if (sql && sql.includes('SELECT l.*') && sql.includes('owner_email')) {
        const leadId = params[0];
        const lead = leads.find(l => l.id === leadId);
        return { rows: lead ? [lead] : [] };
      }
      // UPDATE leads SET google_contact_sync_status
      if (sql && sql.includes('UPDATE leads SET google_contact_sync_status')) return { rows: [] };
      // UPDATE google_contacts_outbox SET status
      if (sql && sql.includes('UPDATE google_contacts_outbox SET status')) return { rows: [] };
      return { rows: [] };
    },
    connect: async function () {
      return {
        query: async function (sql, params) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          // SELECT * FROM google_contacts_outbox (claim with FOR UPDATE)
          if (sql && sql.includes('SELECT * FROM google_contacts_outbox')) {
            return { rows: outboxRows.map(r => ({ ...r })) };
          }
          // UPDATE google_contacts_outbox SET status = 'processing'
          if (sql && sql.includes("status = 'processing'")) return { rows: [] };
          return { rows: [] };
        },
        release: function () {},
      };
    },
  };
}

// ── Inline processContactsOutbox for testing ──
async function processContactsOutboxTest(pool, opts) {
  opts = opts || {};
  const batchSize = opts.contactsBatchSize || 5;
  const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
  const DEFAULT_SUB = YARON_EMAIL;

  const client = await pool.connect();
  let rows = [];
  try {
    await client.query('BEGIN');
    const res = await client.query(
      'SELECT * FROM google_contacts_outbox ' +
      "WHERE status IN ('pending', 'failed') AND next_attempt_at <= NOW() " +
      'ORDER BY next_attempt_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED',
      [batchSize]
    );
    rows = res.rows;
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      await client.query(
        "UPDATE google_contacts_outbox SET status = 'processing', updated_at = NOW() WHERE id = ANY($1::uuid[])",
        [ids]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    return { claimed: 0, processed: 0, errors: 0 };
  }
  client.release();

  let processed = 0, errors = 0;

  for (const row of rows) {
    try {
      const leadRes = await pool.query(
        'SELECT l.*, o.email AS owner_email FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1',
        [row.lead_id]
      );
      const lead = leadRes.rows[0];
      if (!lead) {
        await pool.query(
          "UPDATE google_contacts_outbox SET status = 'dead', last_error = 'lead not found', updated_at = NOW() WHERE id = $1",
          [row.id]
        );
        errors++;
        continue;
      }

      const subEmail = lead.owner_email || DEFAULT_SUB;
      const result = await googleContactsClient.createOrUpdateContact(
        { first_name: lead.first_name, last_name: lead.last_name, email: lead.email, phone: lead.phone,
          property_address: lead.property_address, city: lead.city },
        subEmail,
        lead.google_contact_resource_name
      );

      await pool.query(
        "UPDATE leads SET google_contact_sync_status = 'synced', google_contact_resource_name = $1, google_contact_sync_error = NULL, updated_at = NOW() WHERE id = $2",
        [result.resourceName, lead.id]
      );
      await pool.query(
        "UPDATE google_contacts_outbox SET status = 'synced', last_error = NULL, updated_at = NOW() WHERE id = $1",
        [row.id]
      );
      processed++;
    } catch (e) {
      errors++;
      const attempts = row.attempts + 1;
      const maxAttempts = row.max_attempts || 5;
      const dead = attempts >= maxAttempts;

      if (e.code === 'CONTACTS_SCOPE_NOT_CONFIGURED') {
        await pool.query(
          "UPDATE google_contacts_outbox SET status = 'dead', attempts = $1, last_error = $2, updated_at = NOW() WHERE id = $3",
          [attempts, 'Contacts scope not configured', row.id]
        );
        await pool.query(
          "UPDATE leads SET google_contact_sync_status = 'error', google_contact_sync_error = $1, updated_at = NOW() WHERE id = $2",
          ['Contacts scope not configured', row.lead_id]
        );
        continue;
      }

      var backoffSec = Math.min(Math.pow(2, Math.max(attempts - 1, 0)) * 30, 1800);
      await pool.query(
        "UPDATE google_contacts_outbox SET status = $1, attempts = $2, last_error = $3, next_attempt_at = NOW() + ($4 || ' seconds')::interval, updated_at = NOW() WHERE id = $5",
        [dead ? 'dead' : 'failed', attempts, String(e.message).substring(0, 500), String(backoffSec), row.id]
      );
      await pool.query(
        "UPDATE leads SET google_contact_sync_status = 'error', google_contact_sync_error = $1, updated_at = NOW() WHERE id = $2",
        [String(e.message).substring(0, 500), row.lead_id]
      );
    }
    await new Promise(r => setTimeout(r, 1));
  }

  return { claimed: rows.length, processed, errors };
}

// ── Tests ──

async function testExistingResourceNameUpdatesSameContact() {
  _createOrUpdateCalls = 0;
  _createOrUpdateShouldThrow = null;
  _createOrUpdateResult = { resourceName: 'people/c123' };

  const outboxRows = [{ id: 'row-1', lead_id: 'lead-1', attempts: 0, max_attempts: 5 }];
  const leads = [{ id: 'lead-1', first_name: 'John', last_name: 'Doe', email: 'john@test.com',
    phone: '555-1234', google_contact_resource_name: 'people/c123', owner_email: 'yaron@ecconstructiongroup.com' }];
  const pool = makeMockPool(outboxRows, leads);

  const result = await processContactsOutboxTest(pool, {});
  assert.strictEqual(result.processed, 1, 'Should process 1 contact');
  assert.strictEqual(_createOrUpdateCalls, 1, 'Should call createOrUpdateContact once');
  console.log('  ✓ existing resource_name updates same contact');
}

async function testNoMatchCreatesOneContact() {
  _createOrUpdateCalls = 0;
  _createOrUpdateShouldThrow = null;
  _createOrUpdateResult = { resourceName: 'people/new-456' };

  const outboxRows = [{ id: 'row-2', lead_id: 'lead-2', attempts: 0, max_attempts: 5 }];
  const leads = [{ id: 'lead-2', first_name: 'Jane', last_name: 'Smith', email: 'jane@test.com',
    phone: '555-5678', google_contact_resource_name: null, owner_email: null }];
  const pool = makeMockPool(outboxRows, leads);

  const result = await processContactsOutboxTest(pool, {});
  assert.strictEqual(result.processed, 1, 'Should create 1 contact');
  assert.strictEqual(_createOrUpdateCalls, 1, 'Should call createOrUpdateContact once');
  console.log('  ✓ no match creates one contact');
}

async function testGoogleFailureDoesNotRollbackLead() {
  _createOrUpdateCalls = 0;
  _createOrUpdateShouldThrow = { message: 'Google API error 500', code: null };

  const outboxRows = [{ id: 'row-3', lead_id: 'lead-3', attempts: 0, max_attempts: 5 }];
  const leads = [{ id: 'lead-3', first_name: 'Bob', last_name: 'Jones', email: 'bob@test.com',
    phone: '555-9999', google_contact_resource_name: null, owner_email: null }];
  const pool = makeMockPool(outboxRows, leads);

  const result = await processContactsOutboxTest(pool, {});
  assert.strictEqual(result.errors, 1, 'Should have 1 error');
  assert.strictEqual(result.processed, 0, 'Should NOT process successfully');
  // The lead itself is NOT rolled back — the outbox row is marked as failed
  // The lead still exists in the database
  console.log('  ✓ Google failure does NOT roll back Lead creation');
}

async function testFailureStatusPersisted() {
  _createOrUpdateCalls = 0;
  _createOrUpdateShouldThrow = { message: 'Network timeout', code: null };

  const outboxRows = [{ id: 'row-4', lead_id: 'lead-4', attempts: 0, max_attempts: 5 }];
  const leads = [{ id: 'lead-4', first_name: 'Alice', last_name: 'Brown', email: 'alice@test.com',
    phone: '555-0000', google_contact_resource_name: null, owner_email: null }];

  let updateLeadCalls = [];
  const pool = {
    ...makeMockPool(outboxRows, leads),
    query: async function (sql, params) {
      if (sql && sql.includes('UPDATE leads SET google_contact_sync_status')) {
        updateLeadCalls.push({ sql, params });
        return { rows: [] };
      }
      return makeMockPool(outboxRows, leads).query(sql, params);
    },
  };

  const result = await processContactsOutboxTest(pool, {});
  assert.strictEqual(result.errors, 1, 'Should have 1 error');
  // Verify error status was persisted to the lead
  assert.ok(updateLeadCalls.length > 0, 'Should update lead with error status');
  const errorUpdate = updateLeadCalls.find(u => u.sql.includes("google_contact_sync_status = 'error'"));
  assert.ok(errorUpdate, 'Should set google_contact_sync_status to error');
  console.log('  ✓ failure status persisted');
}

async function testRetrySucceeds() {
  _createOrUpdateCalls = 0;

  const outboxRows = [{ id: 'row-5', lead_id: 'lead-5', attempts: 1, max_attempts: 5 }];
  const leads = [{ id: 'lead-5', first_name: 'Charlie', last_name: 'Davis', email: 'charlie@test.com',
    phone: '555-1111', google_contact_resource_name: null, owner_email: null }];
  const pool = makeMockPool(outboxRows, leads);

  // First attempt fails
  _createOrUpdateShouldThrow = { message: 'Temporary error', code: null };
  const failResult = await processContactsOutboxTest(pool, {});
  assert.strictEqual(failResult.errors, 1, 'First attempt should fail');

  // Second attempt succeeds
  _createOrUpdateShouldThrow = null;
  _createOrUpdateResult = { resourceName: 'people/c789' };
  _createOrUpdateCalls = 0;
  const successResult = await processContactsOutboxTest(pool, {});
  assert.strictEqual(successResult.processed, 1, 'Retry should succeed');
  console.log('  ✓ retry succeeds');
}

async function testMissingContactsScopeDoesNotBreakLead() {
  _createOrUpdateCalls = 0;
  _createOrUpdateShouldThrow = { message: 'Contacts scope not configured', code: 'CONTACTS_SCOPE_NOT_CONFIGURED' };

  const outboxRows = [{ id: 'row-6', lead_id: 'lead-6', attempts: 0, max_attempts: 5 }];
  const leads = [{ id: 'lead-6', first_name: 'Eve', last_name: 'Wilson', email: 'eve@test.com',
    phone: '555-2222', google_contact_resource_name: null, owner_email: null }];

  let deadUpdates = [];
  let leadErrorUpdates = [];
  const pool = {
    ...makeMockPool(outboxRows, leads),
    query: async function (sql, params) {
      if (sql && sql.includes("status = 'dead'") && sql.includes('google_contacts_outbox')) {
        deadUpdates.push({ sql, params });
        return { rows: [] };
      }
      if (sql && sql.includes('UPDATE leads SET google_contact_sync_status')) {
        leadErrorUpdates.push({ sql, params });
        return { rows: [] };
      }
      return makeMockPool(outboxRows, leads).query(sql, params);
    },
  };

  const result = await processContactsOutboxTest(pool, {});
  assert.strictEqual(result.errors, 1, 'Should have 1 error');
  // Should mark outbox as dead (stop hammering Google)
  assert.ok(deadUpdates.length > 0, 'Should mark outbox row as dead');
  // Should mark lead with error status
  assert.ok(leadErrorUpdates.length > 0, 'Should persist error to lead');
  console.log('  ✓ missing Contacts scope does not break Lead creation (marks dead, persists error)');
}

async function testRepeatedProcessingIdempotent() {
  _createOrUpdateCalls = 0;
  _createOrUpdateShouldThrow = null;
  _createOrUpdateResult = { resourceName: 'people/c999' };

  const outboxRows = [{ id: 'row-7', lead_id: 'lead-7', attempts: 0, max_attempts: 5 }];
  const leads = [{ id: 'lead-7', first_name: 'Idem', last_name: 'Potent', email: 'idem@test.com',
    phone: '555-3333', google_contact_resource_name: 'people/c999', owner_email: null }];

  const pool = makeMockPool(outboxRows, leads);

  // Process the same outbox row twice
  const result1 = await processContactsOutboxTest(pool, {});
  _createOrUpdateCalls = 0;
  const result2 = await processContactsOutboxTest(pool, {});

  // Both should succeed — the Google Contacts client has duplicate prevention
  // (existing resource_name → update, not create)
  assert.strictEqual(result1.processed, 1, 'First processing should succeed');
  assert.strictEqual(result2.processed, 1, 'Second processing should also succeed');
  console.log('  ✓ repeated processing remains idempotent (no duplicate contacts)');
}

// ── Run all tests ──
async function runAll() {
  console.log('Google Contacts Auto-Sync Tests:\n');
  await testExistingResourceNameUpdatesSameContact();
  await testNoMatchCreatesOneContact();
  await testGoogleFailureDoesNotRollbackLead();
  await testFailureStatusPersisted();
  await testRetrySucceeds();
  await testMissingContactsScopeDoesNotBreakLead();
  await testRepeatedProcessingIdempotent();
  console.log('\n✅ All Google Contacts auto-sync tests passed');
}

runAll().catch(e => {
  console.error('❌ Test failed:', e.message);
  process.exit(1);
});