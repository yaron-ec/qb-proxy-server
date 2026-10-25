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

// ── webhookBaseUrl / webhookBaseUrlSource — October 2026 inbound-SMS
// incident: this function previously lived in routes/sms.js and read ONLY
// CRM_PUBLIC_URL, which every other call site in this codebase (verified
// across lib/dataAccessRailway.js, lib/platformInfraProvisioning.js's own
// provisioning step) establishes as the FRONTEND's own public URL, not the
// BACKEND's — a structural signature-verification mismatch, since Twilio
// signs against the BACKEND's real public URL. These tests prove the fix:
// a dedicated TWILIO_WEBHOOK_BASE_URL (the backend's own URL) is read
// FIRST, with CRM_PUBLIC_URL only as a last-resort, visibly-flagged
// fallback.
test('webhookBaseUrl: prefers TWILIO_WEBHOOK_BASE_URL over CRM_PUBLIC_URL when both are set', () => {
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://qb-proxy-server-production.up.railway.app';
  process.env.CRM_PUBLIC_URL = 'https://crm.ecconstructiongroup.com';
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.strictEqual(smsClient.webhookBaseUrl(), 'https://qb-proxy-server-production.up.railway.app');
  assert.strictEqual(smsClient.webhookBaseUrlSource(), 'TWILIO_WEBHOOK_BASE_URL');
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.CRM_PUBLIC_URL;
});

test('webhookBaseUrl: strips a trailing slash from TWILIO_WEBHOOK_BASE_URL', () => {
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://qb-proxy-server-production.up.railway.app/';
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.strictEqual(smsClient.webhookBaseUrl(), 'https://qb-proxy-server-production.up.railway.app');
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
});

test('webhookBaseUrl: falls back to CRM_PUBLIC_URL (flagged as CRM_PUBLIC_URL_fallback, not silently treated as correct) when TWILIO_WEBHOOK_BASE_URL is unset — reproduces the exact pre-fix production misconfiguration', () => {
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  process.env.CRM_PUBLIC_URL = 'https://crm.ecconstructiongroup.com';
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.strictEqual(smsClient.webhookBaseUrl(), 'https://crm.ecconstructiongroup.com');
  assert.strictEqual(smsClient.webhookBaseUrlSource(), 'CRM_PUBLIC_URL_fallback');
  delete process.env.CRM_PUBLIC_URL;
});

test('webhookBaseUrl: reports "unset" when neither env var is configured', () => {
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.CRM_PUBLIC_URL;
  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');
  assert.strictEqual(smsClient.webhookBaseUrl(), '');
  assert.strictEqual(smsClient.webhookBaseUrlSource(), 'unset');
});

test('the incident, reproduced: a signature Twilio computes against the real BACKEND URL never verifies when CRM_PUBLIC_URL (the FRONTEND URL) is used instead — and DOES verify once TWILIO_WEBHOOK_BASE_URL is set correctly', () => {
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  const backendUrl = 'https://qb-proxy-server-production.up.railway.app/api/v1/sms-webhook/inbound';
  const frontendUrl = 'https://crm.ecconstructiongroup.com/api/v1/sms-webhook/inbound';
  const params = { MessageSid: 'SM123', From: '+13239611116', To: '+18185930874', Body: 'Hi' };
  const sortedKeys = Object.keys(params).sort();
  // The REAL signature Twilio computes — against the URL it actually POSTed to (the backend).
  let data = backendUrl;
  for (const k of sortedKeys) data += k + params[k];
  const realTwilioSignature = crypto.createHmac('sha1', 'test-auth-token').update(Buffer.from(data, 'utf-8')).digest('base64');

  delete require.cache[require.resolve('../lib/smsClient')];
  const smsClient = require('../lib/smsClient');

  // Pre-fix behavior: verifying against the frontend's URL (what CRM_PUBLIC_URL
  // resolves to) never matches the real signature — this IS the incident.
  assert.strictEqual(smsClient.verifyTwilioSignature(frontendUrl, params, realTwilioSignature), false);
  // Post-fix behavior: verifying against the correct backend URL succeeds.
  assert.strictEqual(smsClient.verifyTwilioSignature(backendUrl, params, realTwilioSignature), true);
  delete process.env.TWILIO_AUTH_TOKEN;
});
