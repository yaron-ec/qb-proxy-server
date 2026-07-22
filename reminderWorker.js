/* eslint-disable no-undef */
/**
 * Reminder worker — standalone entrypoint for Railway Cron.
 *
 *   node reminderWorker.js
 *
 * Runs exactly ONE reminder pass and exits. Railway Cron invokes this on a
 * schedule (every 30 min) on the dedicated single-replica
 * `ec-crm-reminder-worker` service. Not embedded in the multi-replica Express
 * proxy, so it cannot fire once-per-replica.
 *
 * Phase 2: REMINDER_DRY_RUN=true (default) → candidate selection only,
 * no emails, no Postgres claim writes, no Base44 Activity writes. Base44
 * remains the active production sender.
 */
'use strict';

const engine = require('./lib/reminderEngine');

(async () => {
  const dryRun = process.env.REMINDER_DRY_RUN !== 'false'; // default true for Phase 2
  try {
    const result = await engine.processReminders({ dryRun, triggeredBy: 'cron' });
    console.log('[reminderWorker] done:', JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    console.error('[reminderWorker] fatal:', e);
    process.exit(1);
  }
})();