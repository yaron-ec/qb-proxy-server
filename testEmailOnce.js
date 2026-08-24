/* eslint-disable no-undef */
/**
 * testEmailOnce.js — Phase 1 isolated internal test for the Railway Gmail
 * migration.
 *
 * Sends EXACTLY ONE internal test email through EmailService.send() to prove
 * the Railway Gmail API integration works end-to-end. No customer email.
 * No cron. No batch. No automatic retry beyond EmailService's own bounded
 * retry (the idempotency key guarantees a single delivered message).
 *
 * DO NOT RUN until explicitly approved. When approved, run on the Railway
 * service:  npm run email:test:phase1
 *
 * Guards:
 *   - Recipient is hardcoded + asserted (internal only: michelle@).
 *   - CC is hardcoded (yaron@).
 *   - Uses the existing Railway default sender (GMAIL_FROM_ADDRESS env or
 *     yaron@ecconstructiongroup.com). Does NOT switch to office@.
 *   - Explicit fixed idempotency key (idempotent across re-runs).
 *   - Prints NO secrets (no tokens/credentials).
 *
 * Output:
 *   PHASE1_EMAIL_TEST_SUCCESS
 *   to=...
 *   cc=...
 *   sender=...
 *   idempotencyKey=...
 *
 *   (or PHASE1_EMAIL_TEST_ALREADY_SENT / PHASE1_EMAIL_TEST_FAILED)
 */
'use strict';

const emailService = require('./lib/emailService');

const RECIPIENT = 'michelle@ecconstructiongroup.com';
const CC = ['yaron@ecconstructiongroup.com'];
const SUBJECT = 'Railway Gmail Migration Test — Phase 1';
const ID_KEY = 'railway-gmail-migration-phase1-internal-test-v1';
const BODY_HTML =
  '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1A1A2E;line-height:1.6;">' +
  '<p>This is an isolated Railway Gmail API migration test.</p>' +
  '<p>Expected sender: yaron@ecconstructiongroup.com</p>' +
  '<p>Expected recipient: michelle@ecconstructiongroup.com</p>' +
  '<p>Expected CC: yaron@ecconstructiongroup.com</p>' +
  '<p>No customer, lead, invoice, reminder, automation, or Base44 function was used.</p>' +
  '</div>';

async function main() {
  // Hardcoded-recipient assertion (defense in depth).
  if (RECIPIENT !== 'michelle@ecconstructiongroup.com') {
    throw new Error('Recipient guard failed — aborting before any send.');
  }

  // Resolve the sender the same way emailService.send() does (for logging only).
  const sender = emailService.defaultSender();

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
    console.log('PHASE1_EMAIL_TEST_FAILED');
    console.log(`errorType=${e && e.name ? e.name : 'Error'}`);
    console.log(`errorMessage=${e && e.message ? String(e.message).slice(0, 500) : String(e).slice(0, 500)}`);
    if (e && e.status) console.log(`httpStatus=${e.status}`);
    process.exit(1);
  }

  // emailService.send() returns:
  //   { ok: true, idempotent: true, ... }  → already sent by a prior run
  //   { ok: true, idempotent: false, ... } → sent this run
  //   { ok: false, ... }                  → already processing (no send)
  if (result && result.ok && result.idempotent) {
    console.log('PHASE1_EMAIL_TEST_ALREADY_SENT');
    console.log(`to=${RECIPIENT}`);
    console.log(`cc=${CC.join(',')}`);
    console.log(`sender=${sender}`);
    console.log(`idempotencyKey=${ID_KEY}`);
    process.exit(0);
  }

  if (result && result.ok && !result.idempotent) {
    console.log('PHASE1_EMAIL_TEST_SUCCESS');
    console.log(`to=${RECIPIENT}`);
    console.log(`cc=${CC.join(',')}`);
    console.log(`sender=${sender}`);
    console.log(`idempotencyKey=${ID_KEY}`);
    if (result.gmailMessageId) console.log(`gmailMessageId=${result.gmailMessageId}`);
    process.exit(0);
  }

  // ok: false — already processing or other non-fatal non-send
  console.log('PHASE1_EMAIL_TEST_FAILED');
  console.log(`errorType=NotSent`);
  console.log(`errorMessage=${result && result.error ? String(result.error).slice(0, 500) : 'email was not sent (already processing or unknown)'}`);
  process.exit(1);
}

main().catch((e) => {
  console.log('PHASE1_EMAIL_TEST_FAILED');
  console.log(`errorType=${e && e.name ? e.name : 'Error'}`);
  console.log(`errorMessage=${e && e.message ? String(e.message).slice(0, 500) : String(e).slice(0, 500)}`);
  process.exit(1);
});