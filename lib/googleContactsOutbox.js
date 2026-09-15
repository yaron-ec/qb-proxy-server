/* eslint-disable no-undef */
/**
 * googleContactsOutbox — durable outbox for Google Contacts auto-sync.
 *
 * Mirrors the calendar_outbox pattern: enqueue inside the lead creation
 * transaction (or post-commit), process asynchronously by the existing
 * calendar outbox worker (no new Railway service).
 *
 * Table: google_contacts_outbox (created idempotently by ensureContactsOutbox).
 * Fields: lead_id, status (pending|processing|synced|failed|dead), attempts,
 *        max_attempts, last_error, next_attempt_at.
 *
 * Uses existing leads table fields for the sync result:
 *   google_contact_sync_status, google_contact_resource_name, google_contact_sync_error
 */
'use strict';

const googleContactsClient = require('../googleContactsClient');

const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
const DEFAULT_SUB = process.env.GOOGLE_CONTACTS_SUB || YARON_EMAIL;

// ── ensureContactsOutbox — idempotent table creation (safe, no startup migration) ──
async function ensureContactsOutbox(pool) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS google_contacts_outbox (' +
    '  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(), ' +
    '  lead_id           UUID NOT NULL, ' +
    "  status            TEXT NOT NULL DEFAULT 'pending', " +
    '  attempts          INTEGER NOT NULL DEFAULT 0, ' +
    '  max_attempts      INTEGER NOT NULL DEFAULT 5, ' +
    '  last_error        TEXT, ' +
    '  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
    '  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
    '  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
    ')'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS google_contacts_outbox_ready_idx ' +
    'ON google_contacts_outbox (next_attempt_at) ' +
    "WHERE status IN ('pending', 'failed')"
  );
}

// ── enqueueContactSync — insert a pending outbox row (idempotent per lead) ──
async function enqueueContactSync(pool, leadId) {
  if (!leadId) return;
  await pool.query(
    'INSERT INTO google_contacts_outbox (lead_id, status) ' +
    "VALUES ($1, 'pending') ON CONFLICT DO NOTHING",
    [leadId]
  );
}

// ── processContactsOutbox — claim and process a bounded batch ──
async function processContactsOutbox(pool, opts) {
  opts = opts || {};
  const batchSize = opts.contactsBatchSize || 5;
  const leaseMs = opts.contactsLeaseMs || 60000;

  // Claim rows: SELECT FOR UPDATE SKIP LOCKED, mark as processing
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
      const ids = rows.map(function (r) { return r.id; });
      await client.query(
        "UPDATE google_contacts_outbox SET status = 'processing', updated_at = NOW() " +
        'WHERE id = ANY($1::uuid[])',
        [ids]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    console.error('[contacts-outbox] claim failed:', e.message);
    return { claimed: 0, processed: 0, errors: 0 };
  }
  client.release();

  let processed = 0, errors = 0;

  for (const row of rows) {
    try {
      // Fetch the lead + owner email
      const leadRes = await pool.query(
        'SELECT l.*, o.email AS owner_email FROM leads l ' +
        'LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1',
        [row.lead_id]
      );
      const lead = leadRes.rows[0];
      if (!lead) {
        // Lead was deleted — mark as dead
        await pool.query(
          "UPDATE google_contacts_outbox SET status = 'dead', last_error = 'lead not found', " +
          'updated_at = NOW() WHERE id = $1',
          [row.id]
        );
        errors++;
        continue;
      }

      // Determine the subEmail for DWD impersonation
      const subEmail = lead.owner_email || DEFAULT_SUB;

      // Call the Google Contacts client with correct arguments:
      // (lead, subEmail, existingResourceName)
      const result = await googleContactsClient.createOrUpdateContact(
        {
          first_name: lead.first_name,
          last_name: lead.last_name,
          email: lead.email,
          phone: lead.phone,
          property_address: lead.property_address,
          city: lead.city,
        },
        subEmail,
        lead.google_contact_resource_name
      );

      // Success — update leads table + outbox row
      await pool.query(
        "UPDATE leads SET google_contact_sync_status = 'synced', " +
        'google_contact_resource_name = $1, google_contact_sync_error = NULL, ' +
        'updated_at = NOW() WHERE id = $2',
        [result.resourceName, lead.id]
      );
      await pool.query(
        "UPDATE google_contacts_outbox SET status = 'synced', last_error = NULL, " +
        'updated_at = NOW() WHERE id = $1',
        [row.id]
      );
      processed++;
    } catch (e) {
      errors++;
      const attempts = row.attempts + 1;
      const maxAttempts = row.max_attempts || 5;
      const dead = attempts >= maxAttempts;

      // Special case: Contacts scope not configured — stop immediately
      if (e.code === 'CONTACTS_SCOPE_NOT_CONFIGURED') {
        await pool.query(
          "UPDATE google_contacts_outbox SET status = 'dead', attempts = $1, last_error = $2, " +
          'updated_at = NOW() WHERE id = $3',
          [attempts, 'Contacts scope not configured for service account DWD', row.id]
        );
        await pool.query(
          "UPDATE leads SET google_contact_sync_status = 'error', " +
          'google_contact_sync_error = $1, updated_at = NOW() WHERE id = $2',
          ['Contacts scope not configured', row.lead_id]
        );
        continue;
      }

      // Bounded retry with exponential backoff (30s, 60s, 120s, 240s, 480s — max 1800s)
      var backoffSec = Math.min(Math.pow(2, Math.max(attempts - 1, 0)) * 30, 1800);
      await pool.query(
        'UPDATE google_contacts_outbox SET status = $1, attempts = $2, last_error = $3, ' +
        "next_attempt_at = NOW() + ($4 || ' seconds')::interval, updated_at = NOW() WHERE id = $5",
        [dead ? 'dead' : 'failed', attempts, String(e.message).substring(0, 500), String(backoffSec), row.id]
      );
      // Update lead with error status
      await pool.query(
        "UPDATE leads SET google_contact_sync_status = 'error', " +
        'google_contact_sync_error = $1, updated_at = NOW() WHERE id = $2',
        [String(e.message).substring(0, 500), row.lead_id]
      );
    }
    // Rate safety: 300ms delay between Google API calls
    await new Promise(function (r) { setTimeout(r, 300); });
  }

  return { claimed: rows.length, processed: processed, errors: errors };
}

// ── reapStuckContacts — reset processing rows whose lease expired ──
async function reapStuckContacts(pool, leaseMs) {
  var leaseSec = Math.max(1, Math.floor((leaseMs || 60000) / 1000));
  await pool.query(
    "UPDATE google_contacts_outbox SET status = 'pending', updated_at = NOW() " +
    "WHERE status = 'processing' AND updated_at < NOW() - ($1 || ' seconds')::interval",
    [String(leaseSec)]
  );
}

module.exports = { ensureContactsOutbox, enqueueContactSync, processContactsOutbox, reapStuckContacts };