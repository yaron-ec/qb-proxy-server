/* eslint-disable no-undef */
/**
 * Reminder watchdog — standalone entrypoint for a SEPARATE Railway Cron
 * job (every 10 min) on a dedicated single-replica service
 * (`ec-crm-reminder-watchdog`). It is a different failure domain from the
 * reminder worker: if the worker is dead/stuck, the watchdog still runs and
 * alerts.
 *
 * Reads the Railway-owned reminder_runs health row directly (no HTTP, no
 * Gmail) and dispatches alerts via the independent channel (Slack/Twilio if
 * configured, else Railway-native log only).
 *
 *   node reminderWatchdog.js
 */
'use strict';

const health = require('./lib/reminderHealth');
const alerts = require('./lib/reminderAlerts');

(async () => {
  try {
    const h = await health.getHealth();
    const now = Date.now();
    const staleMs = 70 * 60 * 1000; // 2x cron interval + buffer

    const lastSuccessMs = h.last_successful_run_at ? new Date(h.last_successful_run_at).getTime() : 0;
    if (!lastSuccessMs || (now - lastSuccessMs) > staleMs) {
      await alerts.dispatchAlert({
        level: 'critical',
        type: 'heartbeat_stale',
        message: 'No successful reminder run within 70 minutes. Reminder cron may be stopped or the worker crashed.',
        context: { last_successful_run_at: h.last_successful_run_at, last_run_status: h.last_run_status, consecutive_failures: h.consecutive_failures },
      });
    }

    if (h.gmail_status === 'credentials_invalid') {
      await alerts.dispatchAlert({
        level: 'critical',
        type: 'gmail_credentials_invalid',
        message: 'Gmail refresh token is invalid/revoked. All reminder sending is blocked until the lock is cleared.',
        context: { gmail_last_error: h.gmail_last_error, gmail_consecutive_failures: h.gmail_consecutive_failures },
      });
    }

    if ((h.consecutive_failures || 0) >= 3) {
      await alerts.dispatchAlert({
        level: 'warning',
        type: 'repeated_run_failures',
        message: `${h.consecutive_failures} consecutive reminder run failures.`,
        context: { last_run_error: h.last_run_error, last_run_error_type: h.last_run_error_type },
      });
    }

    process.exit(0);
  } catch (e) {
    console.error('[reminderWatchdog] fatal:', e);
    process.exit(1);
  }
})();