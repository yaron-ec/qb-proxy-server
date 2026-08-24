#!/usr/bin/env node
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

async function tick(workerId, opts) {
  try {
    await outbox.reapStuck(pool, opts.leaseMs);
    const result = await outbox.claimAndProcess(pool, workerId, opts);
    if (result.claimed) {
      console.log(`[outbox-worker] claimed=${result.claimed} processed=${result.processed}`);
    }
  } catch (e) {
    console.error('[outbox-worker] tick failed:', e.message);
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