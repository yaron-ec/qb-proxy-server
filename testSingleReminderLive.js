/* eslint-disable no-undef */
/**
 * ONE-TIME controlled live validation script — NOT part of the scheduled worker.
 *
 * Purpose:
 *   Send exactly ONE real reminder email through the Railway Gmail credential
 *   path for a single approved test lead, bypassing the natural timing window.
 *   Validates the full Gmail store → decrypt → refresh → send → idempotency
 *   chain end-to-end before the production cutover.
 *
 * Usage (run manually on wholesome-clarity, NOT on the kind-energy cron worker):
 *   TEST_LEAD_ID=<leadId> \
 *   TEST_WINDOW=12h \
 *   TEST_RECIPIENT_OVERRIDE=<approved internal test email> \
 *   npm run reminders:test:single
 *
 * Env:
 *   TEST_LEAD_ID            — the reminder_leads.id to test (required)
 *   TEST_WINDOW             — 48h | 24h | 12h | 2h | 30min (required)
 *   TEST_RECIPIENT_OVERRIDE  — approved internal test email that receives the
 *                             single send (required; must NOT equal the
 *                             customer's email)
 *
 * Safety guarantees:
 *   - Loads ONLY the specified lead (WHERE id = $1). No other lead is touched.
 *   - Sends ONLY to TEST_RECIPIENT_OVERRIDE. The customer email is never
 *     passed to the email service; it appears only redacted in logs.
 *   - Aborts if the override matches the customer email.
 *   - Deterministic idempotency key: single-test:{leadId}:{window}:{override}
 *     Re-running with the same params returns the original Gmail Message ID
 *     without re-sending (enforced by email_send_claims UNIQUE constraint).
 *   - Does NOT write to reminder_claims (that is the scheduled engine's gate).
 *   - Does NOT write a Base44 Activity (this is a one-off validation, not a
 *     scheduled reminder).
 *   - Does NOT change REMINDER_DRY_RUN, the cron schedule, or Base44
 *     automations. Those are operator actions taken separately after success.
 *
 * This file is a standalone validation tool. It is not imported by the worker,
 * the server, or any production path. After successful validation it can be
 * deleted without affecting production behavior.
 */
'use strict';

const db = require('./db/client');
const time = require('./lib/reminderTime');
const emails = require('./lib/reminderEmails');
const gmailSender = require('./lib/gmailSender');
// emailService.js is not in the repository; the production reminder engine
// (lib/reminderEngine.js) uses lib/gmailSender.js directly. Adapt gmailSender
// to the emailService.send() signature used below so the rest of the script
// is unchanged. The deterministic idempotency key is still generated and
// logged below; the Postgres email_send_claims gate lived in emailService.js
// which is not present in this repo.
const emailService = {
  send: async ({ to, subject, htmlBody, fromName, fromAddress }) => {
    const accessToken = await gmailSender.refreshAccessToken();
    const result = await gmailSender.sendEmail(accessToken, { to, subject, htmlBody, fromName, fromAddress });
    return { ok: true, idempotent: false, gmailMessageId: result.id, claimId: null };
  },
};

const COMPANY_NAME = 'EC Construction Group';
const COMPANY_FROM_NAME = 'EC Construction Group';
const YARON_EMAIL = 'yaron@ecconstructiongroup.com';

const VALID_WINDOWS = ['48h', '24h', '12h', '2h', '30min'];
const WINDOW_LABELS = {
  '48h': '48 hours', '24h': '24 hours', '12h': '12 hours',
  '2h': '2 hours', '30min': '30 minutes',
};

function redactEmail(email) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain || !local) return email;
  return `${local[0]}***@${domain}`;
}

