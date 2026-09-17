/* eslint-disable no-undef */
'use strict';

/**
 * reconcileGoogleContactsLive.test.js — read-only LIVE Google Contacts
 * reconciliation classifier.
 *
 * Covers every required category (MATCHED, MISSING, AMBIGUOUS,
 * DUPLICATE_GOOGLE, INSUFFICIENT_DATA, ERROR) against realistic Google
 * People API searchContacts response shapes, using the corrected shared
 * matching rule (last-10-digits phone comparison, exact email match —
 * never name-only). Also proves the script has literally no write path.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { classifyContactMatch, classifyLead, runReconciliation } = require('../scripts/reconcileGoogleContactsLive');

function person(overrides = {}) {
  return { resourceName: 'people/c1', emailAddresses: [], phoneNumbers: [], ...overrides };
}

test('MATCHED: a single, unambiguous Google contact found by email', () => {
  const r = classifyContactMatch({
    email: 'brian.krantz1@gmail.com', phone: null,
    emailResults: [person({ resourceName: 'people/c1', emailAddresses: [{ value: 'brian.krantz1@gmail.com' }] })],
    phoneResults: null,
  });
  assert.strictEqual(r.category, 'MATCHED');
});

test('MATCHED: found by phone using last-10-digits comparison (e.g. stored without a country code)', () => {
  const r = classifyContactMatch({
    email: null, phone: '+13235551234',
    emailResults: null,
    phoneResults: [person({ resourceName: 'people/c2', phoneNumbers: [{ value: '(323) 555-1234' }] })],
  });
  assert.strictEqual(r.category, 'MATCHED');
});

test('MATCHED: email and phone both resolve to the SAME Google contact', () => {
  const r = classifyContactMatch({
    email: 'brian@example.com', phone: '3235551234',
    emailResults: [person({ resourceName: 'people/c1', emailAddresses: [{ value: 'brian@example.com' }] })],
    phoneResults: [person({ resourceName: 'people/c1', phoneNumbers: [{ value: '3235551234' }] })],
  });
  assert.strictEqual(r.category, 'MATCHED');
});

test('MISSING: no Google contact found for either email or phone', () => {
  const r = classifyContactMatch({ email: 'nobody@example.com', phone: '3235551234', emailResults: [], phoneResults: [] });
  assert.strictEqual(r.category, 'MISSING');
});

test('AMBIGUOUS: email search and phone search resolve to TWO DIFFERENT Google contacts', () => {
  const r = classifyContactMatch({
    email: 'brian@example.com', phone: '3235551234',
    emailResults: [person({ resourceName: 'people/c1', emailAddresses: [{ value: 'brian@example.com' }] })],
    phoneResults: [person({ resourceName: 'people/c2', phoneNumbers: [{ value: '3235551234' }] })],
  });
  assert.strictEqual(r.category, 'AMBIGUOUS');
});

test('DUPLICATE_GOOGLE: the SAME email search returns more than one distinct Google contact', () => {
  const r = classifyContactMatch({
    email: 'brian@example.com', phone: null,
    emailResults: [
      person({ resourceName: 'people/c1', emailAddresses: [{ value: 'brian@example.com' }] }),
      person({ resourceName: 'people/c2', emailAddresses: [{ value: 'brian@example.com' }] }),
    ],
    phoneResults: null,
  });
  assert.strictEqual(r.category, 'DUPLICATE_GOOGLE');
  assert.strictEqual(r.via, 'email');
});

test('DUPLICATE_GOOGLE: the SAME phone search returns more than one distinct Google contact', () => {
  const r = classifyContactMatch({
    email: null, phone: '3235551234',
    emailResults: null,
    phoneResults: [
      person({ resourceName: 'people/c1', phoneNumbers: [{ value: '3235551234' }] }),
      person({ resourceName: 'people/c2', phoneNumbers: [{ value: '(323) 555-1234' }] }),
    ],
  });
  assert.strictEqual(r.category, 'DUPLICATE_GOOGLE');
  assert.strictEqual(r.via, 'phone');
});

test('INSUFFICIENT_DATA: the lead has neither email nor phone — never searched at all', () => {
  const r = classifyContactMatch({ email: null, phone: null, emailResults: null, phoneResults: null });
  assert.strictEqual(r.category, 'INSUFFICIENT_DATA');
});

test('never matches on name alone — a name-only "match" in the raw results with no matching email/phone value is MISSING, not MATCHED', () => {
  const r = classifyContactMatch({
    email: 'real@example.com', phone: null,
    emailResults: [person({ resourceName: 'people/c1', names: [{ displayName: 'Brian Krantz' }], emailAddresses: [{ value: 'different@example.com' }] })],
    phoneResults: null,
  });
  assert.strictEqual(r.category, 'MISSING');
});

test('classifyLead: ERROR when the Google API call itself fails — never silently treated as MISSING', async () => {
  const lead = { id: 'lead-1', email: 'brian@example.com', phone: null, owner_email: 'yaron@ecconstructiongroup.com' };
  const result = await classifyLead(lead, {
    getAccessToken: async () => 'fake-token',
    fetchImpl: async () => { throw new Error('network unreachable'); },
    peopleBase: 'https://people.googleapis.com/v1',
  });
  assert.strictEqual(result.category, 'ERROR');
  assert.ok(result.error.includes('network unreachable'));
});

test('classifyLead: a non-2xx Google response is ERROR, not MISSING', async () => {
  const lead = { id: 'lead-2', email: 'brian@example.com', phone: null, owner_email: 'yaron@ecconstructiongroup.com' };
  const result = await classifyLead(lead, {
    getAccessToken: async () => 'fake-token',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    peopleBase: 'https://people.googleapis.com/v1',
  });
  assert.strictEqual(result.category, 'ERROR');
});

test('runReconciliation: buckets every lead into exactly one category, end to end', async () => {
  const leads = [
    { id: 'l-matched', email: 'a@example.com', phone: null, owner_email: 'yaron@ecconstructiongroup.com' },
    { id: 'l-missing', email: 'b@example.com', phone: null, owner_email: 'yaron@ecconstructiongroup.com' },
    { id: 'l-insufficient', email: null, phone: null, owner_email: 'yaron@ecconstructiongroup.com' },
  ];
  const fetchImpl = async (url) => {
    if (String(url).includes('a%40example.com')) {
      return { ok: true, status: 200, json: async () => ({ results: [{ person: { resourceName: 'people/c1', emailAddresses: [{ value: 'a@example.com' }] } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  const buckets = await runReconciliation(leads, { getAccessToken: async () => 'tok', fetchImpl, peopleBase: 'https://people.googleapis.com/v1' });
  assert.strictEqual(buckets.MATCHED.length, 1);
  assert.strictEqual(buckets.MISSING.length, 1);
  assert.strictEqual(buckets.INSUFFICIENT_DATA.length, 1);
  const total = Object.values(buckets).reduce((s, arr) => s + arr.length, 0);
  assert.strictEqual(total, leads.length, 'every lead lands in exactly one bucket');
});

test('the script has NO write path to Google Contacts at all — no --apply/--enqueue flag, no create/update/delete call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reconcileGoogleContactsLive.js'), 'utf8');
  assert.ok(!/createOrUpdateContact|deleteContact|people\.updateContact|people\.createContact/.test(src), 'must never call a Google Contacts write API');
  assert.ok(!/argv\.includes\(['"]--(apply|enqueue)['"]\)/.test(src), 'must never gate a write action behind a CLI flag');
});
