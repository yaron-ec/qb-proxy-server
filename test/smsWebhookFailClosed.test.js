/* eslint-disable no-undef */
'use strict';

/**
 * smsWebhookFailClosed.test.js — HTTP-level proof of the November 2026 CRM
 * hardening fix: routes/sms.js's two Twilio webhooks (`/inbound`, `/status`)
 * previously had no explicit "is Twilio configured" check at all — an unset
 * TWILIO_AUTH_TOKEN fell through to lib/smsClient.js#verifyTwilioSignature's
 * old fail-OPEN default (return true, "skip verification"), silently
 * accepting any unsigned request as genuine Twilio traffic. Not currently
 * exploitable in production (TWILIO_AUTH_TOKEN is configured there) — this
 * closes the latent gap with the same fail-closed convention already
 * proven for Meta (test/metaWebhookFailClosed.test.js) and QuickBooks
 * (test/qbWebhookFailClosed.test.js): a distinct 503 "not_configured",
 * never confused with a 401 "signature didn't match".
 *
 * No TEST_DATABASE_URL needed — lib/moduleGate.js's own documented
 * fail-open-on-DB-error behavior lets these requests reach the new check
 * even with no database configured (same convention other unit-level route
 * tests in this suite already rely on).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const activeServers = [];

async function startServer({ token }) {
  if (token === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = token;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete require.cache[require.resolve(path.join(ROOT, 'lib/smsClient'))];
  delete require.cache[require.resolve(path.join(ROOT, 'routes/sms'))];
  const express = require('express');
  const app = express();
  app.use(express.json());
  const smsRoutes = require(path.join(ROOT, 'routes/sms'));
  app.use('/sms-webhook', smsRoutes.webhookRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  activeServers.push(server);
  return `http://127.0.0.1:${server.address().port}/sms-webhook`;
}

test.after(async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  await Promise.all(activeServers.map((s) => new Promise((r) => s.close(r))));
});

test('POST /inbound: TWILIO_AUTH_TOKEN unset → 503 not_configured, never a silently-accepted unsigned message', async () => {
  const url = await startServer({ token: undefined });
  const res = await fetch(`${url}/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'MessageSid=SM123&From=%2B15551234567&Body=hello',
  });
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.error, 'not_configured');
});

test('POST /status: TWILIO_AUTH_TOKEN unset → 503 not_configured', async () => {
  const url = await startServer({ token: undefined });
  const res = await fetch(`${url}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'MessageSid=SM123&MessageStatus=delivered',
  });
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.error, 'not_configured');
});

test('POST /inbound: TWILIO_AUTH_TOKEN configured but no signature header → still reaches the real 401 signature check, not a 503', async () => {
  const url = await startServer({ token: 'a-real-looking-token' });
  const res = await fetch(`${url}/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'MessageSid=SM123&From=%2B15551234567&Body=hello',
  });
  assert.strictEqual(res.status, 401);
});
