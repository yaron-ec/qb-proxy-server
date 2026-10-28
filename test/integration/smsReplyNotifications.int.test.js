/* eslint-disable no-undef */
'use strict';

/**
 * smsReplyNotifications.int.test.js — REAL-Postgres, end-to-end proof of the
 * October 2026 "two-way appointment SMS" inbound-reply side effects:
 * rep EMAIL notification (real owner FK, never guessed), ambiguous-match
 * staff-review email routing, and duplicate-webhook-delivery idempotency —
 * all against the REAL routes/sms.js webhook + lib/smsReplyNotify.js, with
 * Twilio and Gmail both faked (no live network call). Skipped without
 * TEST_DATABASE_URL.
 *
 * November 2026 — the prior SMS-to-Yaron forward (forwardToYaronBestEffort/
 * SMS_REPLY_FORWARD_TO) has been RETIRED per a revised notification-design
 * decision: inbound replies now notify exclusively by email, never a second
 * outbound Twilio SMS. This file's Yaron-forward assertions were removed
 * along with the function itself.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'sms-test-jwt-secret-at-least-32-characters-long';
process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

const fakeTwilio = {
  sent: [],
  sendMessage: async ({ to, body }) => {
    fakeTwilio.sent.push({ to, body });
    return { ok: true, sid: `SM-fwd-${fakeTwilio.sent.length}`, status: 'queued', errorCode: null, errorMessage: null };
  },
  verifyTwilioSignature: () => true,
  missingConfig: () => [],
  getCredentials: () => ({ accountSid: 'ACtest', authToken: 'test', messagingServiceSid: null, from: '+15550001111' }),
  // October 2026 incident fix moved webhookBaseUrl()/webhookBaseUrlSource()
  // from routes/sms.js into lib/smsClient.js — this fake replaces the whole
  // module, so it must supply both or routes/sms.js's inbound handler
  // throws "webhookBaseUrl is not a function" before ever reaching
  // handleInboundMessage (silently swallowed as an empty-TwiML 200,
  // which is exactly why this broke two tests in this file with zero
  // obvious connection to the change).
  webhookBaseUrl: () => 'https://fake-backend.example.com',
  webhookBaseUrlSource: () => 'TWILIO_WEBHOOK_BASE_URL',
};

const fakeEmail = { sent: [] };

let db, ownerId, server, base, smsModuleState;
const RUN = `smsrn${Date.now().toString(36)}`;

test.before(async () => {
  if (skip) return;
  const smsClientPath = require.resolve(path.join(ROOT, 'lib/smsClient'));
  require.cache[smsClientPath] = { id: smsClientPath, filename: smsClientPath, loaded: true, exports: fakeTwilio };
  const emailServicePath = require.resolve(path.join(ROOT, 'lib/emailService'));
  require.cache[emailServicePath] = {
    id: emailServicePath, filename: emailServicePath, loaded: true,
    exports: { send: async (args) => { fakeEmail.sent.push(args); return { ok: true, gmailMessageId: `m${fakeEmail.sent.length}` }; } },
  };

  db = require(path.join(ROOT, 'db/client'));
  const { ensureGoogleModulesEnabled } = require('./ensureGoogleModulesEnabled');
  smsModuleState = await ensureGoogleModulesEnabled(db, ['sms']);
  require('../../lib/companyConfig').invalidate();

  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'SMS Reply Test Owner', true) ON CONFLICT DO NOTHING`, [`${RUN}.owner@ecconstructiongroup.com`]);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;

  const express = require('express');
  const app = express();
  app.use(express.json());
  const smsRoutes = require(path.join(ROOT, 'routes/sms'));
  app.use('/api/v1', smsRoutes.router);
  app.use('/api/v1/sms-webhook', smsRoutes.webhookRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  server.close();
  const { restoreGoogleModules } = require('./ensureGoogleModulesEnabled');
  await restoreGoogleModules(db, smsModuleState);
  require('../../lib/companyConfig').invalidate();
  delete process.env.SMS_REPLY_NOTIFICATIONS_ENABLED;
  await db.pool.end();
});

const PHONE_SEED = Date.now() % 9000000;
let phoneSeq = 0;
function freshPhone() { phoneSeq += 1; return `310${(PHONE_SEED + phoneSeq) % 9000000 + 1000000}`; }

async function lead(key, { phone } = {}) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, sms_consent, created_at)
     VALUES ($1, $2, $3, 'New', $4, true, '2099-01-01') RETURNING id`,
    [key, RUN, ownerId, phone || freshPhone()]
  );
  return r.rows[0].id;
}

async function postInbound({ sid, from, body }) {
  return fetch(`${base}/api/v1/sms-webhook/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessageSid: sid, From: `+1${from}`, To: '+15550001111', Body: body }).toString(),
  });
}

test('a uniquely-matched inbound reply notifies the real assigned rep by EMAIL, with real names (never invented) — never a Yaron SMS forward', { skip }, async () => {
  const phone = freshPhone();
  const leadId = await lead('Sarah', { phone });
  const emailCountBefore = fakeEmail.sent.length;
  const smsSentBefore = fakeTwilio.sent.length;

  const r = await postInbound({ sid: `SM-${RUN}-1`, from: phone, body: 'Can we move our appointment to 3 PM?' });
  assert.strictEqual(r.status, 200);

  // Rep notification email.
  const repEmails = fakeEmail.sent.slice(emailCountBefore);
  assert.strictEqual(repEmails.length, 1, 'exactly one rep-notification email');
  assert.strictEqual(repEmails[0].to.toLowerCase(), `${RUN}.owner@ecconstructiongroup.com`.toLowerCase());
  assert.match(repEmails[0].htmlBody, /Sarah/);
  assert.match(repEmails[0].htmlBody, /Can we move our appointment to 3 PM\?/);

  // The retired Yaron SMS forward must never fire.
  assert.strictEqual(fakeTwilio.sent.length, smsSentBefore, 'no outbound SMS is ever sent as a reply notification');

  void leadId;
});

test('a redelivered webhook (same MessageSid) never double-notifies the rep by email', { skip }, async () => {
  const phone = freshPhone();
  await lead('Marcus', { phone });
  const sid = `SM-${RUN}-dup-1`;

  await postInbound({ sid, from: phone, body: 'Thanks!' });
  const emailCountAfterFirst = fakeEmail.sent.length;

  // Twilio redelivers the identical webhook (network hiccup, no 200 seen).
  await postInbound({ sid, from: phone, body: 'Thanks!' });

  assert.strictEqual(fakeEmail.sent.length, emailCountAfterFirst, 'no second rep-notification email on redelivery');
});

test('an ambiguous match (two leads share the number) routes to staff review by email — never an SMS forward', { skip }, async () => {
  const phone = freshPhone();
  await lead('Dup1', { phone });
  await lead('Dup2', { phone });
  const emailCountBefore = fakeEmail.sent.length;
  const smsSentBefore = fakeTwilio.sent.length;

  await postInbound({ sid: `SM-${RUN}-ambig-1`, from: phone, body: 'Hi, question about my quote' });

  const emails = fakeEmail.sent.slice(emailCountBefore);
  assert.ok(emails.length >= 1, 'at least one review notification sent');
  assert.match(emails[0].subject, /multiple matching leads/);

  assert.strictEqual(fakeTwilio.sent.length, smsSentBefore, 'no outbound SMS is ever sent as a reply notification');
});

test('a STOP keyword reply never triggers a rep notification email (handled entirely by opt-out + TwiML)', { skip }, async () => {
  const phone = freshPhone();
  await lead('OptOut', { phone });
  const emailCountBefore = fakeEmail.sent.length;

  await postInbound({ sid: `SM-${RUN}-stop-1`, from: phone, body: 'STOP' });

  assert.strictEqual(fakeEmail.sent.length, emailCountBefore);
});
