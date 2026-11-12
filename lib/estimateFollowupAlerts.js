/* eslint-disable no-undef */
/**
 * estimateFollowupAlerts — surfaces a processEstimateFollowups() tick that
 * had real send failures, or was blocked entirely by missing configuration
 * (e.g. no business mailing address configured for the CAN-SPAM compliance
 * footer — lib/estimateFollowupTemplates.js#ConfigurationError), to
 * administrators. Reuses the EXISTING staff SYSTEM_FAILURE broadcast
 * category (lib/notificationPreferences.js) — the exact same mechanism
 * lib/monitoring/alertDispatcher.js already uses for watchdog alerts — so
 * Michelle's single-category policy correctly excludes her with zero
 * person-specific logic here, and no new notification mechanism is
 * introduced. Never fires for an ordinary tick with zero failures and
 * nothing config-blocked: "no noise for ordinary non-eligible leads" per
 * the explicit requirement. Best-effort: a failure in this module must
 * never throw back into the caller's tick.
 */
'use strict';

const notificationRecipients = require('./notificationRecipients');
const notificationPreferences = require('./notificationPreferences');
const emailService = require('./emailService');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function summaryHtml(summary) {
  const rows = [
    ['Processed', summary.processed ?? 'n/a'],
    ['Sent', summary.sent ?? 0],
    ['Skipped', summary.skipped ?? 0],
    ['Failed', summary.failed ?? 0],
    ['Config blocked', summary.configBlocked ? 'YES' : 'NO'],
  ];
  if (summary.configBlockedReason) rows.push(['Config blocked reason', summary.configBlockedReason]);
  if (Array.isArray(summary.errors) && summary.errors.length) {
    rows.push(['Recent errors', summary.errors.slice(0, 20).map((e) => String(e)).join('\n')]);
  }
  const body = rows
    .map(([k, v]) => `<tr><td style="padding:2px 8px;font-weight:bold;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:2px 8px;white-space:pre-wrap;">${escapeHtml(v)}</td></tr>`)
    .join('\n');
  return `<table>${body}</table>`;
}

/**
 * @param {object} summary - the return value of processEstimateFollowups():
 *   { processed, sent, skipped, failed, configBlocked, configBlockedReason, errors[] }
 * @returns {Promise<{sent:boolean, reason?:string, recipients?:number, error?:string}>}
 */
async function notifyAutomationFailures(summary) {
  if (!summary || (!summary.failed && !summary.configBlocked)) {
    return { sent: false, reason: 'nothing_to_report' };
  }
  try {
    const staff = await notificationRecipients.getAllStaffRecipients();
    const recipients = await notificationPreferences.filterRecipientsForCategory(
      staff,
      notificationPreferences.CATEGORIES.SYSTEM_FAILURE
    );
    if (!recipients.length) return { sent: false, reason: 'no_recipients' };

    const levelLabel = summary.configBlocked ? 'BLOCKED' : 'FAILURES';
    const subject = `[EC CRM] Estimate Follow-Up Automation ${levelLabel} — ${summary.failed || 0} failed`;
    // Minute-granularity idempotency key: dedupes retries/overlapping callers
    // within the same minute without ever suppressing a genuinely new tick's
    // alert (the engine's own tick cadence is measured in minutes).
    const minuteKey = new Date().toISOString().slice(0, 16);
    await emailService.send({
      to: recipients,
      subject,
      htmlBody: summaryHtml(summary),
      idempotencyKey: `estimate-followup-alert:${minuteKey}`,
    });
    return { sent: true, recipients: recipients.length };
  } catch (e) {
    console.error(`[estimate-followup-alerts] notifyAutomationFailures failed (non-fatal): ${e.message}`);
    return { sent: false, reason: 'send_failed', error: e.message };
  }
}

module.exports = { notifyAutomationFailures };
