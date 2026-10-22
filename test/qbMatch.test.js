/* eslint-disable no-undef */
'use strict';

/**
 * qbMatch.test.js — QB Estimate → CRM Lead matching engine (lib/qbMatch.js).
 *
 * Built during the October 2026 Handoff→QuickBooks→CRM estimate-sync audit.
 * Found: Priority 1 (phone+name) and Priority 2 (email+name) picked
 * `hits[0]` on an ambiguous (>1) match — i.e. whichever lead happened to
 * sort first by -created_date — rather than declining to guess. A real
 * QuickBooks estimate could silently attach to the WRONG lead with no
 * record anything was ambiguous. Fixed to fall through to the next,
 * different-signal priority instead of guessing; Priority 0 (the
 * authoritative qb_customer_id mapping) is unchanged — it already failed
 * closed on ambiguity and must stay that way (it is NOT a heuristic).
 */
const test = require('node:test');
const assert = require('node:assert');
const qbMatch = require('../lib/qbMatch');

function lead(overrides) {
  return { id: 'lead-default', first_name: 'First', last_name: 'Last', email: null, phone: null, qb_customer_id: null, property_address: null, ...overrides };
}

test('Priority 0 (qb_customer_id): ambiguous mapping still fails closed (unchanged behavior)', () => {
  const leads = [
    lead({ id: 'a', qb_customer_id: '160' }),
    lead({ id: 'b', qb_customer_id: '160' }),
  ];
  const customer = { Id: '160', DisplayName: 'Anyone' };
  assert.strictEqual(qbMatch.findMatchingLead(customer, leads), null);
});

test('Priority 1 (phone+name): a single match is still returned', () => {
  const leads = [lead({ id: 'only', phone: '3105551234', first_name: 'Evelyn', last_name: 'Cesento' })];
  const customer = { Id: '999', DisplayName: 'Evelyn Cesento', PrimaryPhone: { FreeFormNumber: '3105551234' } };
  const match = qbMatch.findMatchingLead(customer, leads);
  assert.ok(match);
  assert.strictEqual(match.id, 'only');
});

test('Priority 1 (phone+name): an ambiguous match (two leads, same phone + name fragment) no longer guesses hits[0]', () => {
  const leads = [
    lead({ id: 'newer', phone: '3105551234', first_name: 'John', last_name: 'Smith' }),
    lead({ id: 'older', phone: '3105551234', first_name: 'John', last_name: 'Jones' }),
  ];
  const customer = { Id: '999', DisplayName: 'John Doe', PrimaryPhone: { FreeFormNumber: '3105551234' } };
  // Both leads share the phone number and both partially match "John" —
  // this must NOT silently resolve to leads[0] ("newer").
  const match = qbMatch.findMatchingLead(customer, leads);
  assert.strictEqual(match, null, 'ambiguous phone+name match must not guess a lead');
});

test('Priority 1 ambiguous → falls through to Priority 2 (email) when email uniquely resolves', () => {
  const leads = [
    lead({ id: 'newer', phone: '3105551234', first_name: 'John', last_name: 'Smith', email: 'other@test.com' }),
    lead({ id: 'older', phone: '3105551234', first_name: 'John', last_name: 'Jones', email: 'evelyn@test.com' }),
  ];
  const customer = {
    Id: '999', DisplayName: 'John Doe',
    PrimaryPhone: { FreeFormNumber: '3105551234' },
    PrimaryEmailAddr: { Address: 'evelyn@test.com' },
  };
  // Phone+name is ambiguous (both leads share the phone and match "John"),
  // but email is unique — the fix must still find this correct match
  // instead of failing the whole lookup closed at Priority 1.
  const match = qbMatch.findMatchingLead(customer, leads);
  assert.ok(match, 'should fall through to email+name match');
  assert.strictEqual(match.id, 'older');
});

test('Priority 2 (email+name): an ambiguous match (two leads, same email + name fragment) no longer guesses hits[0]', () => {
  const leads = [
    lead({ id: 'newer', email: 'shared@test.com', first_name: 'John', last_name: 'Smith' }),
    lead({ id: 'older', email: 'shared@test.com', first_name: 'John', last_name: 'Jones' }),
  ];
  const customer = { Id: '999', DisplayName: 'John Doe', PrimaryEmailAddr: { Address: 'shared@test.com' } };
  const match = qbMatch.findMatchingLead(customer, leads);
  assert.strictEqual(match, null, 'ambiguous email+name match must not guess a lead');
});

test('no match when nothing resolves uniquely at any priority', () => {
  const leads = [lead({ id: 'unrelated', phone: '5550000000', email: 'nobody@test.com' })];
  const customer = { Id: '999', DisplayName: 'Totally Different', PrimaryPhone: { FreeFormNumber: '1234567890' } };
  assert.strictEqual(qbMatch.findMatchingLead(customer, leads), null);
});
