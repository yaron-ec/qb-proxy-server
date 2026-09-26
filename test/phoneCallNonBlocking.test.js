/* eslint-disable no-undef */
'use strict';

/**
 * phoneCallNonBlocking.test.js — PRODUCTION DEFECT: a calendar entry for a
 * Phone Call was being treated as a blocking appointment (and, via the
 * write-path Google conflict check added in the availability-parity fix,
 * could newly reject bookings near it too).
 *
 * CANONICAL RULE: a Phone Call is a reminder/activity, never an Appointment/
 * Site Visit. It must never block availability, never receive the 1hr
 * buffer, never generate Driving/Travel Time, and never participate in
 * conflict detection — a real Appointment may freely overlap one, even at
 * the exact same time.
 *
 * CANONICAL DISTINCTION (matches lib/booking/appointmentKind.js — the SAME
 * rule already used to pick the calendar event summary and whether to build
 * a travel event, extended here to the availability/conflict queries and to
 * Google Calendar read-back):
 *   Meeting:     lower(busy_range) < start_at   (busy_range buffered -1h)
 *   Phone Call:  lower(busy_range) = start_at   (busy_range unbuffered)
 *
 * ROOT CAUSE (two places):
 *   1. lib/booking/availabilityService.js's CRM appointments query and
 *      lib/booking/appointmentWriter.js's conflict-check query included
 *      Phone Call rows as busy windows / conflicts — they only skipped the
 *      BUFFER, never excluded the Phone Call's own slot entirely.
 *   2. lib/booking/googleAvailability.js read every CRM-created Phone Call's
 *      Google Calendar "main" event back and buffered it 1hr each side like
 *      a Meeting — nothing distinguished a Phone Call's main event from a
 *      Meeting's (both used ec_kind:'main').
 *
 * FIX: both SQL queries add `AND lower(busy_range) < start_at`; Phone Call
 * main events are now tagged extendedProperties.private.ec_appointment_kind
 * = 'phone_call', and googleAvailability.js's isExcluded() fully excludes
 * them (not just skips their buffer).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { toUtcIso } = require('../lib/booking/slotBlocking');
const { isExcluded, eventToBusyWindow } = require('../lib/booking/googleAvailability');

const DATE = '2026-09-24';
const TZ = 'America/Los_Angeles';

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: Google Calendar read-back — isExcluded / eventToBusyWindow
// ═══════════════════════════════════════════════════════════════════════

test('1. A Phone Call main event (ec_appointment_kind=phone_call) is fully excluded from Google busy windows', () => {
  const event = {
    id: 'ev1', status: 'confirmed',
    start: { dateTime: '2026-09-24T18:00:00-07:00' }, end: { dateTime: '2026-09-24T18:30:00-07:00' },
    extendedProperties: { private: { ec_kind: 'main', ec_appointment_kind: 'phone_call' } },
  };
  assert.strictEqual(isExcluded(event), true);
});

test('1b. A real Meeting main event (ec_appointment_kind=meeting) is NOT excluded — still buffered/blocking', () => {
  const event = {
    id: 'ev2', status: 'confirmed',
    start: { dateTime: '2026-09-24T18:00:00-07:00' }, end: { dateTime: '2026-09-24T19:00:00-07:00' },
    extendedProperties: { private: { ec_kind: 'main', ec_appointment_kind: 'meeting' } },
  };
  assert.strictEqual(isExcluded(event), false);
  const w = eventToBusyWindow(event, TZ);
  assert.ok(w, 'a real Meeting still produces a busy window');
});

test('1c. A genuine external Google event (no CRM extendedProperties at all) is still buffered/blocking — unrelated events unaffected', () => {
  const event = {
    id: 'ev3', status: 'confirmed',
    start: { dateTime: '2026-09-24T20:00:00-07:00' }, end: { dateTime: '2026-09-24T21:00:00-07:00' },
  };
  assert.strictEqual(isExcluded(event), false);
});

test('1d. CRM travel artifacts remain excluded (pre-existing behavior, unaffected)', () => {
  const event = {
    id: 'ev4', status: 'confirmed',
    start: { dateTime: '2026-09-24T19:00:00-07:00' }, end: { dateTime: '2026-09-24T20:00:00-07:00' },
    extendedProperties: { private: { ec_kind: 'travel' } },
  };
  assert.strictEqual(isExcluded(event), true);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: calendarOutbox.buildOperation tags the canonical marker
// ═══════════════════════════════════════════════════════════════════════

test('2. buildOperation tags a Phone Call appointment\'s main event with ec_appointment_kind=phone_call', () => {
  const { buildOperation } = require('../lib/booking/calendarOutbox');
  // Phone Call: busy_range lower === start_at (no buffer) — the canonical shape.
  const start = toUtcIso(DATE, '10:00', TZ);
  const end = toUtcIso(DATE, '10:30', TZ);
  const appt = {
    id: 'appt-pc-1', start_at: start, end_at: end, timezone: TZ, version: 1,
    busy_range: `["${start}","${end}")`,
  };
  const op = buildOperation(appt, { first_name: 'Brian', last_name: 'Krantz' }, 'yaron@ecconstructiongroup.com', 'main');
  assert.strictEqual(op.body.extendedProperties.private.ec_appointment_kind, 'phone_call');
  assert.strictEqual(op.body.summary, 'Phone Call with Brian Krantz');
});

test('2b. buildOperation tags a real Meeting\'s main event with ec_appointment_kind=meeting', () => {
  const { buildOperation } = require('../lib/booking/calendarOutbox');
  const start = toUtcIso(DATE, '10:00', TZ);
  const end = toUtcIso(DATE, '11:00', TZ);
  const bufferedStart = new Date(new Date(start).getTime() - 60 * 60 * 1000).toISOString();
  const bufferedEnd = new Date(new Date(end).getTime() + 60 * 60 * 1000).toISOString();
  const appt = {
    id: 'appt-mtg-1', start_at: start, end_at: end, timezone: TZ, version: 1,
    busy_range: `["${bufferedStart}","${bufferedEnd}")`,
  };
  const op = buildOperation(appt, { first_name: 'Brian', last_name: 'Krantz' }, 'yaron@ecconstructiongroup.com', 'main');
  assert.strictEqual(op.body.extendedProperties.private.ec_appointment_kind, 'meeting');
  assert.strictEqual(op.body.summary, 'Meeting with Brian Krantz');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: getAvailability() — CRM query excludes Phone Calls entirely
// ═══════════════════════════════════════════════════════════════════════

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
        assert.ok(/lower\(busy_range\) < start_at/.test(s), 'the query must filter to Meetings only (lower(busy_range) < start_at)');
        // Faithfully replicate the real predicate against the fixture rows.
        return { rows: rowsToReturn.filter(r => new Date(r.busy_start).getTime() < new Date(r.start_at).getTime()) };
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
const { getAvailability } = require('../lib/booking/availabilityService');

test('3. A Phone Call at 10:00 AM does NOT make 10:00 unavailable for a real appointment', async () => {
  rowsToReturn = [{
    id: 'appt-pc', start_at: toUtcIso(DATE, '10:00', TZ), end_at: toUtcIso(DATE, '10:30', TZ), timezone: TZ,
    busy_start: toUtcIso(DATE, '10:00', TZ), busy_end: toUtcIso(DATE, '10:30', TZ), // no buffer — Phone Call
  }];
  const result = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.ok(!result.blocked_slots.includes('10:00'), 'a Phone Call must never block its own slot for a real appointment');
  assert.deepStrictEqual(result.blocked_slots, []);
});

test('3b. A real Meeting at 10:00 AM DOES still make 10:00 unavailable — no regression', async () => {
  rowsToReturn = [{
    id: 'appt-mtg', start_at: toUtcIso(DATE, '10:00', TZ), end_at: toUtcIso(DATE, '11:00', TZ), timezone: TZ,
    busy_start: toUtcIso(DATE, '09:00', TZ), busy_end: toUtcIso(DATE, '12:00', TZ), // buffered — Meeting
  }];
  const result = await getAvailability({ owner_id: 'owner-1', date: DATE, timezone: TZ, duration_minutes: 60 });
  assert.ok(result.blocked_slots.includes('10:00'), 'a real Meeting must still block its slot — Phone Call fix must not weaken this');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: createBooking() write path — Phone Call never conflicts,
// real Appointment MAY overlap it exactly
// ═══════════════════════════════════════════════════════════════════════

let existingAppointments;
function resetFixture() { existingAppointments = []; }
resetFixture();

function makeClient() {
  return {
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^BEGIN$/i.test(s) || /^COMMIT$/i.test(s) || /^ROLLBACK$/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM booking_idempotency/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM owners WHERE id = \$1/i.test(s)) return { rows: [{ id: 'owner-1', email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich' }] };
      if (/^INSERT INTO leads/i.test(s)) return { rows: [{ id: 'lead-1' }] };
      if (/pg_advisory_xact_lock/i.test(s)) return { rows: [] };
      if (/^SELECT id, override_authorized/i.test(s)) {
        assert.ok(/lower\(busy_range\) < start_at/.test(s), 'the write-path conflict query must filter to Meetings only');
        const [, excludeId, candStart, candEnd] = params;
        const conflicts = existingAppointments.filter(a =>
          a.id !== excludeId &&
          new Date(a.busy_start).getTime() < new Date(a.start_at).getTime() && // only Meetings can conflict
          new Date(candStart) < new Date(a.busy_end) &&
          new Date(a.busy_start) < new Date(candEnd)
        );
        return { rows: conflicts.map(a => ({ id: a.id, override_authorized: false, override_authorized_by: null })) };
      }
      if (/^INSERT INTO appointments/i.test(s)) return { rows: [{ id: 'new-appt-1', start_at: params[3], end_at: params[4], status: 'scheduled' }] };
      if (/^INSERT INTO appointment_events/i.test(s)) return { rows: [] };
      if (/^INSERT INTO booking_idempotency/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM leads WHERE id = \$1/i.test(s)) return { rows: [{ id: params[0] }] };
      throw new Error('mock client: unrecognized query: ' + s);
    },
    release: () => {},
  };
}

delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: { connect: async () => makeClient() }, ensureSchema: async () => {}, query: async () => ({ rows: [] }) },
};
const leadResolutionPath = require.resolve('../lib/booking/leadResolution');
delete require.cache[leadResolutionPath];
require.cache[leadResolutionPath] = {
  id: leadResolutionPath, filename: leadResolutionPath, loaded: true,
  exports: { resolveLead: async () => ({ action: 'create' }), lockLeadIdentity: async () => [] },
};
const calendarOutboxRealPath = require.resolve('../lib/booking/calendarOutbox');
const realCalendarOutbox = require(calendarOutboxRealPath);
let lastEnqueueCreateArgs = null;
delete require.cache[calendarOutboxRealPath];
require.cache[calendarOutboxRealPath] = {
  id: calendarOutboxRealPath, filename: calendarOutboxRealPath, loaded: true,
  exports: {
    ...realCalendarOutbox,
    enqueueCreate: async (client, appt, lead, ownerEmail, skipTravel) => { lastEnqueueCreateArgs = { skipTravel }; },
    enqueueCancel: async () => {}, enqueueUpdate: async () => {},
  },
};
const addressPipelinePath = require.resolve('../lib/addressPipeline');
delete require.cache[addressPipelinePath];
require.cache[addressPipelinePath] = {
  id: addressPipelinePath, filename: addressPipelinePath, loaded: true,
  exports: { processAddress: async (a) => a, ensureAddressColumns: async () => {}, buildAddressFieldMap: () => null },
};
const appointmentTypesPath = require.resolve('../lib/booking/appointmentTypes');
delete require.cache[appointmentTypesPath];
require.cache[appointmentTypesPath] = {
  id: appointmentTypesPath, filename: appointmentTypesPath, loaded: true,
  exports: {
    getType: async () => ({ id: 'type-1', name: 'Consultation', default_duration_minutes: 60 }),
    resolveDuration: (type, override) => (override != null ? Number(override) : (type ? type.default_duration_minutes : 60)),
    validateDurationOverride: () => {},
  },
};
const availabilityServicePath = require.resolve('../lib/booking/availabilityService');
const realAvailabilityService = require(availabilityServicePath);
delete require.cache[availabilityServicePath];
require.cache[availabilityServicePath] = {
  id: availabilityServicePath, filename: availabilityServicePath, loaded: true,
  exports: { ...realAvailabilityService, getGoogleConflictWindows: async () => [] },
};
delete require.cache[require.resolve('../lib/booking/bookingService')];

test('4. TEST 2 FROM SPEC: a real Appointment at 10:00 AM succeeds while a Phone Call exists at 10:00 AM', async () => {
  resetFixture();
  existingAppointments = [{
    id: 'existing-phonecall', start_at: toUtcIso(DATE, '10:00', TZ), busy_start: toUtcIso(DATE, '10:00', TZ), busy_end: toUtcIso(DATE, '10:30', TZ),
  }];
  const { createBooking } = require('../lib/booking/bookingService');
  const result = await createBooking({
    idempotency_key: `k-${Math.random()}`, owner_id: 'owner-1',
    first_name: 'New', last_name: 'Client', appointment_type_id: 'type-1',
    start_at: toUtcIso(DATE, '10:00', TZ), // exact same time as the Phone Call
  });
  assert.ok(result.appointment, 'a real Appointment must book successfully at the exact same time as an existing Phone Call');
});

test('4b. TEST 3 FROM SPEC: a real Meeting still correctly blocks/buffers — no regression from the Phone Call fix', async () => {
  resetFixture();
  existingAppointments = [{
    id: 'existing-meeting', start_at: toUtcIso(DATE, '10:00', TZ),
    busy_start: toUtcIso(DATE, '09:00', TZ), busy_end: toUtcIso(DATE, '12:00', TZ),
  }];
  const { createBooking, BookingError } = require('../lib/booking/bookingService');
  await assert.rejects(
    createBooking({
      idempotency_key: `k-${Math.random()}`, owner_id: 'owner-1',
      first_name: 'New', last_name: 'Client', appointment_type_id: 'type-1',
      start_at: toUtcIso(DATE, '10:30', TZ), // inside the Meeting's buffer
    }),
    (e) => e instanceof BookingError && e.code === 'slot_conflict'
  );
});

test('5. TEST 5 FROM SPEC: booking a Phone Call itself never enqueues a travel/buffer calendar event', async () => {
  resetFixture();
  lastEnqueueCreateArgs = null;
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: `k-${Math.random()}`, owner_id: 'owner-1',
    first_name: 'New', last_name: 'Client', appointment_type_id: 'type-1',
    start_at: toUtcIso(DATE, '14:00', TZ), skip_travel: true,
  });
  assert.strictEqual(lastEnqueueCreateArgs.skipTravel, true, 'a Phone Call booking must enqueue with skipTravel=true (no travel/buffer event)');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: Follow-Up remains completely independent (architectural guard)
// ═══════════════════════════════════════════════════════════════════════

test('6. TEST 4 FROM SPEC: a Follow-Up-only booking creates NO appointment row and is never blocking', async () => {
  resetFixture();
  const { createBooking } = require('../lib/booking/bookingService');
  const result = await createBooking({
    idempotency_key: `k-${Math.random()}`, owner_id: 'owner-1',
    first_name: 'New', last_name: 'Client',
    follow_up: { follow_up_date: DATE, follow_up_time: '10:00', follow_up_type: 'Phone Call' },
    // No start_at / appointment_type_id — Follow-Up only.
  });
  assert.strictEqual(result.appointment, null, 'a Follow-Up must never create an appointment row (and therefore can never block anything)');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: horizontal audit — the canonical distinction is used, not titles
// ═══════════════════════════════════════════════════════════════════════

test('7. horizontal audit: the canonical kind distinction (lower(busy_range) < start_at), not event titles, gates both queries', () => {
  const availSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'booking', 'availabilityService.js'), 'utf8');
  const writerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'booking', 'appointmentWriter.js'), 'utf8');
  const googleSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'booking', 'googleAvailability.js'), 'utf8');
  assert.ok(/lower\(busy_range\) < start_at/.test(availSrc), 'availabilityService.js must filter Phone Calls out of CRM busy windows');
  assert.ok(/lower\(busy_range\) < start_at/.test(writerSrc), 'appointmentWriter.js must filter Phone Calls out of conflict detection');
  assert.ok(/ec_appointment_kind === 'phone_call'/.test(googleSrc), 'googleAvailability.js must exclude Phone Call Google events by the canonical marker, not by title');
  assert.ok(!/summary\.includes\(.Phone Call.\)/.test(googleSrc), 'must never gate on the event summary/title string');
});
