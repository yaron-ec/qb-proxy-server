/* eslint-disable no-undef */
'use strict';

/**
 * businessHoursConfig.test.js — PRODUCTIZATION PHASE 2: proves
 * company_settings.business_hours is actually CONSUMED by the availability
 * slot grid, not just stored/round-tripped (routes/companySettings.js).
 *
 * lib/booking/slotBlocking.js#computeSlots generates the ]start,end] 30-min
 * grid for arbitrary business hours; lib/booking/availabilityService.js's
 * getEffectiveSlots() reads company_settings.business_hours (via
 * lib/companyConfig.js) and falls back to the product-default SLOTS grid
 * (08:30 AM-6:30 PM, EC's exact historical behavior) when unconfigured or
 * malformed.
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeSlots, SLOTS, DEFAULT_BUSINESS_HOURS } = require('../lib/booking/slotBlocking');

test('computeSlots reproduces the exact historical 08:30-18:30 default grid', () => {
  assert.deepStrictEqual(computeSlots(DEFAULT_BUSINESS_HOURS.start, DEFAULT_BUSINESS_HOURS.end), SLOTS);
  assert.strictEqual(SLOTS[0], '08:30');
  assert.strictEqual(SLOTS[SLOTS.length - 1], '18:30');
  assert.strictEqual(SLOTS.length, 21);
});

test('computeSlots produces a genuinely different grid for different business hours', () => {
  const shortDay = computeSlots('09:00', '12:00');
  assert.deepStrictEqual(shortDay, ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00']);
  assert.notDeepStrictEqual(shortDay, SLOTS);
});

let rowToReturn = null;
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT id, start_at, end_at, timezone/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM company_settings/i.test(s)) return { rows: rowToReturn ? [rowToReturn] : [] };
      // Meeting Follow-Ups as an additional busy source (PERMANENT RULE) —
      // none in this test's fixtures.
      if (/^SELECT l\.id, l\.follow_up_date/i.test(s)) return { rows: [] };
      throw new Error('unexpected query in mock: ' + s);
    },
    pool: {}, ensureSchema: async () => {},
  },
};
const googleAvailabilityPath = require.resolve('../lib/booking/googleAvailability');
delete require.cache[googleAvailabilityPath];
require.cache[googleAvailabilityPath] = {
  id: googleAvailabilityPath, filename: googleAvailabilityPath, loaded: true,
  exports: { getGoogleBusyWindows: async () => [] },
};
delete require.cache[require.resolve('../lib/companyConfig')];
delete require.cache[require.resolve('../lib/booking/availabilityService')];
const companyConfig = require('../lib/companyConfig');
const { getAvailability } = require('../lib/booking/availabilityService');

const DATE = '2026-09-24';
const TZ = 'America/Los_Angeles';

test.beforeEach(() => { companyConfig.invalidate(); });

test('getAvailability falls back to the default grid when business_hours is unconfigured', async () => {
  rowToReturn = null;
  const av = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.deepStrictEqual(av.slots, SLOTS);
});

test('getAvailability uses the installation\'s configured business_hours grid, not the EC default', async () => {
  rowToReturn = { business_hours: { start: '09:00', end: '12:00' } };
  const av = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.deepStrictEqual(av.slots, ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00']);
  assert.notDeepStrictEqual(av.slots, SLOTS);
});

test('getAvailability falls back to the default grid on a malformed business_hours value (never throws, never silently narrows hours)', async () => {
  rowToReturn = { business_hours: { start: 'not-a-time', end: '12:00' } };
  const av = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.deepStrictEqual(av.slots, SLOTS);

  companyConfig.invalidate();
  rowToReturn = { business_hours: {} };
  const av2 = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.deepStrictEqual(av2.slots, SLOTS);
});
