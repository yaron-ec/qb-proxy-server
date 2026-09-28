/* eslint-disable no-undef */
'use strict';

/**
 * bookingServiceLeadInit.test.js — New Lead initial state (canonical model).
 *
 * A lead born WITH its first appointment starts as "Appointment Scheduled" /
 * "First Meeting"; a lead born without one starts as "New". The appointment is
 * NEVER mirrored into the lead's follow_up_* fields — that mirror is exactly
 * what made Lead Detail show "Appointment: Not set" next to
 * "Follow-up: Meeting <appointment time>". follow_up_* is written only from
 * the caller's independent follow-up input.
 *
 * Booking an appointment for an EXISTING (reused) lead never resets that
 * lead's current status/stage.
 */
const test = require('node:test');
const assert = require('node:assert');

// ── Mock db/client: pool.connect() returns a scripted client ───────────────
let leadsTable;
let appointmentInserts = 0;
function resetLeads() { leadsTable = []; appointmentInserts = 0; }
resetLeads();

function makeClient() {
  return {
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^BEGIN$/i.test(s) || /^COMMIT$/i.test(s) || /^ROLLBACK$/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM booking_idempotency/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM owners WHERE id = \$1/i.test(s)) return { rows: [{ id: 'owner-1', email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich' }] };
      if (/^INSERT INTO leads/i.test(s)) {
        // Column order: ... status=$24, meeting_stage=$25, follow_up_type=$26,
        // follow_up_date=$27, follow_up_time=$28, follow_up_notes=$29, follow_up_status=$30
        const row = {
          id: `lead-${leadsTable.length + 1}`,
          status: params[23], meeting_stage: params[24],
          follow_up_type: params[25], follow_up_date: params[26], follow_up_time: params[27],
          follow_up_notes: params[28], follow_up_status: params[29],
        };
        leadsTable.push(row);
        return { rows: [row] };
      }
      if (/pg_advisory_xact_lock/i.test(s)) return { rows: [] };
      if (/^SELECT id, override_authorized/i.test(s)) return { rows: [] };
      if (/^INSERT INTO appointments/i.test(s)) { appointmentInserts++; }
      if (/^INSERT INTO appointments/i.test(s)) return { rows: [{ id: 'appt-1', start_at: '2026-08-01T17:00:00Z', end_at: '2026-08-01T18:00:00Z', status: 'scheduled' }] };
      if (/^INSERT INTO appointment_events/i.test(s)) return { rows: [] };
      if (/^INSERT INTO booking_idempotency/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM leads WHERE id = \$1/i.test(s)) return { rows: [leadsTable.find(l => l.id === params[0])] };
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
let resolveLeadImpl = async () => ({ action: 'create' });
require.cache[leadResolutionPath] = {
  id: leadResolutionPath, filename: leadResolutionPath, loaded: true,
  exports: { resolveLead: (...a) => resolveLeadImpl(...a), lockLeadIdentity: async () => [] },
};

const appointmentTypesPath = require.resolve('../lib/booking/appointmentTypes');
delete require.cache[appointmentTypesPath];
require.cache[appointmentTypesPath] = {
  id: appointmentTypesPath, filename: appointmentTypesPath, loaded: true,
  exports: {
    getType: async () => ({ id: 'type-1', name: 'Consultation', default_duration_minutes: 60 }),
    resolveDuration: () => 60,
    validateDurationOverride: () => {},
  },
};

const calendarOutboxPath = require.resolve('../lib/booking/calendarOutbox');
delete require.cache[calendarOutboxPath];
require.cache[calendarOutboxPath] = {
  id: calendarOutboxPath, filename: calendarOutboxPath, loaded: true,
  exports: { enqueueCreate: async () => {} },
};

const addressPipelinePath = require.resolve('../lib/addressPipeline');
delete require.cache[addressPipelinePath];
require.cache[addressPipelinePath] = {
  id: addressPipelinePath, filename: addressPipelinePath, loaded: true,
  exports: {
    processAddress: async (a) => a,
    ensureAddressColumns: async () => {},
    buildAddressFieldMap: () => null,
  },
};

delete require.cache[require.resolve('../lib/booking/bookingService')];

test('a brand new Lead created with its first appointment starts as "Appointment Scheduled" / "First Meeting"', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'create' });
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: 'k1', owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz',
    start_at: '2026-08-01T17:00:00Z', appointment_type_id: 'type-1',
  });
  assert.strictEqual(leadsTable.length, 1);
  assert.strictEqual(leadsTable[0].status, 'Appointment Scheduled');
  assert.strictEqual(leadsTable[0].meeting_stage, 'First Meeting');
  assert.strictEqual(appointmentInserts, 1);
});

test('the appointment is NOT mirrored into follow_up_* (root cause of "Appointment: Not set" + "Follow-up: Meeting")', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'create' });
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: 'k2', owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz',
    start_at: '2026-08-01T17:00:00Z', appointment_type_id: 'type-1',
    // A legacy caller still passing these must not resurrect the mirror.
    local_appointment_date: '2026-08-01', local_appointment_time: '10:00',
  });
  assert.strictEqual(leadsTable[0].follow_up_date, null);
  assert.strictEqual(leadsTable[0].follow_up_time, null);
  assert.strictEqual(leadsTable[0].follow_up_type, null);
});

test('an independent follow-up is persisted from follow_up input, alongside the appointment', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'create' });
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: 'k2b', owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz',
    start_at: '2026-08-01T17:00:00Z', appointment_type_id: 'type-1',
    follow_up: { follow_up_date: '2026-08-05', follow_up_time: '9:30', follow_up_type: 'Phone Call', follow_up_notes: 'Confirm budget' },
  });
  assert.deepStrictEqual(
    [leadsTable[0].follow_up_date, leadsTable[0].follow_up_time, leadsTable[0].follow_up_type, leadsTable[0].follow_up_notes, leadsTable[0].follow_up_status],
    ['2026-08-05', '09:30', 'Phone Call', 'Confirm budget', 'pending']);
});

test('a New Lead without an appointment is created as "New" with no appointment row', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'create' });
  const { createBooking } = require('../lib/booking/bookingService');
  const r = await createBooking({
    idempotency_key: 'k4', owner_id: 'owner-1', first_name: 'No', last_name: 'Appt',
    follow_up: { follow_up_date: '2026-08-05', follow_up_type: 'Text' },
  });
  assert.strictEqual(r.appointment, null);
  assert.strictEqual(leadsTable[0].status, 'New');
  assert.strictEqual(leadsTable[0].meeting_stage, null);
  assert.strictEqual(leadsTable[0].follow_up_type, 'Text');
  assert.strictEqual(appointmentInserts, 0);
});

test('an invalid follow-up is rejected before anything is written', async () => {
  resetLeads();
  const { createBooking, BookingError } = require('../lib/booking/bookingService');
  await assert.rejects(createBooking({
    idempotency_key: 'k5', owner_id: 'owner-1', first_name: 'Bad', last_name: 'FollowUp',
    follow_up: { follow_up_date: '2026-02-30', follow_up_type: 'Text' },
  }), (e) => e instanceof BookingError && e.code === 'invalid_follow_up');
  assert.strictEqual(leadsTable.length, 0);
});

test('booking a NEW appointment for an EXISTING (reused) lead never touches that lead\'s current status/stage', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'reuse', leadId: 'existing-lead-99' });
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: 'k3', owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz',
    start_at: '2026-08-01T17:00:00Z', appointment_type_id: 'type-1',
  });
  // No fresh INSERT INTO leads happened at all for the reuse path.
  assert.strictEqual(leadsTable.length, 0);
});
