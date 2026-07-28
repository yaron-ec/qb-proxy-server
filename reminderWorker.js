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
const phoneEngine = require('./lib/phoneCallReminders');
const taskEngine = require('./lib/taskReminderEngine');

(async () => {
  const dryRun = process.env.REMINDER_DRY_RUN !== 'false'; // default true for Phase 2
  try {
    // Each engine is independently transport-gated (EMAIL_<FLOW>_TRANSPORT,
    // default 'base44') so a still-Base44 flow sends nothing here. Appointment,
    // phone-call, and task reminders run in the same single-replica cron tick
    // with no cross-coupling.
    const apt = await engine.processReminders({ dryRun, triggeredBy: 'cron' });
    const phone = await phoneEngine.processPhoneCallReminders({ dryRun, triggeredBy: 'cron' });
    const task = await taskEngine.processTaskReminders({ dryRun, triggeredBy: 'cron' });
    console.log('[reminderWorker] done:', JSON.stringify({ appointment: apt, phone, task }));
    process.exit(0);
  } catch (e) {
    console.error('[reminderWorker] fatal:', e);
    process.exit(1);
  }
})();