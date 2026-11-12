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
const estimateFollowupReplyDetection = require('./lib/estimateFollowupReplyDetection');
const postAppointmentEstimateSync = require('./lib/postAppointmentEstimateSync');

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
    // failure in any of the three passes below must never fail the
    // reminder/phone/task passes above, nor each other — same isolation the
    // watchdog call below already gets. Fixed order, each independently
    // try/caught: (1) poll Gmail for replies and pause any sequence a
    // genuine reply was detected on — must run BEFORE auto-enrollment/send
    // so a reply detected this exact tick can never be raced by a send
    // decided earlier in the same tick; (2) auto-enroll every QB-confirmed-
    // sent estimate not yet enrolled; (3) process due steps for every
    // active sequence (itself gated by the fail-closed reply-monitoring
    // health check — see lib/estimateFollowupEngine.js#processEstimateFollowups).
    let replyPoll = null;
    try {
      replyPoll = await estimateFollowupReplyDetection.pollForReplies({ triggeredBy: 'cron' });
    } catch (e) {
      console.error('[reminderWorker] estimate followup reply-poll error:', e.message);
      replyPoll = { ok: false, error: e.message };
    }

    // Automatic post-appointment QuickBooks estimate sync — one schedule
    // row per eligible real appointment, 3h after it ends then 24h/48h/72h
    // then daily through day 7 (see lib/postAppointmentEstimateSync.js's
    // header). Runs BEFORE the global auto-enrollment scan below so a
    // lead whose estimate this tick just synced with confirmed delivery
    // evidence is enrolled immediately via this module's own direct
    // enroll() call, rather than waiting for the next tick's broader scan
    // to notice it — though that scan would catch it either way (enroll()
    // is idempotent via the competing-sequence check).
    let postAppointmentSync = null;
    try {
      postAppointmentSync = await postAppointmentEstimateSync.processPostAppointmentEstimateSyncs({ triggeredBy: 'cron' });
    } catch (e) {
      console.error('[reminderWorker] post-appointment estimate sync error:', e.message);
      postAppointmentSync = { ok: false, error: e.message };
    }

    let autoEnrollment = null;
    try {
      autoEnrollment = await estimateFollowupEngine.runAutoEnrollmentScan({ triggeredBy: 'cron' });
    } catch (e) {
      console.error('[reminderWorker] estimate followup auto-enrollment error:', e.message);
      autoEnrollment = { ok: false, error: e.message };
    }

    let estimateFollowup = null;
    try {
      estimateFollowup = await estimateFollowupEngine.processEstimateFollowups({ triggeredBy: 'cron' });
    } catch (e) {
      console.error('[reminderWorker] estimate followup error:', e.message);
      estimateFollowup = { ok: false, error: e.message };
    }

    console.log('[reminderWorker] done:', JSON.stringify({ appointment: apt, phone, task, replyPoll, postAppointmentSync, autoEnrollment, estimateFollowup }));

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