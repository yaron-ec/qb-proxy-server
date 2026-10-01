/* eslint-disable no-undef */
/**
 * leadDiagnostic.test.js — lib/leadDiagnostic.js (mocked pool, no real DB).
 *
 * Proves: (1) every query it issues is a read-only SELECT (never
 * INSERT/UPDATE/DELETE — the module's whole reason to exist is a mutation-
 * proof diagnostic path); (2) the response bundles the fields the safe
 * production diagnostic mechanism was built to answer (canonical follow-up,
 * full appointment history + events, activities, reminder state,
 * calendar/outbox linkage, and a classification verdict reusing
 * scripts/auditAppointmentFollowUp.js's own tested classifier); (3) a
 * lead with an unrelated-date Appointment + Follow-Up (the exact shape
 * reported for a real production lead) classifies as DIV_OTHER /
 * would_auto_apply=false — proving the diagnostic itself never treats that
 * combination as something to "fix".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { getLeadDiagnostic } = require('../lib/leadDiagnostic');

const LEAD_ID = '0fe6a8cc-c8e4-45fc-a5e2-eb12ec3f4bfa';
const APPT_ID = '11111111-1111-1111-1111-111111111111';

function makePool(overrides = {}) {
  const queries = [];
  const base = {
    lead: {
      rows: [{
        id: LEAD_ID, external_ref: null, first_name: 'Jane', last_name: 'Doe',
        status: 'Appointment scheduled', source: 'Referral', owner_email: 'rep@test.example',
        created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
        follow_up_date: '2026-10-01', follow_up_time: '12:00', follow_up_type: 'Meeting',
        follow_up_notes: null, follow_up_status: 'pending',
        appointment_date: null, appointment_time: null,
      }],
    },
    appointments: {
      rows: [{
        id: APPT_ID, lead_id: LEAD_ID, status: 'scheduled',
        start_at: '2026-09-29T18:00:00Z', end_at: '2026-09-29T19:00:00Z',
        timezone: 'America/Los_Angeles', busy_range: '[2026-09-29T17:00:00Z,2026-09-29T20:00:00Z)',
        calendar_sync_status: 'synced', google_event_id: 'g1', google_travel_event_id: null,
        calendar_last_error: null, idempotency_key: 'k1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
        type_name: 'Consultation', busy_start: '2026-09-29T17:00:00Z', busy_end: '2026-09-29T20:00:00Z',
        created_event_at: '2026-09-01T00:00:00Z', created_event_actor: 'rep@test.example',
      }],
    },
    events: { rows: [{ appointment_id: APPT_ID, actor: 'rep@test.example', action: 'created', previous_values: null, new_values: {}, created_at: '2026-09-01T00:00:00Z' }] },
    activities: { rows: [] },
    reminderLeads: { rows: [] },
    reminderClaims: { rows: [] },
    followupCalendarReminder: { rows: [] },
    calendarOutbox: { rows: [{ appointment_id: APPT_ID, action: 'create_main', status: 'synced', attempts: 1, last_error: null, google_event_id: 'g1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' }] },
    contactsOutbox: { rows: [] },
    ...overrides,
  };
  const pool = {
    query: async (sql) => {
      queries.push(sql);
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT l\.\*/.test(s)) return base.lead;
      if (/^\s*SELECT a\.\*/.test(s) || /FROM appointments a LEFT JOIN appointment_types/.test(s)) return base.appointments;
      if (/FROM appointment_events/.test(s)) return base.events;
      if (/FROM activities/.test(s)) return base.activities;
      if (/FROM reminder_leads/.test(s)) return base.reminderLeads;
      if (/FROM reminder_claims/.test(s)) return base.reminderClaims;
      if (/FROM followup_calendar_reminders/.test(s)) return base.followupCalendarReminder;
      if (/FROM calendar_outbox/.test(s)) return base.calendarOutbox;
      if (/FROM google_contacts_outbox/.test(s)) return base.contactsOutbox;
      throw new Error('unexpected query: ' + s);
    },
  };
  return { pool, queries };
}

test('every query issued is a read-only SELECT (never INSERT/UPDATE/DELETE)', async () => {
  const { pool, queries } = makePool();
  await getLeadDiagnostic(pool, LEAD_ID);
  assert.ok(queries.length > 0, 'issued at least one query');
  for (const q of queries) {
    const trimmed = q.replace(/\s+/g, ' ').trim().toUpperCase();
    assert.ok(trimmed.startsWith('SELECT'), `query must be a SELECT: ${q}`);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/.test(trimmed), `query must never mutate: ${q}`);
  }
});

test('returns null for a lead that does not exist (no error, no partial bundle)', async () => {
  const { pool } = makePool({ lead: { rows: [] } });
  const result = await getLeadDiagnostic(pool, LEAD_ID);
  assert.strictEqual(result, null);
});

test('bundles canonical follow-up, appointment history with events, and classification', async () => {
  const { pool } = makePool();
  const result = await getLeadDiagnostic(pool, LEAD_ID);
  assert.strictEqual(result.canonical_follow_up.date, '2026-10-01');
  assert.strictEqual(result.canonical_follow_up.time, '12:00');
  assert.strictEqual(result.canonical_follow_up.type, 'Meeting');
  assert.strictEqual(result.appointments.length, 1);
  assert.strictEqual(result.appointments[0].date, '2026-09-29');
  assert.strictEqual(result.appointments[0].events.length, 1);
  assert.strictEqual(result.appointments[0].events[0].action, 'created');
  assert.ok(Array.isArray(result.calendar_outbox));
  assert.strictEqual(result.calendar_outbox[0].status, 'synced');
  assert.ok(result.classification, 'a classification verdict is always present');
});

test('an Appointment + a different-dated Meeting Follow-Up classifies as DIV_OTHER, never auto-apply', async () => {
  // Exactly the shape reported for a real production lead: Appointment
  // Sep 29, Follow-Up Oct 1 — different dates, both legitimately active.
  const { pool } = makePool();
  const result = await getLeadDiagnostic(pool, LEAD_ID);
  assert.strictEqual(result.classification.class, 'DIVERGENT');
  assert.strictEqual(result.classification.sub, 'DIV_OTHER');
  assert.strictEqual(result.classification.would_auto_apply, false, 'a DIV_OTHER record is never something this diagnostic (or the audit script) would fix automatically');
  assert.strictEqual(result.classification.reason, 'different_date');
});

test('a lead with only a Follow-Up (no appointment) classifies as FOLLOWUP_ONLY', async () => {
  const { pool } = makePool({ appointments: { rows: [] }, calendarOutbox: { rows: [] } });
  const result = await getLeadDiagnostic(pool, LEAD_ID);
  assert.strictEqual(result.appointments.length, 0);
  assert.strictEqual(result.classification.sub, 'FOLLOWUP_ONLY');
});
