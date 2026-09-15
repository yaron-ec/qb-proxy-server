#!/usr/bin/env node
// Redeploy trigger 2026-09-15: contacts outbox + calendar reconciliation + shebang fix
/* eslint-disable no-undef */
/**
 * calendarOutboxWorker — standalone Phase 2 outbox drainer.
 *
 * NOT auto-deployed. NOT wired to the server Start Command. Run manually or via
 * a separately-approved scheduler:
 *   node scripts/calendarOutboxWorker.js            # continuous loop
 *   node scripts/calendarOutboxWorker.js --once     # single drain then exit
 *
 * Env:
 *   DATABASE_URL              (required; must be NON-PRODUCTION until cutover)
 *   GOOGLE_SERVICE_ACCOUNT_KEY  service account JSON with Calendar scope
 *   GOOGLE_CALENDAR_ID        target calendar (default 'primary')
 *   CALENDAR_OUTBOX_BATCH     claim batch size (default 10)
 *   CALENDAR_OUTBOX_LEASE_MS  processing lease before a row is reaped (default 60000)
 *   CALENDAR_OUTBOX_INTERVAL_MS  loop interval (default 5000)
 *
 * Deployment to production is a SEPARATE approval gate.
 */
'use strict';

const { pool } = require('../db/client');
const outbox = require('../lib/booking/calendarOutbox');
const contactsOutbox = require('../lib/googleContactsOutbox');

// Reconciliation runs every N ticks to avoid hammering Google on every loop
const RECONCILE_EVERY_N_TICKS = parseInt(process.env.CALENDAR_RECONCILE_INTERVAL || '30', 10);
let _tickCount = 0;
let _contactsOutboxEnsured = false;

async function tick(workerId, opts) {
  // Ensure contacts outbox table exists (idempotent, safe) — isolated
  if (!_contactsOutboxEnsured) {
    try {
      await contactsOutbox.ensureContactsOutbox(pool);
      _contactsOutboxEnsured = true;
    } catch (e) {
      console.error('[outbox-worker] ensureContactsOutbox failed:', e.message);
    }
  }

  // 1. Calendar outbox: reap stuck + process pending (PRIMARY — always runs)
  try {
    await outbox.reapStuck(pool, opts.leaseMs);
    var result = await outbox.claimAndProcess(pool, workerId, opts);
    if (result.claimed) {
      console.log("[outbox-worker] calendar claimed=" + result.claimed + " processed=" + result.processed);
    }
  } catch (e) {
    console.error('[outbox-worker] calendar tick failed:', e.message);
  }

  // 2. Contacts outbox: reap stuck + process pending (ISOLATED — never blocks Calendar)
  try {
    await contactsOutbox.reapStuckContacts(pool, opts.contactsLeaseMs || opts.leaseMs);
    var contactsResult = await contactsOutbox.processContactsOutbox(pool, opts);
    if (contactsResult.claimed) {
      console.log("[outbox-worker] contacts claimed=" + contactsResult.claimed + " processed=" + contactsResult.processed + " errors=" + contactsResult.errors);
    }
  } catch (e) {
    console.error('[outbox-worker] contacts tick failed:', e.message);
  }

  // 3. Calendar reconciliation: verify synced events every N ticks (ISOLATED)
  _tickCount++;
  if (_tickCount >= RECONCILE_EVERY_N_TICKS) {
    _tickCount = 0;
    try {
      var reconResult = await outbox.reconcileSyncedAppointments(pool, opts);
      if (reconResult.checked > 0) {
        console.log("[outbox-worker] reconcile checked=" + reconResult.checked + " verified=" + reconResult.verified + " missing=" + reconResult.missing + " repaired=" + reconResult.repaired + " errors=" + reconResult.errors);
      }
    } catch (e) {
      console.error('[outbox-worker] reconcile tick failed:', e.message);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[outbox-worker] DATABASE_URL not set — refusing to run');
    process.exit(1);
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.error('[outbox-worker] GOOGLE_SERVICE_ACCOUNT_KEY not set — cannot call Google Calendar');
    process.exit(1);
  }
  const workerId = `outbox-${process.pid}-${Date.now()}`;
  const once = process.argv.includes('--once');
  const opts = {
    batchSize: parseInt(process.env.CALENDAR_OUTBOX_BATCH || '10', 10),
    leaseMs: parseInt(process.env.CALENDAR_OUTBOX_LEASE_MS || '60000', 10),
  };
  const intervalMs = parseInt(process.env.CALENDAR_OUTBOX_INTERVAL_MS || '5000', 10);

  if (once) {
    await tick(workerId, opts);
    await pool.end();
    return;
  }
  console.log(`[outbox-worker] starting worker ${workerId} (batch=${opts.batchSize} lease=${opts.leaseMs}ms interval=${intervalMs}ms)`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick(workerId, opts);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

main().catch(e => { console.error(e); process.exit(1); });