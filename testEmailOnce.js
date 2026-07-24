/* eslint-disable no-undef */
/**
 * testEmailOnce.js — Phase 1 internal test harness (T10).
 *
 * Sends EXACTLY ONE internal test email through EmailService to verify the
 * Railway Email Service end-to-end. No customer email. No cron. No batch.
 * No automatic retry (EmailService's own bounded retry still applies, but the
 * idempotency key guarantees a single delivered message).
 *
 * DO NOT RUN until explicitly approved. When approved, run on the Railway
 * service:  node testEmailOnce.js
 *
 * Guards:
 *   - Recipient is hardcoded + asserted (internal only: michelle@).
 *   - From yaron@ecconstructiongroup.com (via EmailService default).
 *   - CC yaron@ecconstructiongroup.com.
 *   - Explicit idempotency key (idempotent across re-runs).
 *   - Prints NO secrets (no tokens/credentials).
 */
'use strict';

const emailService = require('./lib/emailService');

const RECIPIENT = 'michelle@ecconstructiongroup.com';
const CC = ['yaron@ecconstructiongroup.com'];
const SUBJECT = 'Railway Email Service — Internal Test (Phase 1)';
const ID_KEY = 'phase1-internal-test-once-2026-07-24';
const BODY_HTML =
  '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1A1A2E;line-height:1.6;">' +
  '<p>This is an internal test of the Railway Email Service (Phase 1).</p>' +
  '<p><strong>From:</strong> yaron@ecconstructiongroup.com</p>' +
  '<p><strong>CC:</strong> yaron@ecconstructiongroup.com</p>' +
  '<p>No customer email was sent. No reminder batch ran. This is a single isolated message with an explicit idempotency key.</p>' +
  '</div>';

async function main() {
  // Hardcoded-recipient assertion (defense in depth).
  if (RECIPIENT !== 'michelle@ecconstructiongroup.com') {
    throw new Error('Recipient guard failed — aborting before any send.');
  }
  console.log(JSON.stringify({
    event: 'test_email_start',
    recipient: RECIPIENT,
    cc: CC,
    subject: SUBJECT,
    idempotencyKey: ID_KEY,
    startedAt: new Date().toISOString(),
  }));

  let result;
  try {
    result = await emailService.send({
      to: RECIPIENT,
      cc: CC,
      subject: SUBJECT,
      htmlBody: BODY_HTML,
      idempotencyKey: ID_KEY,
      role: 'test',
    });
  } catch (e) {
    console.log(JSON.stringify({
      event: 'test_email_result',
      success: false,
      recipient: RECIPIENT,
      errorType: e && e.name ? e.name : 'Error',
      errorMessage: e && e.message ? String(e.message) : String(e),
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    event: 'test_email_result',
    success: true,
    recipient: RECIPIENT,
    gmailMessageId: result.gmailMessageId || null,
    idempotent: !!result.idempotent,
    claimId: result.claimId || null,
    timestamp: new Date().toISOString(),
  }));
  process.exit(0);
}

main().catch((e) => {
  console.log(JSON.stringify({
    event: 'test_email_result',
    success: false,
    recipient: RECIPIENT,
    errorType: e && e.name ? e.name : 'Error',
    errorMessage: e && e.message ? String(e.message) : String(e),
    timestamp: new Date().toISOString(),
  }));
  process.exit(1);
});