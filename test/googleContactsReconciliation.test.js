/* eslint-disable no-undef */
'use strict';

/**
 * googleContactsReconciliation.test.js — regression coverage for the Google
 * Contacts system-wide reconciliation + automatic sync repair.
 *
 * Confirmed, source-level defects fixed in this pass:
 *   1. routes/metaWebhook.js (Meta/Facebook Lead Ads — a live, env-var-gated
 *      production integration per CLAUDE.md) created leads without ever
 *      calling enqueueContactSync — those leads never synced to Google
 *      Contacts at all, in either its with-appointment or lead-only branch.
 *   2. routes/leads.js PUT /by-external/:externalRef (the legacy upsert-by-
 *      external-ref path) never enqueued either, on create OR update.
 *   3. routes/leads.js PUT /:id (the canonical "Edit Lead" endpoint used by
 *      the CRM UI) never re-enqueued sync when contact fields (name/phone/
 *      email/address) were edited after creation — a Lead was only ever
 *      synced ONCE, at creation. A later correction to a mistyped phone
 *      number, for example, would leave the existing Google Contact
 *      permanently stale. This is the leading source-level explanation for
 *      the Mia Arias acceptance case (CRM shows the lead correctly, but the
 *      phone/caller-ID lookup never resolves a name) if her phone number
 *      was ever corrected post-creation — see PRODUCTION MUTATION section
 *      of the final report for what could not be confirmed without live
 *      DB/API access.
 *   4. lib/googleContactsClient.js#findContact compared phone numbers with
 *      `googleStoredDigits.includes(incomingNormalizedDigits)`, which only
 *      matches when the stored contact's digit string is the same length or
 *      longer than the incoming, country-code-prefixed lead phone. A
 *      contact stored as a bare 10-digit US number (very common — anything
 *      a human typed in without "+1") would never match an incoming
 *      "+1XXXXXXXXXX" lead phone, causing createOrUpdateContact() to create
 *      a DUPLICATE contact instead of updating the existing one.
 *   5. lib/googleContactsOutbox.js#enqueueContactSync inserted a new outbox
 *      row unconditionally (its `ON CONFLICT DO NOTHING` had no actual
 *      conflict target — the table's PK is a fresh random UUID per row, and
 *      there is no unique constraint on lead_id) — repeated enqueue calls
 *      for the same lead piled up redundant rows instead of being
 *      idempotent, and enqueuing never updated the lead's own
 *      google_contact_sync_status, so a stale 'synced'/'error' status could
 *      sit there even while a fresh sync was actually queued.
 *   6. No column distinguished "last successfully synced at" from
 *      leads.updated_at (bumped by ANY write, including the sync success
 *      write itself), making it structurally impossible to detect a lead
 *      edited after its last successful sync (STALE). Fixed by migration
 *      2026-38 (google_contact_synced_at), written only on sync success.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readRepo(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

// ── 1 & 2. Source checks: every canonical Lead-creation path enqueues ──────

test('routes/leads.js POST / (New Lead) enqueues Google Contacts sync', () => {
  const src = readRepo('routes/leads.js');
  const start = src.indexOf("router.post('/', requireAuth");
  const end = src.indexOf("router.put('/:id', requireAuth");
  const postCreate = src.slice(start, end);
  assert.ok(postCreate.includes('enqueueContactSync(pool, fullRow.id)'), 'New Lead creation must enqueue contacts sync');
});

test('routes/publicCapture.js (public capture form) enqueues Google Contacts sync', () => {
  const src = readRepo('routes/publicCapture.js');
  assert.ok(src.includes('enqueueContactSync(db.pool, leadId)'), 'public capture must enqueue contacts sync');
});

test('routes/metaWebhook.js (Meta/Facebook Lead Ads) enqueues Google Contacts sync in BOTH lead-creation branches', () => {
  const src = readRepo('routes/metaWebhook.js');
  const matches = src.match(/enqueueContactSync\(db\.pool, leadId\)/g) || [];
  assert.strictEqual(matches.length, 2, 'both the with-appointment and lead-only branches must enqueue (previously enqueued 0 times)');
});

test('routes/leads.js PUT /by-external/:externalRef enqueues on create AND on contact-field update', () => {
  const src = readRepo('routes/leads.js');
  const putByExternal = src.slice(src.indexOf("router.put('/by-external/:externalRef'"), src.indexOf("router.delete('/by-external/:externalRef'"));
  assert.ok(putByExternal.includes('enqueueContactSync(pool, fullRow.id)'), 'legacy upsert-by-external-ref path must enqueue contacts sync');
  assert.ok(putByExternal.includes('wasNew || contactFieldsTouched'), 'must enqueue for both new leads and contact-field edits, not creation only');
});

test('routes/leads.js PUT /:id (Edit Lead) re-enqueues sync when contact fields change', () => {
  const src = readRepo('routes/leads.js');
  const putById = src.slice(src.indexOf("router.put('/:id', requireAuth"), src.indexOf("router.delete('/:id', requireAuth"));
  assert.ok(putById.includes('enqueueContactSync(pool, fullRow.id)'), 'editing a lead must re-enqueue contacts sync');
  assert.ok(putById.includes('contactChanged'), 'must gate on whether a contact-relevant field actually changed');
});

// ── 3, 8. Phone matching / duplicate prevention ────────────────────────────

// Throwaway RSA key — never a real credential — only used to exercise
// googleContactsClient's JWT-signing code path against a mocked fetch.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
  client_email: 'test-sa@test.iam.gserviceaccount.com',
  private_key: privateKey,
});

let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
global.fetch = (...args) => fetchImpl(...args);

const googleContactsClient = require('../lib/googleContactsClient');

test('createOrUpdateContact: matches an existing contact stored as a bare 10-digit number against an incoming +1-normalized lead phone (regression for the duplicate-creation bug)', async () => {
  fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
    }
    if (u.includes('searchContacts')) {
      return {
        ok: true,
        json: async () => ({
          results: [{ person: { resourceName: 'people/mia-existing', phoneNumbers: [{ value: '(818) 400-8787' }] } }],
        }),
      };
    }
    if (u.includes(':updateContact')) {
      return { ok: true, json: async () => ({ resourceName: 'people/mia-existing' }) };
    }
    throw new Error('unexpected fetch in test: ' + u);
  };

  const result = await googleContactsClient.createOrUpdateContact(
    { first_name: 'Mia', last_name: 'Arias', phone: '+18184008787' },
    'rep-phone-match@test.com',
    null // no stored resource_name yet — must fall back to findContact()
  );
  assert.strictEqual(result.resourceName, 'people/mia-existing');
  assert.strictEqual(result.created, false, 'must UPDATE the existing contact, not create a duplicate');
});

test('createOrUpdateContact: creates a new contact only when genuinely no match exists', async () => {
  fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok-2', expires_in: 3600 }) };
    }
    if (u.includes('searchContacts')) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    if (u.includes('createContact')) {
      return { ok: true, json: async () => ({ resourceName: 'people/brand-new' }) };
    }
    throw new Error('unexpected fetch in test: ' + u);
  };

  const result = await googleContactsClient.createOrUpdateContact(
    { first_name: 'New', last_name: 'Person', phone: '+15551234567' },
    'rep-no-match@test.com',
    null
  );
  assert.strictEqual(result.resourceName, 'people/brand-new');
  assert.strictEqual(result.created, true);
});

// ── 4, 5, 6, 7. Reconciliation classification ──────────────────────────────

const { classifyLeads } = require('../scripts/reconcileGoogleContacts');

function makeClassifyPool(leads, outboxRows) {
  return {
    query: async (sql, params) => {
      if (sql.includes('FROM leads')) return { rows: leads };
      if (sql.includes('FROM google_contacts_outbox')) {
        const leadIds = new Set(params[0]);
        return { rows: outboxRows.filter(r => leadIds.has(r.lead_id)) };
      }
      return { rows: [] };
    },
  };
}

test('reconciliation: an unmodified, synced lead is CONFIRMED_SYNCED and excluded from re-sync', async () => {
  const synced = new Date('2026-09-01T00:00:00Z');
  const leads = [{ id: 'l1', phone: '+15551110000', email: null, updated_at: synced, google_contact_sync_status: 'synced', google_contact_synced_at: synced, google_contact_resource_name: 'people/1' }];
  const pool = makeClassifyPool(leads, []);
  const buckets = await classifyLeads(pool);
  assert.strictEqual(buckets.CONFIRMED_SYNCED.length, 1);
  assert.strictEqual(buckets.STALE.length, 0);
  assert.strictEqual(buckets.MISSING.length, 0);
});

test('reconciliation: a lead with no outbox row and no sync status is MISSING', async () => {
  const leads = [{ id: 'l2', phone: '+15552220000', email: null, updated_at: new Date(), google_contact_sync_status: null, google_contact_synced_at: null, google_contact_resource_name: null }];
  const pool = makeClassifyPool(leads, []);
  const buckets = await classifyLeads(pool);
  assert.strictEqual(buckets.MISSING.length, 1);
});

test('reconciliation: a synced lead edited afterward (updated_at > synced_at) is STALE', async () => {
  const syncedAt = new Date('2026-09-01T00:00:00Z');
  const editedAt = new Date('2026-09-10T00:00:00Z');
  const leads = [{ id: 'l3', phone: '+15553330000', email: null, updated_at: editedAt, google_contact_sync_status: 'synced', google_contact_synced_at: syncedAt, google_contact_resource_name: 'people/3' }];
  const pool = makeClassifyPool(leads, []);
  const buckets = await classifyLeads(pool);
  assert.strictEqual(buckets.STALE.length, 1, 'must detect drift between last edit and last successful sync');
  assert.strictEqual(buckets.CONFIRMED_SYNCED.length, 0);
});

test('reconciliation: a lead with a failed or dead outbox row is FAILED_RETRYABLE', async () => {
  const leads = [
    { id: 'l4', phone: '+15554440000', email: null, updated_at: new Date(), google_contact_sync_status: 'error', google_contact_synced_at: null, google_contact_resource_name: null },
    { id: 'l5', phone: '+15555550000', email: null, updated_at: new Date(), google_contact_sync_status: 'error', google_contact_synced_at: null, google_contact_resource_name: null },
  ];
  const outboxRows = [
    { lead_id: 'l4', status: 'failed', attempts: 2, max_attempts: 5 },
    { lead_id: 'l5', status: 'dead', attempts: 5, max_attempts: 5 },
  ];
  const pool = makeClassifyPool(leads, outboxRows);
  const buckets = await classifyLeads(pool);
  assert.strictEqual(buckets.FAILED_RETRYABLE.length, 2);
});

test('reconciliation: a lead with an active pending/processing outbox row is PENDING, not re-enqueued', async () => {
  const leads = [{ id: 'l6', phone: '+15556660000', email: null, updated_at: new Date(), google_contact_sync_status: 'pending', google_contact_synced_at: null, google_contact_resource_name: null }];
  const outboxRows = [{ lead_id: 'l6', status: 'pending', attempts: 0, max_attempts: 5 }];
  const pool = makeClassifyPool(leads, outboxRows);
  const buckets = await classifyLeads(pool);
  assert.strictEqual(buckets.PENDING.length, 1);
});

test('reconciliation: a lead synced before google_contact_synced_at existed is CANNOT_VERIFY, not silently confirmed', async () => {
  const leads = [{ id: 'l7', phone: '+15557770000', email: null, updated_at: new Date(), google_contact_sync_status: 'synced', google_contact_synced_at: null, google_contact_resource_name: 'people/7' }];
  const pool = makeClassifyPool(leads, []);
  const buckets = await classifyLeads(pool);
  assert.strictEqual(buckets.CANNOT_VERIFY.length, 1, 'freshness cannot be claimed without a synced_at timestamp to compare against');
});

// ── 9. Repeated reconciliation / enqueue idempotency ───────────────────────

test('enqueueContactSync: repeated calls for the same lead do not pile up duplicate outbox rows', async () => {
  const inserted = [];
  let pendingRowExists = false;
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id FROM google_contacts_outbox')) {
        return { rows: pendingRowExists ? [{ id: 'existing-row' }] : [] };
      }
      if (sql.includes('INSERT INTO google_contacts_outbox')) {
        inserted.push(params[0]);
        pendingRowExists = true;
        return { rows: [] };
      }
      if (sql.includes("UPDATE leads SET google_contact_sync_status = 'pending'")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const contactsOutbox = require('../lib/googleContactsOutbox');
  await contactsOutbox.enqueueContactSync(pool, 'lead-idem-1');
  await contactsOutbox.enqueueContactSync(pool, 'lead-idem-1');
  await contactsOutbox.enqueueContactSync(pool, 'lead-idem-1');
  assert.strictEqual(inserted.length, 1, 'only the first call should insert a row while one is still pending');
});

test('enqueueContactSync: flips the lead\'s own sync status to pending so a stale synced/error status is never left showing while a fresh sync is queued', async () => {
  const leadStatusUpdates = [];
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id FROM google_contacts_outbox')) return { rows: [] };
      if (sql.includes('INSERT INTO google_contacts_outbox')) return { rows: [] };
      if (sql.includes("UPDATE leads SET google_contact_sync_status = 'pending'")) {
        leadStatusUpdates.push(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const contactsOutbox = require('../lib/googleContactsOutbox');
  await contactsOutbox.enqueueContactSync(pool, 'lead-status-1');
  assert.deepStrictEqual(leadStatusUpdates, ['lead-status-1']);
});

// ── 10, 11. Worker isolation — one bad Contacts job / Calendar independence ─

test('scripts/calendarOutboxWorker.js: Calendar and Contacts outbox steps run in independent try/catch blocks each tick', () => {
  const src = readRepo('scripts/calendarOutboxWorker.js');
  const calendarStep = src.slice(src.indexOf('// 1. Calendar outbox'), src.indexOf('// 2. Contacts outbox'));
  const contactsStep = src.slice(src.indexOf('// 2. Contacts outbox'), src.indexOf('// 3. Calendar reconciliation'));
  assert.ok(/try\s*\{/.test(calendarStep) && /catch/.test(calendarStep), 'Calendar step must have its own try/catch');
  assert.ok(/try\s*\{/.test(contactsStep) && /catch/.test(contactsStep), 'Contacts step must have its own try/catch — isolated from Calendar');
});

test('processContactsOutbox: one failed contact job does not stop the batch from processing the remaining rows', async () => {
  const contactsOutbox = require('../lib/googleContactsOutbox');
  const leadsById = {
    'lead-fail': { id: 'lead-fail', first_name: 'Fails', last_name: 'Row', phone: '+15550000001', google_contact_resource_name: null },
    'lead-ok': { id: 'lead-ok', first_name: 'Succeeds', last_name: 'Row', phone: '+15550000002', google_contact_resource_name: null },
  };
  let callCount = 0;
  fetchImpl = async () => { throw new Error('processContactsOutbox must not call fetch directly'); };

  // Monkey-patch the googleContactsClient module used internally by
  // lib/googleContactsOutbox.js so the first lead throws and the second
  // succeeds, proving the per-row try/catch isolates one bad job.
  const clientPath = require.resolve('../lib/googleContactsClient');
  const originalClient = require.cache[clientPath];
  require.cache[clientPath].exports = {
    ...originalClient.exports,
    createOrUpdateContact: async (lead) => {
      callCount++;
      if (lead.first_name === 'Fails') throw new Error('simulated Google API failure');
      return { resourceName: 'people/ok', created: true };
    },
  };
  delete require.cache[require.resolve('../lib/googleContactsOutbox')];
  const freshOutbox = require('../lib/googleContactsOutbox');

  const outboxRows = [
    { id: 'row-fail', lead_id: 'lead-fail', status: 'pending', attempts: 0, max_attempts: 5 },
    { id: 'row-ok', lead_id: 'lead-ok', status: 'pending', attempts: 0, max_attempts: 5 },
  ];
  const pool = {
    connect: async () => ({
      query: async (sql) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (sql.includes('SELECT * FROM google_contacts_outbox')) return { rows: outboxRows };
        return { rows: [] };
      },
      release: () => {},
    }),
    query: async (sql, params) => {
      if (sql.includes('SELECT l.*')) {
        const lead = leadsById[params[0]];
        return { rows: lead ? [lead] : [] };
      }
      return { rows: [] };
    },
  };

  const result = await freshOutbox.processContactsOutbox(pool, {});
  assert.strictEqual(result.errors, 1, 'the failing row must be counted as an error');
  assert.strictEqual(result.processed, 1, 'the healthy row must still be processed despite the other row failing');
  assert.strictEqual(callCount, 2, 'both rows must have been attempted — one failure must not abort the batch');

  // Restore the real client for any subsequent tests in this process.
  require.cache[clientPath].exports = originalClient.exports;
});
