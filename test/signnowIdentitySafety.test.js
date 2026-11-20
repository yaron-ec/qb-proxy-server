/* eslint-disable no-undef */
'use strict';

/**
 * signnowIdentitySafety.test.js — pure unit coverage for
 * lib/signnowFieldMapping.js#findIdentityRisks (November 2026 production
 * incident fix: a Notice of Completion prepared for Ali & Mohemmed Lalani
 * displayed a PRIOR customer's name/address/job description instead).
 *
 * Root cause: `POST /template/{id}/copy` always returns a genuinely new
 * document id with the current lead's own recipient — this was never a
 * "reused document id" bug. The real defect is that a SignNow TEMPLATE
 * made from an already-filled document carries that prior document's field
 * VALUES into every copy, and nothing in this codebase ever inspected a
 * field's current value before this fix (lib/signnowClient.js#getDocumentFields
 * used to return only {name, type, id} — see test below).
 */
const test = require('node:test');
const assert = require('node:assert');
const fieldMapping = require('../lib/signnowFieldMapping');

test('findIdentityRisks: an unmapped field with pre-existing non-blank content is flagged unmapped_content', () => {
  const mappings = [{ signnow_field_name: 'customer_name', crm_source: 'lead_full_name' }];
  const resolved = [{ signnow_field_name: 'customer_name', value: 'Ali Lalani' }];
  const liveFields = [
    { name: 'customer_name', value: 'Ali Lalani' },
    { name: 'completion_date', value: '08/09/2026' }, // never mapped, yet already has a value
    { name: 'job_description', value: 'Driveway pavers, Epoxy and painting' }, // same
  ];
  const risks = fieldMapping.findIdentityRisks(mappings, resolved, liveFields);
  assert.strictEqual(risks.length, 2);
  assert.ok(risks.every((r) => r.kind === 'unmapped_content'));
  assert.ok(risks.some((r) => r.field_name === 'completion_date' && r.current === '08/09/2026'));
  assert.ok(risks.some((r) => r.field_name === 'job_description' && r.current === 'Driveway pavers, Epoxy and painting'));
});

test('findIdentityRisks: a mapped field whose live value disagrees with the resolved CRM value is flagged mismatch', () => {
  const mappings = [{ signnow_field_name: 'customer_name', crm_source: 'lead_full_name' }];
  const resolved = [{ signnow_field_name: 'customer_name', value: 'Ali Lalani' }];
  const liveFields = [{ name: 'customer_name', value: 'Joann D Gregg' }]; // prefill never overwrote the stale default
  const risks = fieldMapping.findIdentityRisks(mappings, resolved, liveFields);
  assert.strictEqual(risks.length, 1);
  assert.strictEqual(risks[0].kind, 'mismatch');
  assert.strictEqual(risks[0].expected, 'Ali Lalani');
  assert.strictEqual(risks[0].current, 'Joann D Gregg');
});

test('findIdentityRisks: a clean document (every field blank, or mapped and matching) has zero risks', () => {
  const mappings = [{ signnow_field_name: 'customer_name', crm_source: 'lead_full_name' }];
  const resolved = [{ signnow_field_name: 'customer_name', value: 'Ali Lalani' }];
  const liveFields = [
    { name: 'customer_name', value: 'Ali Lalani' },
    { name: 'blank_unmapped_field', value: '' },
    { name: 'null_unmapped_field', value: null },
  ];
  assert.deepStrictEqual(fieldMapping.findIdentityRisks(mappings, resolved, liveFields), []);
});

test('findIdentityRisks: a template with zero configured mappings flags every non-blank field as unmapped_content', () => {
  const liveFields = [{ name: 'anything', value: 'leftover text' }];
  const risks = fieldMapping.findIdentityRisks([], [], liveFields);
  assert.strictEqual(risks.length, 1);
  assert.strictEqual(risks[0].kind, 'unmapped_content');
});

test('findIdentityRisks: an optional mapped field that resolved empty is never flagged just because the live field is also blank', () => {
  const mappings = [{ signnow_field_name: 'optional_field', crm_source: 'deal_amount' }];
  const resolved = [{ signnow_field_name: 'optional_field', value: '' }];
  const liveFields = [{ name: 'optional_field', value: '' }];
  assert.deepStrictEqual(fieldMapping.findIdentityRisks(mappings, resolved, liveFields), []);
});

test('findIdentityRisks: whitespace-only live content is treated as blank (never a false-positive risk)', () => {
  const liveFields = [{ name: 'unmapped', value: '   ' }];
  assert.deepStrictEqual(fieldMapping.findIdentityRisks([], [], liveFields), []);
});

// ── lib/signnowClient.js#getDocumentFields now surfaces each field's VALUE ──
test('getDocumentFields extracts a field value from the known SignNow response shapes (source-level, no live API)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signnowClient.js'), 'utf8');
  assert.match(src, /value: f\.prefilled_text/, 'getDocumentFields must extract each field\'s current value, not just its name/type — this is what makes stale template content detectable at all');
});
