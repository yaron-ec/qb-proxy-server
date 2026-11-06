/* eslint-disable no-undef */
/**
 * alertDispatcher — unified alert dispatch for the production monitoring layer.
 *
 * INDEPENDENCE: The alert path does NOT depend on the service being monitored.
 * It uses Railway-native structured logs (always active) + Slack webhook (if
 * configured) + email via a separate emailService call (if the email service is
 * healthy). If qb-proxy-server itself is down, the watchdog still logs and
 * can still send Slack/email via its own process.
 *
 * ALERT PAYLOAD (per spec):
 *   SERVICE, ENVIRONMENT, FAILURE TIME, CURRENT COMMIT, CURRENT DEPLOYMENT,
 *   LAST KNOWN GOOD COMMIT, HTTP STATUS, ERROR SUMMARY, CRASH LOOP,
 *   LAST 50 RELEVANT LOG LINES, AUTO-RECOVERY ATTEMPTED, AUTO-RECOVERY RESULT,
 *   OPERATOR ACTION REQUIRED
 *
 * SECRETS ARE NEVER INCLUDED in any alert payload.
 */
'use strict';

const { getService } = require('./serviceInventory');
// Lazy require — avoids loading db/client (pg) at module level so sanitize()
// and other pure functions remain usable in test/CI without a database.
let _getBaseline;
async function getBaseline(serviceId) {
  if (!_getBaseline) _getBaseline = require('./knownGoodBaseline').getBaseline;
  return _getBaseline(serviceId);
}

