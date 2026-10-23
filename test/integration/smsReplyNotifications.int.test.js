/* eslint-disable no-undef */
'use strict';

/**
 * smsReplyNotifications.int.test.js — REAL-Postgres, end-to-end proof of the
 * October 2026 "two-way appointment SMS" inbound-reply side effects:
 * rep notification (real owner FK, never guessed), the mandatory Yaron SMS
 * forward (with its loop guard), ambiguous-match admin review routing, and
 * duplicate-webhook-delivery idempotency — all against the REAL
 * routes/sms.js webhook + lib/smsReplyNotify.js, with Twilio and Gmail both
 * faked (no live network call). Skipped without TEST_DATABASE_URL.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'sms-test-jwt-secret-at-least-32-characters-long';
process.env.SMS_REPLY_NOTIFICATIONS_ENABLED = 'true';
process.env.SMS_REPLY_FORWARD_TO = '+13105559999'; // a DIFFERENT number from the fake sender below — must never equal it (loop guard)

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
  delete process.env.SMS_REPLY_FORWARD_TO;
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

test('a uniquely-matched inbound reply notifies the real assigned rep AND forwards to Yaron, with real names (never invented)', { skip }, async () => {
  const phone = freshPhone();
  const leadId = await lead('Sarah', { phone });
  const emailCountBefore = fakeEmail.sent.length;
  const forwardCountBefore = fakeTwilio.sent.length;

  const r = await postInbound({ sid: `SM-${RUN}-1`, from: phone, body: 'Can we move our appointment to 3 PM?' });
  assert.strictEqual(r.status, 200);

  // Rep notification email.
  const repEmails = fakeEmail.sent.slice(emailCountBefore);
  assert.strictEqual(repEmails.length, 1, 'exactly one rep-notification email');
  assert.strictEqual(repEmails[0].to.toLowerCase(), `${RUN}.owner@ecconstructiongroup.com`.toLowerCase());
  assert.match(repEmails[0].htmlBody, /Sarah/);
  assert.match(repEmails[0].htmlBody, /Can we move our appointment to 3 PM\?/);

  // Yaron forward.
  const forwards = fakeTwilio.sent.slice(forwardCountBefore);
  assert.strictEqual(forwards.length, 1, 'exactly one Yaron-forward SMS');
  assert.strictEqual(forwards[0].to, '+13105559999');
  assert.match(forwards[0].body, /Customer: Sarah/);
  assert.match(forwards[0].body, /SMS Reply Test Owner/);
  assert.match(forwards[0].body, /Message: Can we move our appointment to 3 PM\?/);

  void leadId;
});

test('a redelivered webhook (same MessageSid) never double-notifies the rep or double-forwards to Yaron', { skip }, async () => {
  const phone = freshPhone();
  await lead('Marcus', { phone });
  const sid = `SM-${RUN}-dup-1`;

  await postInbound({ sid, from: phone, body: 'Thanks!' });
  const emailCountAfterFirst = fakeEmail.sent.length;
  const forwardCountAfterFirst = fakeTwilio.sent.length;

  // Twilio redelivers the identical webhook (network hiccup, no 200 seen).
  await postInbound({ sid, from: phone, body: 'Thanks!' });

  assert.strictEqual(fakeEmail.sent.length, emailCountAfterFirst, 'no second rep-notification email on redelivery');
  assert.strictEqual(fakeTwilio.sent.length, forwardCountAfterFirst, 'no second Yaron forward on redelivery');
});

test('an ambiguous match (two leads share the number) routes to staff review, but Yaron forward still fires regardless of rep ownership', { skip }, async () => {
  const phone = freshPhone();
  await lead('Dup1', { phone });
  await lead('Dup2', { phone });
  const emailCountBefore = fakeEmail.sent.length;
  const forwardCountBefore = fakeTwilio.sent.length;

  await postInbound({ sid: `SM-${RUN}-ambig-1`, from: phone, body: 'Hi, question about my quote' });

  const emails = fakeEmail.sent.slice(emailCountBefore);
  assert.ok(emails.length >= 1, 'at least one review notification sent');
  assert.match(emails[0].subject, /multiple matching leads/);

  const forwards = fakeTwilio.sent.slice(forwardCountBefore);
  assert.strictEqual(forwards.length, 1, 'Yaron forward still fires for an ambiguous match');
  assert.match(forwards[0].body, /Sales Rep: Unassigned/);
});

test('a STOP keyword reply never triggers a rep notification or a Yaron forward (handled entirely by opt-out + TwiML)', { skip }, async () => {
  const phone = freshPhone();
  await lead('OptOut', { phone });
  const emailCountBefore = fakeEmail.sent.length;
  const forwardCountBefore = fakeTwilio.sent.length;

  await postInbound({ sid: `SM-${RUN}-stop-1`, from: phone, body: 'STOP' });

  assert.strictEqual(fakeEmail.sent.length, emailCountBefore);
  assert.strictEqual(fakeTwilio.sent.length, forwardCountBefore);
});
