/* eslint-disable no-undef */
/**
 * reminder_runs singleton health-state store (Railway Postgres).
 * Survives restarts; read by /reminders/health and by the watchdog.
 *
 * State model:
 *   gmail_credentials_lock  — when TRUE, ALL sending is blocked until
 *                             clearGmailCredentialsLock() is called (manual
 *                             recovery after fixing the refresh token).
 *   consecutive_failures   — any failed scheduled run.
 *   gmail_consecutive_failures — credential-only failures (alert on first).
 */
'use strict';

const db = require('../db/client');

async function getHealth() {
  const { rows } = await db.query('SELECT * FROM reminder_runs WHERE id = 1');
  return rows[0] || {};
}

async function isGmailLocked() {
  const { rows } = await db.query('SELECT gmail_credentials_lock FROM reminder_runs WHERE id = 1');
  return !!(rows[0] && rows[0].gmail_credentials_lock);
}

async function recordRunStart() {
  await db.query(`UPDATE reminder_runs SET last_run_at = NOW(), last_run_status = 'running' WHERE id = 1`);
}

async function recordRunSuccess(stats, durationMs) {
  await db.query(`
    UPDATE reminder_runs SET
      last_run_status = 'success',
      last_run_duration_ms = $2,
      consecutive_failures = 0,
      last_run_error = NULL,
      last_run_error_type = NULL,
      appointments_scanned = $3,
      reminders_sent = $4,
      reminders_skipped = $5,
      last_successful_run_at = NOW()
    WHERE id = 1`, [1, durationMs, stats.scanned, stats.sent, stats.skipped]);
}

async function recordDryRun(stats, durationMs, gmailOk) {
  await db.query(`
    UPDATE reminder_runs SET
      last_run_status = 'dry_run',
      last_run_duration_ms = $2,
      appointments_scanned = $3,
      reminders_sent = 0,
      reminders_skipped = $4,
      consecutive_failures = 0,
      gmail_status = $5
    WHERE id = 1`, [1, durationMs, stats.scanned, stats.skipped, gmailOk ? 'ok' : 'credentials_invalid']);
}

async function recordRunFailure(err, errorType, durationMs) {
  await db.query(`
    UPDATE reminder_runs SET
      last_run_status = 'failed',
      last_run_duration_ms = $2,
      last_run_error = $3,
      last_run_error_type = $4,
      consecutive_failures = consecutive_failures + 1
    WHERE id = 1`, [1, durationMs, (err && err.message) || String(err), errorType]);
}

async function recordRunSkipped(reason) {
  await db.query(`
    UPDATE reminder_runs SET
      last_run_status = 'skipped',
      last_run_error = $2,
      last_run_duration_ms = 0
    WHERE id = 1`, [1, reason]);
}

async function recordGmailOk() {
  await db.query(`UPDATE reminder_runs SET gmail_status = 'ok', gmail_last_error = NULL WHERE id = 1`);
}

async function recordGmailCredentialsInvalid(errorMessage) {
  await db.query(`
    UPDATE reminder_runs SET
      gmail_status = 'credentials_invalid',
      gmail_last_error = $2,
      gmail_consecutive_failures = gmail_consecutive_failures + 1,
      gmail_credentials_lock = TRUE
    WHERE id = 1`, [1, errorMessage]);
}

async function clearGmailCredentialsLock() {
  await db.query(`
    UPDATE reminder_runs SET
      gmail_status = 'ok',
      gmail_last_error = NULL,
      gmail_consecutive_failures = 0,
      gmail_credentials_lock = FALSE
    WHERE id = 1`);
}

async function recordReminderSent(leadId, windowKey) {
  await db.query(`
    UPDATE reminder_runs SET
      last_reminder_sent_at = NOW(),
      last_reminder_lead_id = $2,
      last_reminder_window = $3
    WHERE id = 1`, [1, leadId, windowKey]);
}

module.exports = {
  getHealth,
  isGmailLocked,
  recordRunStart,
  recordRunSuccess,
  recordDryRun,
  recordRunFailure,
  recordRunSkipped,
  recordGmailOk,
  recordGmailCredentialsInvalid,
  clearGmailCredentialsLock,
  recordReminderSent,
};