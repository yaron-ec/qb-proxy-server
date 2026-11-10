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
 * REMINDER_DRY_RUN defaults to 'true' → candidate selection only, no emails,
 * no Postgres claim writes. Set REMINDER_DRY_RUN=false to enable real sending.
 */
'use strict';

const engine = require('./lib/reminderEngine');
const phoneEngine = require('./lib/phoneCallReminders');
const taskEngine = require('./lib/taskReminderEngine');
const estimateFollowupEngine = require('./lib/estimateFollowupEngine');

(async () => {
  const dryRun = process.env.REMINDER_DRY_RUN !== 'false'; // default true
  try {
    // Appointment, phone-call, and task reminders run in the same single-replica
    // cron tick with no cross-coupling. All engines are Railway-native.
    const apt = await engine.processReminders({ dryRun, triggeredBy: 'cron' });
    const phone = await phoneEngine.processPhoneCallReminders({ dryRun, triggeredBy: 'cron' });
    const task = await taskEngine.processTaskReminders({ dryRun, triggeredBy: 'cron' });

    // Estimate follow-up sequence — its OWN independent dry-run flag
    // (ESTIMATE_FOLLOWUP_DRY_RUN, default true) rather than REMINDER_DRY_RUN,
    // per this codebase's "one flag per independent concern" doctrine. A
    // failure here must never fail the reminder/phone/task passes above —
    // same isolation the watchdog call below already gets.
    let estimateFollowup = null;
    try {
      estimateFollowup = await estimateFollowupEngine.processEstimateFollowups({ triggeredBy: 'cron' });
    } catch (e) {
      console.error('[reminderWorker] estimate followup error:', e.message);
      estimateFollowup = { ok: false, error: e.message };
    }

    console.log('[reminderWorker] done:', JSON.stringify({ appointment: apt, phone, task, estimateFollowup }));

    // Railway-owned production watchdog — runs after reminders in the same
    // cron tick. ONE canonical execution path (artistic-determination */15).
    // No Base44 dependency. No duplicate schedulers. Watchdog failure does
    // NOT fail the reminder pass — it logs and continues.
    try {
      const { runWatchdog } = require('./productionWatchdog');
      const watchdogSummary = await runWatchdog();
      console.log('[reminderWorker] watchdog:', JSON.stringify(watchdogSummary));
    } catch (e) {
      console.error('[reminderWorker] watchdog error:', e.message);
    }

    process.exit(0);
  } catch (e) {
    console.error('[reminderWorker] fatal:', e);
    process.exit(1);
  }
})();