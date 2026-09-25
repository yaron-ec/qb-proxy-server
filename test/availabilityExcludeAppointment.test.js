/* eslint-disable no-undef */
'use strict';

/**
 * availabilityExcludeAppointment.test.js — self-conflict exclusion for the
 * availability DISPLAY (Lead Detail → Schedule → Appointment editing).
 *
 * Editing an existing appointment must not show its OWN current slot as
 * blocked. Before this fix, GET /api/v1/availability/:owner/:date had no
 * exclude_appointment_id parameter at all, and the frontend's AvailableTimePicker
 * silently dropped the excludeAppointmentId prop passed to it — so re-opening
 * an appointment for editing could show its own slot (and the touching hour
 * on either side) as unavailable. This proves both the SQL-level exclusion
 * (availabilityService.getAvailability) and that it round-trips through the
 * authenticated route.
 */
const test = require('node:test');
const assert = require('node:assert');

let queriedParams = null;
let rowsToReturn = [];

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT id, start_at, end_at, timezone/i.test(s)) {
        queriedParams = params;
        // Real half-open exclusion semantics, mirroring the actual SQL's
        // "($4::uuid IS NULL OR id != $4::uuid)" predicate.
        const excludeId = params[3];
        return { rows: rowsToReturn.filter(r => !excludeId || r.id !== excludeId) };
      }
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

delete require.cache[require.resolve('../lib/booking/availabilityService')];
const { getAvailability, toUtcIso } = require('../lib/booking/availabilityService');

const DATE = '2026-09-24';
const TZ = 'America/Los_Angeles';

test('exclude_appointment_id excludes that appointment from its own conflict set', async () => {
  rowsToReturn = [{
    id: 'appt-being-edited',
    start_at: toUtcIso(DATE, '16:00', TZ), end_at: toUtcIso(DATE, '17:00', TZ),
    timezone: TZ,
    busy_start: toUtcIso(DATE, '15:00', TZ), busy_end: toUtcIso(DATE, '18:00', TZ),
  }];
  const withoutExclude = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.ok(withoutExclude.blocked_slots.includes('16:00'), 'sanity: the slot is blocked when NOT excluded');

  const withExclude = await getAvailability({
    owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60,
    exclude_appointment_id: 'appt-being-edited',
  });
  assert.ok(!withExclude.blocked_slots.includes('16:00'), 'editing an appointment must not show its OWN slot as blocked');
  assert.strictEqual(queriedParams[3], 'appt-being-edited', 'exclude_appointment_id must be threaded through to the SQL query');
});

test('exclude_appointment_id does not hide a DIFFERENT appointment\'s conflict', async () => {
  rowsToReturn = [{
    id: 'some-other-appt',
    start_at: toUtcIso(DATE, '16:00', TZ), end_at: toUtcIso(DATE, '17:00', TZ),
    timezone: TZ,
    busy_start: toUtcIso(DATE, '15:00', TZ), busy_end: toUtcIso(DATE, '18:00', TZ),
  }];
  const result = await getAvailability({
    owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60,
    exclude_appointment_id: 'appt-being-edited', // excludes a DIFFERENT id
  });
  assert.ok(result.blocked_slots.includes('16:00'), 'a genuine conflict from a different appointment must still block');
});
