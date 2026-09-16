#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * reconcileGoogleContacts.js — idempotent Google Contacts sync reconciliation.
 *
 * Classifies every Lead with a phone or email into exactly one bucket:
 *   CONFIRMED_SYNCED  — synced, and not edited since (updated_at <= google_contact_synced_at)
 *   MISSING           — no sync ever attempted (no outbox row, no sync status)
 *   FAILED_RETRYABLE  — an outbox row exists in 'failed' state (will retry itself
 *                       on its own backoff schedule) or 'dead' state (exhausted
 *                       retries — needs a fresh enqueue to try again)
 *   PENDING           — already queued (outbox row 'pending'/'processing') — left alone
 *   STALE             — was synced, but the lead has been edited since
 *                       (updated_at > google_contact_synced_at)
 *   CANNOT_VERIFY     — synced before google_contact_synced_at existed (migration
 *                       2026-38), so freshness cannot be determined from data alone
 *
 * This script NEVER calls the Google Contacts API directly and NEVER creates,
 * updates, or deletes a Google Contact itself — that stays the sole job of
 * lib/googleContactsOutbox.js#processContactsOutbox (run by the existing
 * calendar-outbox-worker / noble-illumination). This script only reads leads
 * + google_contacts_outbox, classifies them, and — ONLY with --enqueue —
 * inserts a 'pending' outbox row for MISSING/FAILED_RETRYABLE/STALE leads via
 * the same enqueueContactSync() used by every other call site, which is
 * itself idempotent (skips leads that already have a pending/processing row).
 *
 * Usage:
 *   node scripts/reconcileGoogleContacts.js              # classify + report only
 *   node scripts/reconcileGoogleContacts.js --enqueue     # also enqueue MISSING/
 *                                                          # FAILED_RETRYABLE/STALE
 *
 * Requires DATABASE_URL. Refuses to run without it (no silent no-op that
 * could be mistaken for "0 leads need reconciliation").
 */
'use strict';

const DO_ENQUEUE = process.argv.includes('--enqueue');

async function classifyLeads(pool) {
  const { rows: leads } = await pool.query(
    `SELECT id, first_name, last_name, phone, email, updated_at,
            google_contact_sync_status, google_contact_synced_at, google_contact_resource_name
     FROM leads
     WHERE (phone IS NOT NULL AND phone != '') OR (email IS NOT NULL AND email != '')`
  );

  const { rows: outboxRows } = await pool.query(
    `SELECT lead_id, status, attempts, max_attempts, next_attempt_at
     FROM google_contacts_outbox
     WHERE lead_id = ANY($1::uuid[])`,
    [leads.map(l => l.id)]
  );
  const outboxByLead = new Map();
  for (const row of outboxRows) {
    // A lead can have multiple historical rows (see lib/googleContactsOutbox.js
    // dedup fix) — keep the most operationally relevant one: an active
    // pending/processing row wins, otherwise the most recently touched.
    const existing = outboxByLead.get(row.lead_id);
    if (!existing) { outboxByLead.set(row.lead_id, row); continue; }
    const activeStatuses = ['pending', 'processing'];
    if (activeStatuses.includes(row.status) && !activeStatuses.includes(existing.status)) {
      outboxByLead.set(row.lead_id, row);
    }
  }

  const buckets = {
    CONFIRMED_SYNCED: [],
    MISSING: [],
    FAILED_RETRYABLE: [],
    PENDING: [],
    STALE: [],
    CANNOT_VERIFY: [],
  };

  for (const lead of leads) {
    const outbox = outboxByLead.get(lead.id);

    if (outbox && (outbox.status === 'pending' || outbox.status === 'processing')) {
      buckets.PENDING.push(lead);
      continue;
    }
    if (outbox && (outbox.status === 'failed' || outbox.status === 'dead')) {
      buckets.FAILED_RETRYABLE.push(lead);
      continue;
    }
    if (!outbox && !lead.google_contact_sync_status) {
      buckets.MISSING.push(lead);
      continue;
    }
    if (lead.google_contact_sync_status === 'synced') {
      if (!lead.google_contact_synced_at) {
        buckets.CANNOT_VERIFY.push(lead);
      } else if (new Date(lead.updated_at) > new Date(lead.google_contact_synced_at)) {
        buckets.STALE.push(lead);
      } else {
        buckets.CONFIRMED_SYNCED.push(lead);
      }
      continue;
    }
    if (lead.google_contact_sync_status === 'error') {
      buckets.FAILED_RETRYABLE.push(lead);
      continue;
    }
    // No outbox row, no recognizable status (e.g. legacy/backfilled data).
    buckets.CANNOT_VERIFY.push(lead);
  }

  return buckets;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — refusing to run (this must never silently report 0 records)');
    process.exit(1);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const buckets = await classifyLeads(pool);

    console.log('=== GOOGLE CONTACTS RECONCILIATION ===');
    console.log('Mode: ' + (DO_ENQUEUE ? 'ENQUEUE (will insert pending outbox rows)' : 'REPORT ONLY (read-only)'));
    console.log('');
    for (const [bucket, rows] of Object.entries(buckets)) {
      console.log(`${bucket}: ${rows.length}`);
    }

    if (DO_ENQUEUE) {
      const contactsOutbox = require('../lib/googleContactsOutbox');
      const toEnqueue = [...buckets.MISSING, ...buckets.FAILED_RETRYABLE, ...buckets.STALE];
      console.log('');
      console.log(`Enqueueing ${toEnqueue.length} leads (MISSING + FAILED_RETRYABLE + STALE)...`);
      let enqueued = 0;
      for (const lead of toEnqueue) {
        await contactsOutbox.enqueueContactSync(pool, lead.id);
        enqueued++;
      }
      console.log(`Enqueued ${enqueued} leads for sync (existing worker will process them; CONFIRMED_SYNCED, PENDING, and CANNOT_VERIFY were left untouched).`);
    } else {
      console.log('');
      console.log('Read-only pass complete. Re-run with --enqueue to queue MISSING + FAILED_RETRYABLE + STALE leads for sync.');
      console.log('No Google Contacts API calls are made by this script under any flag — enqueueing only inserts a pending row for the existing worker to process.');
    }
  } finally {
    await pool.end();
  }
}

module.exports = { classifyLeads };

if (require.main === module) {
  main().catch(e => { console.error('[reconcile-contacts] FAILED:', e.message); process.exit(1); });
}
