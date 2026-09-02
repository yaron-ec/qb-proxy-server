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

// Stub db.client AND crmRepository so the engine can run without a live
// Postgres connection. crmRepository.listEligibleLeads() calls db.query()
// internally, but the db stub's query() may not propagate to all internal
// require paths — stubbing crmRepository directly guarantees no DB access.
const Module = require('module');
const dbStub = { ensureSchema: async () => {}, query: async () => ({ rows: [] }) };
const crmStub = {
  listEligibleLeads: async () => [],
  writeReminderSentActivity: async () => {},
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === '../db/client' && parent && parent.filename && parent.filename.includes('phoneCallReminders')) {
    return req;
  }
  return origResolve.call(this, req, parent, ...rest);
};
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
const crmPath = require.resolve('../lib/crmRepository');
delete require.cache[crmPath];
require.cache[crmPath] = { id: crmPath, filename: crmPath, loaded: true, exports: crmStub };

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

// Transport gate always resolves to 'railway' — Base44 is fully decommissioned
// (lib/transportControl.js flowTransport() unconditionally returns 'railway').
// The old tests expected { skipped: true, reason: 'phone_transport_base44' }
// when EMAIL_PHONE_CALL_REMINDER_TRANSPORT='base44', but that code path no
// longer exists. The engine now always runs the Railway path. With the mock
// DB returning empty rows, no leads are eligible so no emails are sent.

test('dry-run mode returns ok with empty stats (no leads in mock DB)', async () => {
  const r = await phone.processPhoneCallReminders({ dryRun: true, triggeredBy: 'test' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, true);
  assert.ok(r.stats, 'stats object present');
  assert.strictEqual(r.stats.scanned, 0, 'no leads scanned from empty mock DB');
  assert.strictEqual(r.stats.sent, 0, 'no emails sent in dry-run');
});

test('live mode returns ok with zero sends (no leads in mock DB)', async () => {
  const r = await phone.processPhoneCallReminders({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, false);
  assert.ok(r.stats, 'stats object present');
  assert.strictEqual(r.stats.scanned, 0, 'no leads scanned from empty mock DB');
  assert.strictEqual(r.stats.sent, 0, 'no emails sent with no eligible leads');
});