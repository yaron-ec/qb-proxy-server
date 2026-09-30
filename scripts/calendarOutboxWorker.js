#!/usr/bin/env node
// Redeploy trigger 2026-09-15: contacts outbox + calendar reconciliation + shebang fix
/* eslint-disable no-undef */
/**
 * calendarOutboxWorker — standalone outbox drainer.
 *
 * This IS the live production worker (Railway service `noble-illumination`,
 * per CLAUDE.md's manually-verified topology — the file's own older header
 * claiming "NOT auto-deployed" predates that verification and was stale).
 *   node scripts/calendarOutboxWorker.js            # continuous loop
 *   node scripts/calendarOutboxWorker.js --once     # single drain then exit
 *
 * Env:
 *   DATABASE_URL              (required)
 *   GOOGLE_SERVICE_ACCOUNT_KEY  service account JSON with Calendar/Contacts
 *                               scope — required only when this installation's
 *                               enabled_modules.google_calendar or
 *                               .google_contacts is true (PRODUCTIZATION:
 *                               an installation with neither enabled must be
 *                               able to run this worker's other,
 *                               Google-independent work — e.g. legacy Phone
 *                               Call conversion — without crash-looping on a
 *                               credential it doesn't need).
 *   GOOGLE_CALENDAR_ID        target calendar (default 'primary')
 *   CALENDAR_OUTBOX_BATCH     claim batch size (default 10)
 *   CALENDAR_OUTBOX_LEASE_MS  processing lease before a row is reaped (default 60000)
 *   CALENDAR_OUTBOX_INTERVAL_MS  loop interval (default 5000)
 */
'use strict';

const { pool } = require('../db/client');
const outbox = require('../lib/booking/calendarOutbox');
const contactsOutbox = require('../lib/googleContactsOutbox');
const { reconcileFollowUpReminders } = require('../lib/booking/followUpReminders');
const { convertLegacyPhoneCallAppointments } = require('../lib/booking/legacyPhoneCallConversion');
const companyConfig = require('../lib/companyConfig');

// Reconciliation runs every N ticks to avoid hammering Google on every loop
const RECONCILE_EVERY_N_TICKS = parseInt(process.env.CALENDAR_RECONCILE_INTERVAL || '30', 10);
// Phone Call follow-up reminders (non-blocking Google visibility) every N ticks
const FOLLOWUP_REMINDERS_EVERY_N_TICKS = parseInt(process.env.FOLLOWUP_REMINDER_INTERVAL || '6', 10);
let _tickCount = 0;
let _reminderTick = 0;
let _contactsOutboxEnsured = false;

