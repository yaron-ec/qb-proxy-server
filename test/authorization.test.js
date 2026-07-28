/* eslint-disable no-undef */
/**
 * authorization.test.js — stable-ID lead authorization for Railway routes.
 *
 * Run: cd src/proxy-server && node --test test/authorization.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { canAccessLead, resolveOwnerEmail, canonicalEmail } = require('../lib/authorization');

test('admin always allowed', () => {
  assert.ok(canAccessLead({ email: 'a@x.com', role: 'admin' }, { assigned_rep: 'Someone Else' }));
  assert.ok(canAccessLead({ email: 'a@x.com', role: 'admin' }, { assigned_rep: null }));
});

test('manager allowed (matches CRM RLS)', () => {
  assert.ok(canAccessLead({ email: 'm@x.com', role: 'manager' }, { assigned_rep: 'Yaron Drilevich' }));
});

test('sales_rep allowed only on own lead (name -> email resolution)', () => {
  const rep = { email: 'yaron@ecconstructiongroup.com', role: 'sales_rep' };
  assert.ok(canAccessLead(rep, { assigned_rep: 'Yaron Drilevich' }));
  assert.ok(canAccessLead(rep, { assigned_rep: 'yaron@ecconstructiongroup.com' }));
  assert.ok(canAccessLead(rep, { assigned_rep: 'YARON@ECConstructionGroup.com' }));
});

test('sales_rep denied on other reps lead', () => {
  const rep = { email: 'yaron@ecconstructiongroup.com', role: 'sales_rep' };
  assert.strictEqual(canAccessLead(rep, { assigned_rep: 'Michelle' }), false);
  assert.strictEqual(canAccessLead(rep, { assigned_rep: 'michelle@ecconstructiongroup.com' }), false);
});

test('office role has no lead scope (denied)', () => {
  assert.strictEqual(canAccessLead({ email: 'o@x.com', role: 'office' }, { assigned_rep: 'o@x.com' }), false);
});

test('unassigned lead -> no non-admin access', () => {
  assert.strictEqual(canAccessLead({ email: 'r@x.com', role: 'sales_rep' }, { assigned_rep: null }), false);
  assert.strictEqual(canAccessLead({ email: 'r@x.com', role: 'sales_rep' }, { assigned_rep: '' }), false);
  assert.ok(canAccessLead({ email: 'r@x.com', role: 'admin' }, { assigned_rep: null }));
});

test('missing role denied', () => {
  assert.strictEqual(canAccessLead({ email: 'r@x.com', role: '' }, { assigned_rep: 'r@x.com' }), false);
  assert.strictEqual(canAccessLead({ email: 'r@x.com' }, { assigned_rep: 'r@x.com' }), false);
});

test('missing user email denied', () => {
  assert.strictEqual(canAccessLead({ role: 'sales_rep' }, { assigned_rep: 'r@x.com' }), false);
});

test('case normalization', () => {
  assert.strictEqual(canonicalEmail('Jane@Example.COM'), 'jane@example.com');
  assert.strictEqual(canonicalEmail('  X@Y.io '), 'x@y.io');
  assert.strictEqual(canonicalEmail('not-an-email'), null);
  assert.strictEqual(canonicalEmail(null), null);
});

test('resolveOwnerEmail handles email and name forms', () => {
  assert.strictEqual(resolveOwnerEmail('yaron@ecconstructiongroup.com'), 'yaron@ecconstructiongroup.com');
  assert.strictEqual(resolveOwnerEmail('Yaron Drilevich'), 'yaron@ecconstructiongroup.com');
  assert.strictEqual(resolveOwnerEmail('Michelle'), 'michelle@ecconstructiongroup.com');
  assert.strictEqual(resolveOwnerEmail(null), null);
  assert.strictEqual(resolveOwnerEmail(''), null);
});

test('historical owner-name does not accidentally grant access', () => {
  // A display name like "Yaron" must resolve to yaron@ecconstructiongroup.com,
  // so a different user "yaron2@x.com" is NOT granted.
  const lead = { assigned_rep: 'Yaron' };
  assert.ok(canAccessLead({ email: 'yaron@ecconstructiongroup.com', role: 'sales_rep' }, lead));
  assert.strictEqual(canAccessLead({ email: 'yaron2@x.com', role: 'sales_rep' }, lead), false);
});