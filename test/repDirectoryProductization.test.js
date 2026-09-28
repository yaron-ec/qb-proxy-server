/* eslint-disable no-undef */
'use strict';

/**
 * repDirectoryProductization.test.js — regression coverage for the
 * PRODUCTIZATION FOUNDATION change to lib/repDirectory.js.
 *
 * The critical invariant: getRepContact() (the ONLY function
 * lib/leadIngest.js calls, and it calls it synchronously, without await)
 * must remain byte-for-byte behaviorally identical to before this file
 * learned about lib/companyConfig.js — otherwise every lead ingested would
 * silently get `assigned_rep_name: undefined`, `assigned_rep_email:
 * undefined`, `assigned_rep_phone: undefined` (destructuring off an
 * un-awaited Promise). This file proves that never regresses, and that the
 * new async variant correctly uses a configured company domain instead.
 */
const test = require('node:test');
const assert = require('node:assert');

const dbPath = require.resolve('../db/client');
let queryImpl = async () => ({ rows: [] });
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (...a) => queryImpl(...a) } };

const repDir = require('../lib/repDirectory');
const companyConfig = require('../lib/companyConfig');

test('getRepContact() is synchronous — returns a plain object immediately, never a Promise', () => {
  const result = repDir.getRepContact('Yaron Drilevich');
  assert.strictEqual(result instanceof Promise, false, 'lib/leadIngest.js does not await this — it must never become a Promise');
  assert.strictEqual(typeof result.name, 'string');
});

test('getRepContact(): unchanged fallback domain/name for an unrecognized rep', () => {
  const r = repDir.getRepContact('Someone New');
  assert.strictEqual(r.email, 'someone@ecconstructiongroup.com');
  assert.strictEqual(r.officeEmail, 'office@ecconstructiongroup.com');
  assert.strictEqual(r.directPhone, repDir.OFFICE_PHONE);
});

test('getRepContact(): no rep name falls back to the historical literal company name', () => {
  const r = repDir.getRepContact(null);
  assert.strictEqual(r.name, 'EC Construction Group');
  assert.strictEqual(r.email, 'office@ecconstructiongroup.com');
});

test('the leadIngest.js call-site pattern (no await) still destructures real values, not undefined', () => {
  // Mirrors lib/leadIngest.js line: const _rep = repDir.getRepContact(lead.assigned_rep);
  const _rep = repDir.getRepContact('Michelle Roitman Drilevich');
  const assigned_rep_name = _rep.name;
  const assigned_rep_email = _rep.email;
  const assigned_rep_phone = _rep.directPhone;
  assert.notStrictEqual(assigned_rep_name, undefined);
  assert.notStrictEqual(assigned_rep_email, undefined);
  assert.notStrictEqual(assigned_rep_phone, undefined);
  assert.strictEqual(assigned_rep_name, 'Michelle Roitman Drilevich');
});

test('getRepContactAsync(): uses the configured company_email domain when Company Settings is set', async () => {
  companyConfig.invalidate();
  queryImpl = async () => ({ rows: [{ company_email: 'hello@acme.example', company_name: 'Acme Remodeling' }] });
  const r = await repDir.getRepContactAsync('Jordan Rep');
  assert.strictEqual(r.email, 'jordan@acme.example');
  assert.strictEqual(r.officeEmail, 'office@acme.example');
});

test('getRepContactAsync(): falls back to the historical EC domain when nothing is configured (unbootstrapped DB)', async () => {
  companyConfig.invalidate();
  queryImpl = async () => ({ rows: [] });
  const r = await repDir.getRepContactAsync('Jordan Rep');
  assert.strictEqual(r.email, 'jordan@ecconstructiongroup.com');
});
