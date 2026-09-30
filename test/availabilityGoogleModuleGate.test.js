/* eslint-disable no-undef */
'use strict';

/**
 * availabilityGoogleModuleGate.test.js — PRODUCTIZATION: proves a critical bug
 * fix. Before this fix, lib/booking/availabilityService.js#getAvailability
 * treated "google_calendar is disabled for this installation" identically to
 * "Google Calendar is temporarily unreachable" — both threw
 * CalendarUnavailableError (503). For EC (google_calendar always enabled)
 * that's correct and must stay unchanged. For any installation that simply
 * doesn't use Google Calendar, it meant EVERY availability check 503'd
 * forever — booking completely broken, not just missing an integration.
 *
 * Fixed: getAvailability checks isModuleEnabled('google_calendar') BEFORE
 * attempting the Google read. Disabled -> proceed CRM-only (zero external
 * windows, never throws). Enabled and the read genuinely fails -> unchanged
 * fail-closed 503 (see test/googleAvailability.test.js#10 for the underlying
 * combineBusyWindows contract, untouched by this fix).
 */
const test = require('node:test');
const assert = require('node:assert');

let isModuleEnabledImpl = async () => true;
let googleBusyWindowsImpl = async () => { throw new Error('Calendar list 500'); };
let appointmentRows = [];

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT id, start_at, end_at, timezone/i.test(s)) return { rows: appointmentRows };
      throw new Error('unexpected query in mock: ' + s);
    },
    pool: {}, ensureSchema: async () => {},
  },
};

const companyConfigPath = require.resolve('../lib/companyConfig');
delete require.cache[companyConfigPath];
require.cache[companyConfigPath] = {
  id: companyConfigPath, filename: companyConfigPath, loaded: true,
  exports: {
    isModuleEnabled: (...a) => isModuleEnabledImpl(...a),
    getCompanyConfig: async () => ({ business_hours: null }),
  },
};

const googleAvailabilityPath = require.resolve('../lib/booking/googleAvailability');
delete require.cache[googleAvailabilityPath];
require.cache[googleAvailabilityPath] = {
  id: googleAvailabilityPath, filename: googleAvailabilityPath, loaded: true,
  exports: { getGoogleBusyWindows: (...a) => googleBusyWindowsImpl(...a) },
};

delete require.cache[require.resolve('../lib/booking/availabilityService')];
const { getAvailability, CalendarUnavailableError, getGoogleConflictWindows } = require('../lib/booking/availabilityService');

const DATE = '2026-09-24';
const TZ = 'America/Los_Angeles';

test('google_calendar ENABLED + Google read fails: still throws CalendarUnavailableError (EC\'s exact preserved behavior)', async () => {
  isModuleEnabledImpl = async () => true;
  googleBusyWindowsImpl = async () => { throw new Error('Calendar list 500'); };
  await assert.rejects(
    () => getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 }),
    CalendarUnavailableError,
  );
});

test('google_calendar DISABLED: never even calls Google, returns normally, CRM-only', async () => {
  isModuleEnabledImpl = async () => false;
  let googleCalled = false;
  googleBusyWindowsImpl = async () => { googleCalled = true; throw new Error('should never be called'); };
  const av = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.strictEqual(googleCalled, false, 'Google must never be called when the module is disabled');
  assert.deepStrictEqual(av.blocked_slots, []);
});

test('google_calendar DISABLED but a real CRM appointment exists: still blocks (CRM check remains authoritative)', async () => {
  isModuleEnabledImpl = async () => false;
  const { toUtcIso } = require('../lib/booking/slotBlocking');
  appointmentRows = [{
    id: 'appt-1', start_at: toUtcIso(DATE, '12:00', TZ), end_at: toUtcIso(DATE, '13:00', TZ), timezone: TZ,
    busy_start: toUtcIso(DATE, '11:00', TZ), busy_end: toUtcIso(DATE, '14:00', TZ),
  }];
  const av = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.ok(av.blocked_slots.includes('12:00'), 'the real CRM appointment still blocks its own slot');
  appointmentRows = [];
});

test('getGoogleConflictWindows: disabled module never attempts the call, returns []', async () => {
  isModuleEnabledImpl = async () => false;
  let called = false;
  googleBusyWindowsImpl = async () => { called = true; return []; };
  const windows = await getGoogleConflictWindows({ start: new Date(), end: new Date(Date.now() + 3600000), timezone: TZ });
  assert.deepStrictEqual(windows, []);
  assert.strictEqual(called, false, 'must never attempt the Google call when disabled');
});
