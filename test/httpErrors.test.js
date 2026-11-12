/* eslint-disable no-undef */
'use strict';

/**
 * httpErrors.test.js — pure unit coverage for lib/httpErrors.js, extracted
 * (November 2026 CRM hardening pass) from routes/sms.js's own
 * logAndRespondUnexpectedError pattern and applied to the 5 routes CLAUDE.md
 * documented as still leaking raw e.message to the client:
 * routes/mergeLeads.js, saleInvoices.js, companySettings.js, invoices.js,
 * leadQB.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const { logAndRespondUnexpectedError } = require('../lib/httpErrors');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('responds 500 with a generic, non-leaking error code — never the raw exception message', () => {
  const res = fakeRes();
  const e = new Error('column "assigned_rep" does not exist');
  e.code = '42703';
  logAndRespondUnexpectedError(e, res, 'test-context');
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error, 'unexpected_error');
  assert.ok(!res.body.message.includes('assigned_rep'), 'the raw Postgres error text must never reach the client');
  assert.ok(!JSON.stringify(res.body).includes('42703'));
});

test('logs full detail (message, code, stack) to console.error for operator diagnosis', () => {
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args); };
  try {
    const e = new Error('duplicate key value violates unique constraint');
    e.code = '23505';
    logAndRespondUnexpectedError(e, fakeRes(), 'invoices:create');
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0][0].includes('invoices:create'));
    assert.strictEqual(calls[0][1].message, 'duplicate key value violates unique constraint');
    assert.strictEqual(calls[0][1].code, '23505');
  } finally {
    console.error = originalError;
  }
});