function sanitize(text) {
  if (!text) return '';
  return String(text)
    .replace(/Bearer\s+[\w-]+/gi, 'Bearer [REDACTED]')
    .replace(/password["\s:=]+\S+/gi, 'password=[REDACTED]')
    .replace(/DATABASE_URL=\S+/gi, 'DATABASE_URL=[REDACTED]')
    .replace(/token["\s:=]+\S+/gi, 'token=[REDACTED]')
    .replace(/secret["\s:=]+\S+/gi, 'secret=[REDACTED]')
    .slice(0, 2000);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pure (no DB) — the already-sanitized `payload` rendered as a plain HTML
// table for emailService.send()'s required htmlBody.
function alertHtmlBody(payload) {
  const rows = Object.entries(payload)
    .map(([k, v]) => `<tr><td style="padding:2px 8px;font-weight:bold;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:2px 8px;white-space:pre-wrap;">${escapeHtml(v)}</td></tr>`)
    .join('\n');
  return `<table>${rows}</table>`;
}

async function buildAlertPayload({ serviceId, level, errorSummary, errorType, httpStatus, isCrashLoop, recoveryAction, recoveryResult, logLines }) {
  const svc = getService(serviceId);
  const baseline = await getBaseline(serviceId);
  return {
    event: 'PRODUCTION_MONITORING_ALERT',
    level: level || 'critical',
    SERVICE: svc?.name || serviceId,
    ENVIRONMENT: svc?.environment || 'production',
    SERVICE_ID: serviceId,
    FAILURE_TIME: new Date().toISOString(),
    CURRENT_COMMIT: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    CURRENT_DEPLOYMENT: process.env.RAILWAY_DEPLOYMENT_ID || 'unknown',
    LAST_KNOWN_GOOD_COMMIT: baseline?.commit_sha || 'none',
    HTTP_STATUS: httpStatus || 'N/A',
    ERROR_SUMMARY: sanitize(errorSummary),
    ERROR_TYPE: errorType || 'unknown',
    CRASH_LOOP: isCrashLoop ? 'YES' : 'NO',
    LAST_LOG_LINES: sanitize((logLines || []).join('\n').slice(-2000)),
    AUTO_RECOVERY_ATTEMPTED: recoveryAction || 'none',
    AUTO_RECOVERY_RESULT: recoveryResult || 'N/A',
    OPERATOR_ACTION_REQUIRED: isCrashLoop ? 'YES — investigate crash loop, do not blind-restart' : 'YES — investigate failure',
  };
}

async function dispatchMonitoringAlert(opts) {
  const payload = await buildAlertPayload(opts);

  // 1. Railway-native structured log (always — independent of any external service)
  console.error(JSON.stringify(payload));

  // 2. Slack webhook (if configured — independent of qb-proxy-server)
  const slackUrl = process.env.ALERT_SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      const fields = [
        { title: 'Service', value: payload.SERVICE, short: true },
        { title: 'Environment', value: payload.ENVIRONMENT, short: true },
        { title: 'Crash Loop', value: payload.CRASH_LOOP, short: true },
        { title: 'HTTP Status', value: String(payload.HTTP_STATUS), short: true },
        { title: 'Error', value: payload.ERROR_SUMMARY.slice(0, 500), short: false },
        { title: 'Operator Action', value: payload.OPERATOR_ACTION_REQUIRED, short: false },
      ];
      await fetch(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `[EC CRM Monitor] ${payload.level.toUpperCase()} — ${payload.SERVICE_ID}`, attachments: [{ color: payload.level === 'critical' ? 'danger' : 'warning', fields }] }),
      });
    } catch (e) {
      console.error(`[monitor-alerts] Slack delivery failed: ${e.message}`);
    }
  } else {
    console.error('[monitor-alerts] ALERT NOT DELIVERED to Slack — no ALERT_SLACK_WEBHOOK_URL. Relying on Railway-native logs only.');
  }

  // 3. Email via emailService (if available and independent of the failing
  //    service) — Railway's own Gmail-backed sender, not the qb-proxy-server
  //    process, so it survives API outages. Two independent recipients:
  //    (a) an optional single static address for critical alerts only
  //    (MONITOR_ALERT_EMAIL_TO — e.g. an on-call pager/distribution address
  //    outside the normal staff roster), and (b) the SAME staff-broadcast
  //    mechanism every other CRM-generated email already uses
  //    (notificationRecipients.getAllStaffRecipients() narrowed by
  //    notificationPreferences.filterRecipientsForCategory(...,
  //    CATEGORIES.SYSTEM_FAILURE) — so Michelle's single-category policy
  //    correctly excludes her the same way it excludes her from every other
  //    staff broadcast, with zero person-specific logic here). (b) fires for
  //    every level (warning/critical/info) so a real recovery notification
  //    (level: 'info', dispatched by handleSuccess above) actually reaches a
  //    human inbox, not just Railway's own logs. This is purely additive —
  //    it never replaces or gates on (a), and a failure in either path never
  //    blocks the other or the Slack/log channels above.
  //
  //    IMPORTANT (production bug, fixed in the same pass this comment was
  //    added): this call previously invoked a method that has never existed
  //    on lib/emailService.js's export — `emailService.sendEmail({ to,
  //    subject, body })` — the real, only export is `send({ to, subject,
  //    htmlBody, idempotencyKey })`. Every call therefore threw
  //    "emailService.sendEmail is not a function", caught by this try/catch
  //    and logged as a non-fatal delivery failure — so even an operator who
  //    DID set MONITOR_ALERT_EMAIL_TO was never actually emailed. Fixed to
  //    call the real `send()` with the fields it actually requires.
  if (payload.level === 'critical' && process.env.MONITOR_ALERT_EMAIL_TO) {
    try {
      const emailService = require('../emailService');
      await emailService.send({
        to: process.env.MONITOR_ALERT_EMAIL_TO,
        subject: `[EC CRM Monitor] CRITICAL — ${payload.SERVICE} ${payload.CRASH_LOOP === 'YES' ? 'CRASH LOOP' : 'FAILURE'}`,
        htmlBody: alertHtmlBody(payload),
        idempotencyKey: `monitoring-alert-operator:${payload.SERVICE_ID}:${payload.FAILURE_TIME}`,
      });
    } catch (e) {
      console.error(`[monitor-alerts] Email delivery failed (non-fatal): ${e.message}`);
    }
  }

  try {
    const notificationRecipients = require('../notificationRecipients');
    const notificationPreferences = require('../notificationPreferences');
    const staff = await notificationRecipients.getAllStaffRecipients();
    const recipients = await notificationPreferences.filterRecipientsForCategory(staff, notificationPreferences.CATEGORIES.SYSTEM_FAILURE);
    if (recipients.length > 0) {
      const emailService = require('../emailService');
      const levelLabel = payload.level === 'critical' ? 'CRITICAL' : payload.level === 'info' ? 'RECOVERED' : 'WARNING';
      await emailService.send({
        to: recipients,
        subject: `[EC CRM Monitor] ${levelLabel} — ${payload.SERVICE}${payload.CRASH_LOOP === 'YES' ? ' CRASH LOOP' : ''}`,
        htmlBody: alertHtmlBody(payload),
        idempotencyKey: `monitoring-alert-staff:${payload.SERVICE_ID}:${payload.FAILURE_TIME}`,
      });
    }
  } catch (e) {
    console.error(`[monitor-alerts] Staff email delivery failed (non-fatal): ${e.message}`);
  }

  // 4. [REMOVED] Base44 SendEmail channel — Railway email (step 3) is now the
  //    sole email delivery path. The Base44 backend function sendMonitoringAlertEmail
  //    is no longer invoked; lib/base44.js is no longer imported by this module.

  return payload;
}

module.exports = { dispatchMonitoringAlert, sanitize };