async function tick(workerId, opts) {
  // PRODUCTIZATION: resolved once per tick (companyConfig has its own 30s
  // in-process cache). An installation with google_calendar/google_contacts
  // disabled must never have this worker make a real call to either API —
  // not "fail on a missing secret", a clean, deliberate skip. Everything
  // else in this worker (legacy phone-call conversion is pure CRM data
  // cleanup, no external call) is unaffected either way.
  const googleCalendarEnabled = await companyConfig.isModuleEnabled('google_calendar');
  const googleContactsEnabled = await companyConfig.isModuleEnabled('google_contacts');

  // Ensure contacts outbox table exists (idempotent, safe, no external call) — isolated
  if (!_contactsOutboxEnsured) {
    try {
      await contactsOutbox.ensureContactsOutbox(pool);
      _contactsOutboxEnsured = true;
    } catch (e) {
      console.error('[outbox-worker] ensureContactsOutbox failed:', e.message);
    }
  }

  // 1. Calendar outbox: reap stuck + process pending (PRIMARY — always runs
  //    when google_calendar is enabled)
  if (googleCalendarEnabled) {
    try {
      await outbox.reapStuck(pool, opts.leaseMs);
      var result = await outbox.claimAndProcess(pool, workerId, opts);
      if (result.claimed) {
        console.log("[outbox-worker] calendar claimed=" + result.claimed + " processed=" + result.processed);
      }
    } catch (e) {
      console.error('[outbox-worker] calendar tick failed:', e.message);
    }
  }

  // 2. Contacts outbox: reap stuck + process pending (ISOLATED — never blocks
  //    Calendar; gated independently on google_contacts)
  if (googleContactsEnabled) {
    try {
      await contactsOutbox.reapStuckContacts(pool, opts.contactsLeaseMs || opts.leaseMs);
      var contactsResult = await contactsOutbox.processContactsOutbox(pool, opts);
      if (contactsResult.claimed) {
        console.log("[outbox-worker] contacts claimed=" + contactsResult.claimed + " processed=" + contactsResult.processed + " errors=" + contactsResult.errors);
      }
    } catch (e) {
      console.error('[outbox-worker] contacts tick failed:', e.message);
    }
  }

  // 3. Phone Call = follow-up (ISOLATED): move active future legacy Phone Call
  //    appointment rows onto the lead's follow-up (backed up, reversible) —
  //    pure CRM data cleanup, no external call, always runs. Reconciling the
  //    non-blocking follow-up reminder EVENT to Google is a separate,
  //    google_calendar-gated step.
  if (_reminderTick++ % FOLLOWUP_REMINDERS_EVERY_N_TICKS === 0) {
    var conv = null;
    try {
      conv = await convertLegacyPhoneCallAppointments(pool);
      if (conv.candidates) {
        console.log("[outbox-worker] legacy phone calls candidates=" + conv.candidates + " converted=" + conv.converted + " deduplicated=" + conv.deduplicated + " ambiguous=" + conv.ambiguous + " errors=" + conv.errors);
      }
    } catch (e) {
      console.error('[outbox-worker] legacy phone call conversion failed:', e.message);
    }
    if (googleCalendarEnabled) {
      try {
        var rem = await reconcileFollowUpReminders(pool);
        if (rem.upserted || rem.removed || rem.expired || rem.errors) {
          console.log("[outbox-worker] followup reminders desired=" + rem.desired + " upserted=" + rem.upserted + " removed=" + rem.removed + " expired=" + rem.expired + " unchanged=" + rem.unchanged + " errors=" + rem.errors);
        }
        await pool.query(
          `INSERT INTO followup_reminder_runs (id, last_run_at, last_stats, commit_sha) VALUES (1, NOW(), $1, $2)
           ON CONFLICT (id) DO UPDATE SET last_run_at = NOW(), last_stats = EXCLUDED.last_stats, commit_sha = EXCLUDED.commit_sha`,
          [JSON.stringify({ conversion: conv || null, reminders: rem }), process.env.RAILWAY_GIT_COMMIT_SHA || null]);
      } catch (e) {
        console.error('[outbox-worker] followup reminders failed:', e.message);
      }
    }
  }

  // 4. Calendar reconciliation: verify synced events every N ticks (ISOLATED,
  //    google_calendar-gated — this only ever reads/writes Google state)
  _tickCount++;
  if (googleCalendarEnabled && _tickCount >= RECONCILE_EVERY_N_TICKS) {
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
  // PRODUCTIZATION: only require the Google credential when this
  // installation actually uses Google Calendar or Contacts. Before this
  // fix, an installation with BOTH disabled (e.g. a fresh Company #2 that
  // never configures Google at all) had this worker crash-loop on startup
  // forever — GOOGLE_SERVICE_ACCOUNT_KEY was required unconditionally, even
  // though this worker also does unrelated, Google-independent work (legacy
  // Phone Call conversion). enabled_modules is read fresh here (not cached)
  // since this only runs once, at startup, before the tick loop.
  const companyCfg = await companyConfig.getCompanyConfig();
  const needsGoogle = companyCfg.enabled_modules?.google_calendar || companyCfg.enabled_modules?.google_contacts;
  if (needsGoogle && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.error('[outbox-worker] google_calendar/google_contacts enabled but GOOGLE_SERVICE_ACCOUNT_KEY not set — cannot call Google');
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

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { tick, main };