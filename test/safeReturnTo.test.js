/* eslint-disable no-undef */
'use strict';

/**
 * safeReturnTo.test.js — lib/safeReturnTo.js, which validates the post-login
 * "return to" path (e.g. /leads/<id>, preserved from a New Lead/incoming-SMS
 * email link a logged-out user followed) carried through routes/auth.js's
 * Google OAuth `state` parameter and read back by crm-frontend's Login.jsx.
 * The one thing this MUST never allow is an open redirect — a crafted login
 * link sending a freshly-issued session's tokens to an external host.
 */
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeReturnTo } = require('../lib/safeReturnTo');

test('sanitizeReturnTo: a genuine internal path (the exact incident lead) is accepted unchanged', () => {
  assert.strictEqual(sanitizeReturnTo('/leads/774d31bd-1134-4319-8298-5810dbe196a5'), '/leads/774d31bd-1134-4319-8298-5810dbe196a5');
});

test('sanitizeReturnTo: a path with query string is accepted unchanged', () => {
  assert.strictEqual(sanitizeReturnTo('/leads/abc?tab=activity'), '/leads/abc?tab=activity');
});

test('sanitizeReturnTo: null/undefined/empty -> null', () => {
  assert.strictEqual(sanitizeReturnTo(null), null);
  assert.strictEqual(sanitizeReturnTo(undefined), null);
  assert.strictEqual(sanitizeReturnTo(''), null);
});

test('sanitizeReturnTo: non-string input -> null', () => {
  assert.strictEqual(sanitizeReturnTo(42), null);
  assert.strictEqual(sanitizeReturnTo({}), null);
  assert.strictEqual(sanitizeReturnTo(['/leads/x']), null);
});

test('sanitizeReturnTo: an absolute URL is rejected (never trusted as a redirect target)', () => {
  assert.strictEqual(sanitizeReturnTo('https://evil.example.com/leads/x'), null);
  assert.strictEqual(sanitizeReturnTo('http://evil.example.com'), null);
});

test('sanitizeReturnTo: protocol-relative "//host/..." is rejected — the classic open-redirect form', () => {
  assert.strictEqual(sanitizeReturnTo('//evil.example.com/leads/x'), null);
});

test('sanitizeReturnTo: backslash variant "/\\\\host/..." is rejected (browsers treat it like "//")', () => {
  assert.strictEqual(sanitizeReturnTo('/\\evil.example.com'), null);
});

test('sanitizeReturnTo: a scheme disguised as a path segment (e.g. "/javascript:alert(1)") is rejected', () => {
  assert.strictEqual(sanitizeReturnTo('/javascript:alert(1)'), null);
  assert.strictEqual(sanitizeReturnTo('/data:text/html,x'), null);
});

test('sanitizeReturnTo: a path not starting with "/" is rejected', () => {
  assert.strictEqual(sanitizeReturnTo('leads/x'), null);
  assert.strictEqual(sanitizeReturnTo('evil.com/leads/x'), null);
});

test('sanitizeReturnTo: an excessively long value is rejected (defense in depth)', () => {
  assert.strictEqual(sanitizeReturnTo(`/leads/${'a'.repeat(3000)}`), null);
});
