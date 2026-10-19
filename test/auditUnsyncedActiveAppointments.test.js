/* eslint-disable no-undef */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyUnsyncedAppointment, ageBucket } = require('../scripts/auditUnsyncedActiveAppointments');

const START = '2026-07-01T18:00:00.000Z';
function meetingAppt(overrides = {}) {
  return {
    busy_range: { lower: '2026-07-01T17:00:00.000Z' }, // 1h before start_at => Meeting
    start_at: START,
    calendar_sync_status: 'pending',
    calendar_last_error: null,
    ...overrides,
  };
}
function phoneCallAppt(overrides = {}) {
  return {
    busy_range: { lower: START }, // lower === start_at => Phone Call (no buffer)
    start_at: START,
    calendar_sync_status: 'pending',
    ...overrides,
  };
}

test('classifyUnsyncedAppointment: a legacy Phone Call row is always legacy_phone_call, regardless of outbox history', () => {
  assert.deepStrictEqual(classifyUnsyncedAppointment(phoneCallAppt(), false), { kind: 'legacy_phone_call', reason: 'never_queued_by_design' });
  assert.deepStrictEqual(classifyUnsyncedAppointment(phoneCallAppt(), true), { kind: 'legacy_phone_call', reason: 'never_queued_by_design' });
});

test('classifyUnsyncedAppointment: a Meeting with zero create_main/update_main outbox rows is never_enqueued', () => {
  const result = classifyUnsyncedAppointment(meetingAppt(), false);
  assert.strictEqual(result.kind, 'meeting');
  assert.strictEqual(result.reason, 'never_enqueued');
});

test('classifyUnsyncedAppointment: a Meeting with outbox history and calendar_sync_status=pending/processing is queued_not_yet_processed', () => {
  assert.strictEqual(classifyUnsyncedAppointment(meetingAppt({ calendar_sync_status: 'pending' }), true).reason, 'queued_not_yet_processed');
  assert.strictEqual(classifyUnsyncedAppointment(meetingAppt({ calendar_sync_status: 'processing' }), true).reason, 'queued_not_yet_processed');
});

test('classifyUnsyncedAppointment: calendar_sync_status=retrying is a genuine in-flight failure, reported distinctly', () => {
  assert.strictEqual(classifyUnsyncedAppointment(meetingAppt({ calendar_sync_status: 'retrying' }), true).reason, 'retrying');
});

test('classifyUnsyncedAppointment: calendar_sync_status=failed is a dead-lettered failure, reported distinctly', () => {
  assert.strictEqual(classifyUnsyncedAppointment(meetingAppt({ calendar_sync_status: 'failed' }), true).reason, 'failed');
});

test('classifyUnsyncedAppointment: calendar_sync_status=synced with a null google_event_id is an impossible-should-never-happen anomaly, never silently folded into a normal bucket', () => {
  assert.strictEqual(classifyUnsyncedAppointment(meetingAppt({ calendar_sync_status: 'synced' }), true).reason, 'synced_anomaly');
});

test('ageBucket: buckets by days since created_at relative to the given "now"', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  assert.strictEqual(ageBucket('2026-10-15T00:00:00Z', now), 'under_7d');
  assert.strictEqual(ageBucket('2026-10-01T00:00:00Z', now), 'd7_30');
  assert.strictEqual(ageBucket('2026-08-15T00:00:00Z', now), 'd30_90');
  assert.strictEqual(ageBucket('2026-01-01T00:00:00Z', now), 'over_90d');
});
