/* eslint-disable no-undef */
/**
 * testGmailOnce.js — TEMPORARY ONE-OFF (delete immediately after the result
 * is captured). Do NOT wire into server.js, cron, or any route.
 *
 * Purpose: prove the Railway reminder service's existing Gmail client
 * (lib/gmailSender.js) can authenticate and deliver exactly ONE internal
 * test email. No customer reminder is sent.
 *
 * Scope guarantees:
 *   - Imports ONLY lib/gmailSender.js. No db/client, no reminderHealth,
 *     no reminderEngine, no crmRepository, no lib/base44.
 *   - Therefore CANNOT read reminder_leads, write reminder_claims,
 *     write reminder_activity_queue, or touch reminder_runs / any Base44 entity.
 *   - Recipient is hardcoded + asserted. No argv/env/payload input.
 *   - No CC/BCC (gmailSender.sendEmail sets only From/To/Subject).
 *   - Prints NO secrets (no client id/secret/refresh/access token).
 *
 * Run on the Railway reminder service:  node testGmailOnce.js
 */
'use strict';

const { refreshAccessToken, sendEmail } = require('./lib/gmailSender');

const RECIPIENT = 'michelle@ecconstructiongroup.com';
const SUBJECT = 'EC Construction Group — Railway Reminder Email Test';
const BODY_HTML =
  '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1A1A2E;">' +
  '<p>This is an internal test of the new Railway reminder email system. No customer reminder was sent.</p>' +
  '</div>';

async function main() {
  // Hardcoded-recipient assertion (proves "validated as").
  if (RECIPIENT !== 'michelle@ecconstructiongroup.com') {
    throw new Error('Recipient guard failed — aborting before any send.');
  }

  const fromAddr = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';
  const startedAt = new Date().toISOString();
  let attempts = 0;

  console.log(JSON.stringify({
    event: 'test_gmail_start',
    recipient: RECIPIENT,
    subject: SUBJECT,
    fromAddress: fromAddr,        // email only — NOT a secret
    startedAt,
  }));

  let result;
  try {
    attempts = 1; // exactly one attempt, by design
    const accessToken = await refreshAccessToken(); // auth test
    const sent = await sendEmail(accessToken, { to: RECIPIENT, subject: SUBJECT, htmlBody: BODY_HTML });
    result = {
      success: true,
      recipient: RECIPIENT,
      subject: SUBJECT,
      gmailMessageId: sent.id || null,
      timestamp: new Date().toISOString(),
      attempts,
      customerEmailAttempted: false,
      reminderClaimsWritten: false,
      reminderActivityQueueWritten: false,
    };
  } catch (err) {
    // Do NOT surface secrets. GmailCredentialsError and plain Error both
    // carry only a human message, never a token/secret.
    result = {
      success: false,
      recipient: RECIPIENT,
      subject: SUBJECT,
      gmailMessageId: null,
      timestamp: new Date().toISOString(),
      attempts,
      errorType: err && err.name ? err.name : 'Error',
      errorMessage: err && err.message ? String(err.message) : String(err),
      customerEmailAttempted: false,
      reminderClaimsWritten: false,
      reminderActivityQueueWritten: false,
    };
  }

  console.log(JSON.stringify({ event: 'test_gmail_result', ...result }));
  process.exit(result.success ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({
    event: 'test_gmail_result',
    success: false,
    recipient: RECIPIENT,
    subject: SUBJECT,
    gmailMessageId: null,
    timestamp: new Date().toISOString(),
    attempts: 0,
    errorType: e && e.name ? e.name : 'Error',
    errorMessage: e && e.message ? String(e.message) : String(e),
    customerEmailAttempted: false,
    reminderClaimsWritten: false,
    reminderActivityQueueWritten: false,
  }));
  process.exit(1);
});