/* eslint-disable no-undef */
'use strict';

/**
 * gmailLeadMatch.test.js — pure Gmail <-> Lead matching/direction logic.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  extractAllEmails, normalizeEmailAddr, messageInvolvesLead, classifyDirection, externalRefFor, hasAttachment,
} = require('../lib/gmailLeadMatch');

const COMPANY = 'yaron@ecconstructiongroup.com';
const LEAD = 'brian.krantz@example.com';

test('extractAllEmails pulls every address out of a header with display names and multiple recipients', () => {
  assert.deepStrictEqual(
    extractAllEmails('"Brian Krantz" <brian.krantz@example.com>, Someone Else <someone@x.com>'),
    ['brian.krantz@example.com', 'someone@x.com']
  );
});

test('extractAllEmails returns [] for empty/undefined', () => {
  assert.deepStrictEqual(extractAllEmails(''), []);
  assert.deepStrictEqual(extractAllEmails(undefined), []);
});

test('normalizeEmailAddr lowercases and extracts from a "Display Name <addr>" string', () => {
  assert.strictEqual(normalizeEmailAddr('"Brian Krantz" <Brian.Krantz@Example.com>'), 'brian.krantz@example.com');
  assert.strictEqual(normalizeEmailAddr(null), null);
});

test('messageInvolvesLead is true when the lead email appears in From, To, or Cc', () => {
  assert.strictEqual(messageInvolvesLead({ from: LEAD, to: COMPANY }, LEAD), true);
  assert.strictEqual(messageInvolvesLead({ from: COMPANY, to: LEAD }, LEAD), true);
  assert.strictEqual(messageInvolvesLead({ from: COMPANY, to: 'other@x.com', cc: LEAD }, LEAD), true);
  assert.strictEqual(messageInvolvesLead({ from: 'a@x.com', to: 'b@x.com' }, LEAD), false);
});

test('classifyDirection: company -> lead is outbound', () => {
  assert.strictEqual(classifyDirection({ from: `Yaron <${COMPANY}>`, to: LEAD }, LEAD, COMPANY), 'outbound');
});

test('classifyDirection: lead -> company is inbound', () => {
  assert.strictEqual(classifyDirection({ from: `Brian Krantz <${LEAD}>`, to: COMPANY }, LEAD, COMPANY), 'inbound');
});

test('classifyDirection: lead -> company via Cc still resolves to inbound', () => {
  assert.strictEqual(classifyDirection({ from: LEAD, to: 'someone-else@x.com', cc: COMPANY }, LEAD, COMPANY), 'inbound');
});

test('classifyDirection: a message that does not actually involve the lead returns null (never fabricated)', () => {
  assert.strictEqual(classifyDirection({ from: 'a@x.com', to: 'b@x.com' }, LEAD, COMPANY), null);
});

test('classifyDirection: from is the lead but recipients never include the company still attributes inbound (a group thread), not discarded', () => {
  assert.strictEqual(classifyDirection({ from: LEAD, to: 'friend@x.com' }, LEAD, COMPANY), 'inbound');
});

test('externalRefFor produces a stable, prefixed idempotency key', () => {
  assert.strictEqual(externalRefFor('18c9f2a1b2c3d4e5'), 'gmail:18c9f2a1b2c3d4e5');
  assert.strictEqual(externalRefFor('18c9f2a1b2c3d4e5'), externalRefFor('18c9f2a1b2c3d4e5'));
});

test('hasAttachment detects a named filename part, ignores body-only parts', () => {
  assert.strictEqual(hasAttachment({ parts: [{ mimeType: 'text/plain' }, { filename: 'invoice.pdf' }] }), true);
  assert.strictEqual(hasAttachment({ parts: [{ mimeType: 'text/plain' }] }), false);
  assert.strictEqual(hasAttachment({}), false);
});
