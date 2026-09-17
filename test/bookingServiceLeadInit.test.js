/* eslint-disable no-undef */
'use strict';

/**
 * bookingServiceLeadInit.test.js — New Lead initial workflow state.
 *
 * Production gap: a Lead created together with its first appointment (the
 * CRM's own "New Lead" button -> /capture -> routes/publicCapture.js, the
 * Meta/Facebook Lead Ads webhook, and any future caller of the ONE canonical
 * lib/booking/bookingService.js#createBooking) was inserted with the generic
 * intake default status='new' and no meeting_stage/follow_up_type at all —
 * requiring a human to manually set "Appointment Scheduled" and re-enter a
 * redundant Follow-Up Date that duplicated the appointment they'd just
 * booked. Fixed at the ONE place all these callers share: a fresh lead
 * inserted as part of a booking now starts as status='Appointment
 * Scheduled', meeting_stage='First Meeting', follow_up_type='Meeting', with
 * follow_up_date/time passed through from the caller's own pre-conversion
 * Pacific-local strings (never re-derived, so no second timezone-conversion
 * implementation is introduced).
 *
 * Critically: booking a NEW appointment for an EXISTING (reused) lead must
 * NEVER reset that lead's current status/stage — e.g. a Sold deal's lead
 * getting a follow-up site visit scheduled must not revert to "Appointment
 * Scheduled" / "First Meeting".
 */
const test = require('node:test');
const assert = require('node:assert');

// ── Mock db/client: pool.connect() returns a scripted client ───────────────
let leadsTable;
function resetLeads() { leadsTable = []; }
resetLeads();

function makeClient() {
  return {
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^BEGIN$/i.test(s) || /^COMMIT$/i.test(s) || /^ROLLBACK$/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM booking_idempotency/i.test(s)) return { rows: [] };
      if (/^SELECT \* FROM owners WHERE id = \$1/i.test(s)) return { rows: [{ id: 'owner-1', email: 'yaron@ecconstructiongroup.com', display_name: 'Yaron Drilevich' }] };
      if (/^INSERT INTO leads/i.test(s)) {
        const row = {
          id: `lead-${leadsTable.length + 1}`,
          status: /VALUES.*'Appointment Scheduled'/i.test(s) ? 'Appointment Scheduled' : null,
          meeting_stage: /'First Meeting'/i.test(s) ? 'First Meeting' : null,
          follow_up_type: /'Meeting'/i.test(s) ? 'Meeting' : null,
          follow_up_date: params[params.length - 2] || null,
          follow_up_time: params[params.length - 1] || null,
        };
        leadsTable.push(row);
        return { rows: [row] };
      }
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
  exports: { resolveLead: (...a) => resolveLeadImpl(...a) },
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

test('a brand new Lead created with its first appointment starts as "Appointment Scheduled" / "First Meeting", not the generic intake default', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'create' });
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: 'k1', owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz',
    start_at: '2026-08-01T17:00:00Z', appointment_type_id: 'type-1',
    local_appointment_date: '2026-08-01', local_appointment_time: '10:00',
  });
  assert.strictEqual(leadsTable.length, 1);
  assert.strictEqual(leadsTable[0].status, 'Appointment Scheduled');
  assert.strictEqual(leadsTable[0].meeting_stage, 'First Meeting');
  assert.strictEqual(leadsTable[0].follow_up_type, 'Meeting');
});

test('follow_up_date/time on a new Lead are the caller\'s own Pacific-local strings, passed through — no second timezone conversion', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'create' });
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: 'k2', owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz',
    start_at: '2026-08-01T17:00:00Z', appointment_type_id: 'type-1',
    local_appointment_date: '2026-08-01', local_appointment_time: '10:00',
  });
  assert.strictEqual(leadsTable[0].follow_up_date, '2026-08-01');
  assert.strictEqual(leadsTable[0].follow_up_time, '10:00');
});

test('booking a NEW appointment for an EXISTING (reused) lead never touches that lead\'s current status/stage', async () => {
  resetLeads();
  resolveLeadImpl = async () => ({ action: 'reuse', leadId: 'existing-lead-99' });
  const { createBooking } = require('../lib/booking/bookingService');
  await createBooking({
    idempotency_key: 'k3', owner_id: 'owner-1',
    first_name: 'Brian', last_name: 'Krantz',
    start_at: '2026-08-01T17:00:00Z', appointment_type_id: 'type-1',
    local_appointment_date: '2026-08-01', local_appointment_time: '10:00',
  });
  // No fresh INSERT INTO leads happened at all for the reuse path.
  assert.strictEqual(leadsTable.length, 0);
});
