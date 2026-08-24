/* eslint-disable no-undef */
/**
 * captureOverrideAuth.test.js — server-side admin override authorization.
 *
 * Run: cd src/proxy-server && node --test test/captureOverrideAuth.test.js
 *
 * Covers: no-token -> 403, non-admin -> 403, non-allowlisted admin -> 403,
 * invalid token -> 403, Yaron/Michelle admin -> ok, case-insensitive email.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { authorizeOverride, isOverrideAdminEmail, ADMIN_OVERRIDE_EMAILS } = require('../lib/captureOverrideAuth');

function fakeVerify(payload) {
  return (token) => {
    if (token === 'bad') throw new Error('invalid signature');
    return payload;
  };
}

test('isOverrideAdminEmail: allowlisted emails (case-insensitive)', () => {
  assert.ok(isOverrideAdminEmail('yaron@ecconstructiongroup.com'));
  assert.ok(isOverrideAdminEmail('YARON@ECConstructionGroup.com'));
  assert.ok(isOverrideAdminEmail('  michelle@ecconstructiongroup.com '));
  assert.ok(isOverrideAdminEmail('Michelle@ECConstructionGroup.com'));
});

test('isOverrideAdminEmail: rejects non-allowlisted', () => {
  assert.strictEqual(isOverrideAdminEmail('ethan@ecconstructiongroup.com'), false);
  assert.strictEqual(isOverrideAdminEmail('yaron@gmail.com'), false);
  assert.strictEqual(isOverrideAdminEmail(''), false);
  assert.strictEqual(isOverrideAdminEmail(null), false);
  assert.strictEqual(isOverrideAdminEmail(undefined), false);
});

test('ADMIN_OVERRIDE_EMAILS contains exactly the two admins', () => {
  assert.strictEqual(ADMIN_OVERRIDE_EMAILS.size, 2);
  assert.ok(ADMIN_OVERRIDE_EMAILS.has('yaron@ecconstructiongroup.com'));
  assert.ok(ADMIN_OVERRIDE_EMAILS.has('michelle@ecconstructiongroup.com'));
});

test('no authorization header -> 403', () => {
  const r = authorizeOverride(undefined, fakeVerify({}));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'override_forbidden');
});

test('non-Bearer header -> 403', () => {
  const r = authorizeOverride('Basic abc', fakeVerify({}));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'override_forbidden');
});

test('invalid/expired token -> 403', () => {
  const r = authorizeOverride('Bearer bad', fakeVerify({}));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'override_forbidden');
});

test('non-admin role -> 403', () => {
  const r = authorizeOverride('Bearer t', fakeVerify({
    sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'sales_rep',
  }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'override_forbidden');
});

test('admin but non-allowlisted email -> 403', () => {
  const r = authorizeOverride('Bearer t', fakeVerify({
    sub: 'u2', email: 'ethan@ecconstructiongroup.com', role: 'admin',
  }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'override_forbidden');
});

test('Yaron admin -> ok', () => {
  const r = authorizeOverride('Bearer t', fakeVerify({
    sub: 'u3', email: 'yaron@ecconstructiongroup.com', role: 'admin', full_name: 'Yaron Drilevich',
  }));
  assert.ok(r.ok);
  assert.strictEqual(r.user.email, 'yaron@ecconstructiongroup.com');
  assert.strictEqual(r.user.role, 'admin');
});

test('Michelle admin -> ok (case-insensitive email)', () => {
  const r = authorizeOverride('Bearer t', fakeVerify({
    sub: 'u4', email: 'Michelle@ECConstructionGroup.com', role: 'admin',
  }));
  assert.ok(r.ok);
  assert.strictEqual(r.user.email, 'Michelle@ECConstructionGroup.com');
});

test('missing role in payload -> 403', () => {
  const r = authorizeOverride('Bearer t', fakeVerify({ sub: 'u5', email: 'yaron@ecconstructiongroup.com' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'override_forbidden');
});