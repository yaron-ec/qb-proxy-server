'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../lib/transportControl');
test('flowTransport defaults to base44 when no env set', () => {
  for (const f of tc.FLOWS) { delete process.env['EMAIL_'+f+'_TRANSPORT']; }
  delete process.env.EMAIL_TRANSPORT;
  for (const f of tc.FLOWS) { assert.equal(tc.flowTransport(f), 'base44', f+' should default to base44'); }
});
test('per-flow railway override is respected and isolated', () => {
  process.env.EMAIL_INVOICE_TRANSPORT = 'railway';
  assert.equal(tc.flowTransport('INVOICE'), 'railway');
  assert.equal(tc.flowTransport('GENERIC'), 'base44', 'other flows unaffected');
  delete process.env.EMAIL_INVOICE_TRANSPORT;
});
test('invalid value falls back to base44', () => {
  process.env.EMAIL_GENERIC_TRANSPORT = 'bogus';
  assert.equal(tc.flowTransport('GENERIC'), 'base44');
  delete process.env.EMAIL_GENERIC_TRANSPORT;
});
