/* eslint-disable no-undef */
/**
 * phoneCallReminders.test.js — Railway phone-call reminder engine.
 *
 * Verifies (no real email, default base44 gate -> no sends):
 *   - PHONE_WINDOWS shape (1h, 30min)
 *   - phoneKey idempotency shape
 *   - getCallMs ignores Meetings and missing fields
 *   - transport gate base44 => skipped, sends nothing
 *
 * Run: cd src/proxy-server && node --test test/phoneCallReminders.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Stub db.client so the engine can require it without a live Postgres.
const Module = require('module');
const dbStub = { ensureSchema: async () => {}, query: async () => ({ rows: [] }) };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === '../db/client' && parent && parent.filename && parent.filename.includes('phoneCallReminders')) {
    return req; // let it resolve; we override load below
  }
  return origResolve.call(this, req, parent, ...rest);
};
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

process.env.EMAIL_PHONE_CALL_REMINDER_TRANSPORT = 'base44'; // default gate
const phone = require('../lib/phoneCallReminders');

test('PHONE_WINDOWS = 1h + 30min', () => {
  assert.deepStrictEqual(phone.PHONE_WINDOWS.map(w => w.key), ['1h', '30min']);
});

test('phoneKey is deterministic', () => {
  assert.strictEqual(phone.phoneKey('l1', '1h', '2026-08-03'), 'phone_reminder:l1:1h:2026-08-03');
  assert.strictEqual(phone.phoneKey('l1', '1h', '2026-08-03'), phone.phoneKey('l1', '1h', '2026-08-03'));
});

test('getCallMs ignores Meetings', () => {
  assert.strictEqual(phone.getCallMs({ follow_up_type: 'Meeting', follow_up_date: '2026-08-03', follow_up_time: '09:00' }), null);
});

test('getCallMs null when date/time missing', () => {
  assert.strictEqual(phone.getCallMs({ follow_up_type: 'Phone Call' }), null);
  assert.strictEqual(phone.getCallMs({ follow_up_type: 'Phone Call', follow_up_date: '2026-08-03' }), null);
});

test('getCallMs returns object for Phone Call', () => {
  const r = phone.getCallMs({ follow_up_type: 'Phone Call', follow_up_date: '2026-08-03', follow_up_time: '14:30' });
  assert.ok(r && typeof r.ms === 'number' && r.date === '2026-08-03' && r.time === '14:30');
});

test('transport gate base44 => skipped, no sends', async () => {
  process.env.EMAIL_PHONE_CALL_REMINDER_TRANSPORT = 'base44';
  const r = await phone.processPhoneCallReminders({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'phone_transport_base44');
});

test('dry-run under railway gate does not send (gate stays base44 => skip first)', async () => {
  process.env.EMAIL_PHONE_CALL_REMINDER_TRANSPORT = 'base44';
  const r = await phone.processPhoneCallReminders({ dryRun: true, triggeredBy: 'test' });
  assert.strictEqual(r.skipped, true);
});