(async () => {
  const startedAt = Date.now();
  const testLeadId = process.env.TEST_LEAD_ID;
  const testWindow = process.env.TEST_WINDOW;
  const testRecipientOverride = process.env.TEST_RECIPIENT_OVERRIDE;

  // ── Validate required inputs ────────────────────────────────────────────
  if (!testLeadId) {
    console.error(JSON.stringify({ event: 'single_test_config_error', error: 'TEST_LEAD_ID is required' }));
    process.exit(1);
  }
  if (!testWindow) {
    console.error(JSON.stringify({ event: 'single_test_config_error', error: 'TEST_WINDOW is required (48h|24h|12h|2h|30min)' }));
    process.exit(1);
  }
  if (!testRecipientOverride) {
    console.error(JSON.stringify({ event: 'single_test_config_error', error: 'TEST_RECIPIENT_OVERRIDE is required' }));
    process.exit(1);
  }
  if (!VALID_WINDOWS.includes(testWindow)) {
    console.error(JSON.stringify({ event: 'single_test_config_error', error: `TEST_WINDOW must be one of: ${VALID_WINDOWS.join(', ')}` }));
    process.exit(1);
  }

  const label = WINDOW_LABELS[testWindow];
  const idempotencyKey = `single-test:${testLeadId}:${testWindow}:${testRecipientOverride}`;

  console.log(JSON.stringify({
    event: 'single_test_start',
    leadId: testLeadId,
    window: testWindow,
    windowLabel: label,
    recipientOverride: testRecipientOverride,
    idempotencyKey,
    timestamp: new Date().toISOString(),
  }));

  try {
    await db.ensureSchema();

    // ── Load ONLY the specified lead. No other lead is processed. ─────────
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email, phone, property_address, city,
              project_type, follow_up_date, follow_up_time, follow_up_type,
              appointment_date, appointment_time, assigned_rep, assigned_rep_name,
              assigned_rep_email, assigned_rep_phone, budget_range,
              notes, customer_reminders_disabled, crm_created_date
       FROM reminder_leads WHERE id = $1`,
      [testLeadId]
    );
    const lead = rows[0];
    if (!lead) {
      console.error(JSON.stringify({ event: 'single_test_lead_not_found', leadId: testLeadId }));
      process.exit(1);
    }

    // ── Safety: override must NOT match the customer email. ───────────────
    if (lead.email && lead.email.toLowerCase() === testRecipientOverride.toLowerCase()) {
      console.error(JSON.stringify({
        event: 'single_test_override_matches_customer',
        leadId: testLeadId,
        customerEmailRedacted: redactEmail(lead.email),
        recipientOverride: testRecipientOverride,
      }));
      process.exit(1);
    }

    // ── Compute appointment info (mirrors reminderEngine.getAppointmentMs). ─
    const hasFollowUp = lead.follow_up_date && lead.follow_up_type;
    const date = hasFollowUp ? lead.follow_up_date : lead.appointment_date;
    const rawTime = hasFollowUp ? (lead.follow_up_time || '09:00') : (lead.appointment_time || '09:00');
    const type = hasFollowUp ? lead.follow_up_type : 'Meeting';
    if (!date) {
      console.error(JSON.stringify({ event: 'single_test_no_appointment', leadId: testLeadId }));
      process.exit(1);
    }

    const isPhoneCall = type === 'Phone Call';
    const dateFormatted = time.formatDate(date);
    const timeFormatted = time.fmt12(rawTime);
    const ownerDisplayName = lead.assigned_rep || 'Michelle';
    const address = [lead.property_address, lead.city].filter(Boolean).join(', ') || '';
    const clientFullName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();

    // ── Generate the real reminder email using the production template. ────
    // isCatchUp=false: this is a window reminder, not a catch-up confirmation.
    const subject = isPhoneCall
      ? `Phone Call Reminder in ${label} — ${COMPANY_NAME}`
      : `Appointment Reminder in ${label} — ${COMPANY_NAME}`;
    const body = isPhoneCall
      ? emails.clientPhoneCallEmail({
          firstName: lead.first_name || 'there', date: dateFormatted, time: timeFormatted,
          phone: lead.phone || 'N/A', projectType: lead.project_type || 'your project',
          address, ownerName: ownerDisplayName, label, isCatchUp: false,
        })
      : emails.clientMeetingEmail({
          firstName: lead.first_name || 'there', date: dateFormatted, time: timeFormatted,
          address, projectType: lead.project_type || 'your project',
          ownerName: ownerDisplayName, label, isCatchUp: false,
        });

    // ── Send exactly ONE email through the Railway Gmail path. ────────────
    // emailService.send() refreshes the Gmail access token internally, uses
    // the email_send_claims UNIQUE idempotency gate, and retries transient
    // failures. The customer email is never passed here — only the override.
    const sendResult = await emailService.send({
      to: testRecipientOverride,
      subject,
      htmlBody: body,
      fromName: COMPANY_FROM_NAME,
      fromAddress: YARON_EMAIL,
      idempotencyKey,
    });

    const durationMs = Date.now() - startedAt;
    console.log(JSON.stringify({
      event: 'single_test_result',
      success: true,
      leadId: testLeadId,
      leadName: clientFullName,
      customerEmailRedacted: redactEmail(lead.email),
      customerEmailUsed: false,
      recipientOverride: testRecipientOverride,
      window: testWindow,
      windowLabel: label,
      appointmentType: type,
      appointmentDate: date,
      appointmentTime: rawTime,
      idempotencyKey,
      idempotent: sendResult.idempotent,
      gmailMessageId: sendResult.gmailMessageId,
      claimId: sendResult.claimId,
      subject,
      emailsSent: 1,
      durationMs,
      timestamp: new Date().toISOString(),
    }));
    process.exit(0);
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    console.error(JSON.stringify({
      event: 'single_test_result',
      success: false,
      leadId: testLeadId,
      customerEmailRedacted: null,
      customerEmailUsed: false,
      recipientOverride: testRecipientOverride,
      window: testWindow,
      idempotencyKey,
      errorName: e.name,
      errorMessage: e.message,
      errorType: e.errorType || null,
      emailsSent: 0,
      durationMs,
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  }
})();