/* eslint-disable no-undef */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

test('verifyTwilioSignature: accepts a correctly computed signature for the given URL + params', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');

  const url = 'https://crm.example.com/api/v1/sms-webhook/inbound';
  const params = { MessageSid: 'SM123', From: '+15551234567', To: '+15559876543', Body: 'Hello' };
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];
  const expected = crypto.createHmac('sha1', 'test-auth-token').update(Buffer.from(data, 'utf-8')).digest('base64');

  assert.strictEqual(smsClient.verifyTwilioSignature(url, params, expected), true);
});

test('verifyTwilioSignature: rejects a tampered signature', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.strictEqual(smsClient.verifyTwilioSignature('https://crm.example.com/x', { a: '1' }, 'not-a-real-signature'), false);
});

test('verifyTwilioSignature: rejects a missing signature header when a token IS configured', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.strictEqual(smsClient.verifyTwilioSignature('https://crm.example.com/x', {}, undefined), false);
});

test('verifyTwilioSignature: skips verification (returns true) when TWILIO_AUTH_TOKEN is not configured — matches routes/metaWebhook.js\'s existing convention', () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.strictEqual(smsClient.verifyTwilioSignature('https://crm.example.com/x', {}, undefined), true);
});

test('missingConfig: reports every absent required env var without ever including a secret value', () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_FROM;
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  const missing = smsClient.missingConfig();
  assert.ok(missing.includes('TWILIO_ACCOUNT_SID'));
  assert.ok(missing.includes('TWILIO_AUTH_TOKEN'));
  assert.ok(missing.includes('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM'));
  assert.ok(!missing.some((m) => /^AC[a-f0-9]{32}$/i.test(m)), 'must never leak an actual Account SID value — only env var names');
});

test('missingConfig: satisfied by either TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID (not both required)', () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  process.env.TWILIO_FROM = '+15551234567';
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.deepStrictEqual(smsClient.missingConfig(), []);
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM;
});
