/* eslint-disable no-undef */
'use strict';

/**
 * appointmentAvailabilityParity.test.js — regression suite for the production
 * defect: "New Lead UI shows 6:30 PM as AVAILABLE; submitting that exact slot
 * is rejected by the backend with a slot conflict."
 *
 * ROOT CAUSE: lib/booking/bookingService.js computed the candidate's own
 * BUFFERED window ([start-1h, end+1h]) and passed it to the write-path
 * conflict check (lib/booking/appointmentWriter.js), which compares against
 * existing appointments' ALREADY-BUFFERED busy_range column. Comparing two
 * buffered windows double-buffers the effective gap (2 hours instead of 1),
 * rejecting slots the availability DISPLAY (lib/booking/slotBlocking.js,
 * single-buffer) correctly shows as free — exactly a slot starting 1 hour
 * after (or ending 1 hour before) an existing appointment.
 *
 * FIX: the conflict check now uses the candidate's ACTUAL, unbuffered
 * [start, end] — matching slotBlocking.js exactly. This suite proves parity
 * by running the SAME busy-window fixture through both the display function
 * (computeBlockedSlots) and the write path (createBooking), and asserting
 * they agree. It also proves the write path was NOT weakened (a genuine
 * overlap is still rejected) and extends coverage to the Google Calendar
 * parity gap found during the same audit (the write path previously never
 * checked Google Calendar events at all) and to admin override.
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeBlockedSlots, SLOTS, toUtcIso } = require('../lib/booking/slotBlocking');

const DATE = '2026-09-24';
const TZ = 'America/Los_Angeles';

// ── Fixture: one existing Meeting appointment, 4:30-5:30 PM → busy_range
//    [3:30 PM, 6:30 PM) — the exact shape of the reported production bug.
const EXISTING_START = toUtcIso(DATE, '15:30', TZ); // buffer start (busy_range lower)
const EXISTING_END = toUtcIso(DATE, '18:30', TZ);   // buffer end (busy_range upper)
let existingAppointments;
function resetFixture() {
  existingAppointments = [{ id: 'existing-appt-1', busy_start: EXISTING_START, busy_end: EXISTING_END }];
}
resetFixture();

let googleConflictWindows = [];

// ── Mock db/client: pool.connect() returns a scripted client whose conflict
// query performs REAL half-open-interval overlap math against the fixture —
// not a canned answer — so the test actually exercises the overlap logic.
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
        // params: [ownerId, excludeAppointmentId, candidateStart, candidateEnd]
        const [, excludeId, candStart, candEnd] = params;
        const conflicts = existingAppointments.filter(a =>
          a.id !== excludeId &&
          new Date(candStart) < new Date(a.busy_end) &&
          new Date(a.busy_start) < new Date(candEnd)
        );
        return { rows: conflicts.map(a => ({ id: a.id, override_authorized: false, override_authorized_by: null })) };
      }
      if (/^INSERT INTO appointments/i.test(s)) return { rows: [{ id: 'new-appt-1', start_at: params[3], end_at: params[4], status: 'scheduled' }] };
      if (/^UPDATE appointments SET override_authorized/i.test(s)) return { rows: [] };
      if (/^INSERT INTO appointment_events/i.test(s)) return { rows: [] };
      if (/^INSERT INTO booking_idempotency/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM leads WHERE id = \$1/i.test(s)) return { rows: [{ id: params[0] }] };
      if (/^SELECT \* FROM appointments WHERE id = \$1/i.test(s)) return { rows: [{ id: params[0] }] };
      throw new Error('mock client: unrecognized query: ' + s);
    },
    release: () => {},
  };
}

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: { connect: async () => makeClient() }, ensureSchema: async () => {}, query: async () => ({ rows: [] }) },
};

const leadResolutionPath = require.resolve('../lib/booking/leadResolution');
delete require.cache[leadResolutionPath];
require.cache[leadResolutionPath] = {
  id: leadResolutionPath, filename: leadResolutionPath, loaded: true,
  exports: { resolveLead: async () => ({ action: 'create' }) },
};

const calendarOutboxPath = require.resolve('../lib/booking/calendarOutbox');
delete require.cache[calendarOutboxPath];
require.cache[calendarOutboxPath] = {
  id: calendarOutboxPath, filename: calendarOutboxPath, loaded: true,
  exports: { enqueueCreate: async () => {}, enqueueCancel: async () => {}, enqueueUpdate: async () => {} },
};

const addressPipelinePath = require.resolve('../lib/addressPipeline');
delete require.cache[addressPipelinePath];
require.cache[addressPipelinePath] = {
  id: addressPipelinePath, filename: addressPipelinePath, loaded: true,
  exports: { processAddress: async (a) => a, ensureAddressColumns: async () => {}, buildAddressFieldMap: () => null },
};

// Real appointmentTypes module is fine (default_duration_minutes=60 fixture below
// is provided directly) — mock it so no real DB read is needed.
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

// Mock only getGoogleConflictWindows (the write-path Google pre-check);
// re-export everything else from the real module so getAvailability()
// (used by the parity assertions below) stays genuine.
const availabilityServicePath = require.resolve('../lib/booking/availabilityService');
const realAvailabilityService = require(availabilityServicePath);
delete require.cache[availabilityServicePath];
require.cache[availabilityServicePath] = {
  id: availabilityServicePath, filename: availabilityServicePath, loaded: true,
  exports: { ...realAvailabilityService, getGoogleConflictWindows: async () => googleConflictWindows },
};

delete require.cache[require.resolve('../lib/booking/bookingService')];

function baseInput(overrides = {}) {
  return {
    idempotency_key: `k-${Math.random()}`, owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz', appointment_type_id: 'type-1',
    ...overrides,
  };
}

test('1. ROOT-CAUSE REGRESSION: a slot the display shows AVAILABLE (1hr after an existing meeting) is ACCEPTED by createBooking', async () => {
  resetFixture();
  googleConflictWindows = [];
  const { createBooking } = require('../lib/booking/bookingService');
  const start_at = toUtcIso(DATE, '18:30', TZ); // exactly the existing appointment's buffer end
  const result = await createBooking(baseInput({ start_at }));
  assert.ok(result.appointment, 'booking must succeed — this is the exact reported production bug');
  assert.strictEqual(result.appointment.id, 'new-appt-1');
});

test('1b. Frontend/backend PARITY: the display function (computeBlockedSlots) agrees the same slot is available', () => {
  resetFixture();
  const busyWindows = [{ start: existingAppointments[0].busy_start, end: existingAppointments[0].busy_end, source: 'crm' }];
  const blocked = computeBlockedSlots(SLOTS, DATE, TZ, 60, busyWindows);
  assert.ok(!blocked.includes('18:30'), '18:30 must be shown available by the display — matching the write path above');
});

test('2. A genuine conflict (slot overlapping the existing meeting) is still correctly REJECTED — no regression', async () => {
  resetFixture();
  googleConflictWindows = [];
  const { createBooking, BookingError } = require('../lib/booking/bookingService');
  const start_at = toUtcIso(DATE, '18:00', TZ); // 6:00 PM — inside the buffer [3:30,6:30)
  await assert.rejects(
    createBooking(baseInput({ start_at })),
    (e) => e instanceof BookingError && e.code === 'slot_conflict'
  );
});

test('2b. Frontend/backend PARITY: the display also blocks that same overlapping slot', () => {
  resetFixture();
  const busyWindows = [{ start: existingAppointments[0].busy_start, end: existingAppointments[0].busy_end, source: 'crm' }];
  const blocked = computeBlockedSlots(SLOTS, DATE, TZ, 60, busyWindows);
  assert.ok(blocked.includes('18:00'), '18:00 must be blocked by the display — matching the write-path rejection above');
});

test('3. The symmetric 1-hour-BEFORE boundary is also accepted (touching, not overlapping)', async () => {
  resetFixture();
  existingAppointments = [{
    id: 'existing-appt-2',
    busy_start: toUtcIso(DATE, '17:30', TZ), // 6:30 PM meeting buffered to 5:30 PM
    busy_end: toUtcIso(DATE, '20:30', TZ),
  }];
  googleConflictWindows = [];
  const { createBooking } = require('../lib/booking/bookingService');
  // 4:30-5:30 PM candidate — ends exactly at the existing appointment's buffer start.
  const start_at = toUtcIso(DATE, '16:30', TZ);
  const result = await createBooking(baseInput({ start_at }));
  assert.ok(result.appointment, '4:30 PM must be accepted — it only touches the buffer, does not overlap it');
});

test('4. Google Calendar-only conflict (no CRM appointment row) is now caught by the write path', async () => {
  resetFixture();
  existingAppointments = []; // no CRM conflict at all
  const start_at = toUtcIso(DATE, '14:00', TZ);
  const end_at = new Date(new Date(start_at).getTime() + 60 * 60 * 1000).toISOString();
  googleConflictWindows = [{ start: start_at, end: end_at, source: 'google' }];
  const { createBooking, BookingError } = require('../lib/booking/bookingService');
  await assert.rejects(
    createBooking(baseInput({ start_at })),
    (e) => e instanceof BookingError && e.code === 'slot_conflict'
  );
});

test('5. Admin override bypasses BOTH a CRM conflict and a Google conflict', async () => {
  resetFixture(); // CRM conflict fixture (4:30-5:30 PM buffered 3:30-6:30 PM)
  const start_at = toUtcIso(DATE, '18:00', TZ); // inside the CRM buffer
  const end_at = new Date(new Date(start_at).getTime() + 60 * 60 * 1000).toISOString();
  googleConflictWindows = [{ start: start_at, end: end_at, source: 'google' }]; // ALSO a Google conflict
  const { createBooking } = require('../lib/booking/bookingService');
  const result = await createBooking(baseInput({ start_at, override_conflict: true, override_actor: 'yaron@ecconstructiongroup.com' }));
  assert.ok(result.appointment, 'admin override must book over both a CRM and a Google conflict');
});

test('6. A genuinely free day with no CRM or Google activity books normally', async () => {
  resetFixture();
  existingAppointments = [];
  googleConflictWindows = [];
  const { createBooking } = require('../lib/booking/bookingService');
  const start_at = toUtcIso(DATE, '10:00', TZ);
  const result = await createBooking(baseInput({ start_at }));
  assert.ok(result.appointment);
});
