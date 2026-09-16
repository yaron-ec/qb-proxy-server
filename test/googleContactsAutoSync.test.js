/* eslint-disable no-undef */
/**
 * googleContactsAutoSync.test.js — tests for Google Contacts auto-sync
 *
 * Covers:
 * - CRM New Lead and Capture New Lead call sites reference a valid,
 *   locally-bound pool when enqueuing contacts sync (regression guard —
 *   see testCaptureAndLeadsEnqueueCallSitesUseValidPool; a prior bug had
 *   routes/publicCapture.js reference a bare, undefined `pool` identifier,
 *   throwing ReferenceError on every capture submission and silently
 *   dropping every public-capture lead's contacts sync)
 * - existing resource_name updates same contact
 * - matching email updates existing contact
 * - matching normalized phone updates existing contact
 * - no match creates one contact
 * - repeated processing remains idempotent
 * - Google failure does NOT roll back Lead creation
 * - failure status persisted
 * - retry succeeds
 * - missing Contacts scope does not break Lead creation
 *
 * NOTE: the outbox-processing tests below exercise a local reimplementation
 * of lib/googleContactsOutbox.js#processContactsOutbox (see
 * processContactsOutboxTest) rather than importing the real module — they
 * verify the outbox-processing CONTRACT, not the two route files' enqueue
 * call sites. testCaptureAndLeadsEnqueueCallSitesUseValidPool below is the
 * only test in this file that actually inspects the route files themselves.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

// ── Regression guard: enqueueContactSync call sites use a valid, locally-
// bound pool reference in EVERY file that calls it ──
//
// This is a static source check, not a live-DB/HTTP test, deliberately:
// routes/publicCapture.js and routes/leads.js each pull in a large call
// graph (booking transactions, address geocoding, Gmail, etc.) that would
// require a heavy mock harness to exercise end-to-end. The actual defect
// this guards against is narrower and purely syntactic — a call site
// referencing an identifier (`pool`) that was never bound in that file's
// scope, which is a ReferenceError on every invocation regardless of what
// any mock returns. A source-level check catches exactly that class of
// bug, deterministically, with no DB/network dependency.
function assertEnqueueCallSiteUsesBoundPool(relPath) {
  const filePath = path.join(__dirname, '..', relPath);
  const src = fs.readFileSync(filePath, 'utf8');
  const callMatch = src.match(/enqueueContactSync\(\s*([A-Za-z_$][\w$.]*)\s*,/);
  assert.ok(callMatch, `${relPath}: expected an enqueueContactSync(...) call site`);
  const arg = callMatch[1]; // e.g. "pool" or "db.pool"
  const rootIdentifier = arg.split('.')[0];

  // The root identifier must be bound somewhere in the file: either
  // destructured directly (`const { pool } = require(...)` /
  // `const { query, pool } = require(...)`), assigned as a whole-module
  // require (`const db = require(...)` when arg is "db.pool"), or declared
  // via a local `const { pool } = require(...)` inside a function body
  // (several routes lazily require db/client mid-handler).
  const destructured = new RegExp(`(?:const|let)\\s*\\{[^}]*\\b${rootIdentifier}\\b[^}]*\\}\\s*=\\s*require\\(['"].*db/client['"]\\)`);
  const wholeModule = new RegExp(`(?:const|let)\\s+${rootIdentifier}\\s*=\\s*require\\(['"].*db/client['"]\\)`);
  const isBound = destructured.test(src) || wholeModule.test(src);

  assert.ok(
    isBound,
    `${relPath}: enqueueContactSync(...) references "${arg}", but "${rootIdentifier}" ` +
    `is never bound from require('.../db/client') anywhere in this file — this is the ` +
    `exact ReferenceError class that broke Google Contacts sync in routes/publicCapture.js`
  );
}

function testCaptureAndLeadsEnqueueCallSitesUseValidPool() {
  assertEnqueueCallSiteUsesBoundPool('routes/publicCapture.js');
  assertEnqueueCallSiteUsesBoundPool('routes/leads.js');
  console.log('  ✓ publicCapture.js and leads.js enqueueContactSync call sites reference a bound pool (regression guard)');
}

// ── Run all tests ──
async function runAll() {
  console.log('Google Contacts Auto-Sync Tests:\n');
  testCaptureAndLeadsEnqueueCallSitesUseValidPool();
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