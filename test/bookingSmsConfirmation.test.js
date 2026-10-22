/* eslint-disable no-undef */
'use strict';

/**
 * bookingSmsConfirmation.test.js — lib/booking/bookingService.js's new
 * post-commit booking-confirmation SMS: localDateTimeParts (DST-correct UTC
 * -> local conversion) and sendBookingConfirmationSmsBestEffort's gating
 * (SMS_AUTOMATED_REMINDERS_ENABLED kill switch, module gate, consent
 * short-circuit) — all pure/no-live-DB logic. Full end-to-end (a real
 * booking actually triggering a real SMS send against a fake Twilio client)
 * is covered in test/integration/smsAppointmentLifecycle.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { localDateTimeParts, sendBookingConfirmationSmsBestEffort } = require('../lib/booking/bookingService');

test('localDateTimeParts: converts a UTC instant to the correct wall-clock date/time in a given IANA timezone', () => {
  // 2026-10-29 22:00 UTC = 2026-10-29 15:00 America/Los_Angeles (PDT, UTC-7)
  const { date, time } = localDateTimeParts('2026-10-29T22:00:00Z', 'America/Los_Angeles');
  assert.strictEqual(date, '2026-10-29');
  assert.strictEqual(time, '15:00');
});

test('localDateTimeParts: DST boundary — PDT (UTC-7) before the Nov 1 2026 transition', () => {
  // 2026-10-31 20:00 UTC, still PDT -> 13:00 local
  const { date, time } = localDateTimeParts('2026-10-31T20:00:00Z', 'America/Los_Angeles');
  assert.strictEqual(date, '2026-10-31');
  assert.strictEqual(time, '13:00');
});

test('localDateTimeParts: DST boundary — PST (UTC-8) after the Nov 1 2026 transition', () => {
  // 2026-11-02 20:00 UTC, now PST -> 12:00 local (one hour earlier than the
  // identical UTC time would have produced the day before the transition)
  const { date, time } = localDateTimeParts('2026-11-02T20:00:00Z', 'America/Los_Angeles');
  assert.strictEqual(date, '2026-11-02');
  assert.strictEqual(time, '12:00');
});

test('localDateTimeParts: a different installation timezone (not Pacific) converts correctly', () => {
  const { date, time } = localDateTimeParts('2026-07-04T16:00:00Z', 'America/New_York');
  assert.strictEqual(date, '2026-07-04');
  assert.strictEqual(time, '12:00'); // EDT, UTC-4
});

test('sendBookingConfirmationSmsBestEffort: SMS_AUTOMATED_REMINDERS_ENABLED unset -> never calls smsService (deploying this code cannot itself start sending)', async () => {
  delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  // No lead/appt validity needed — the function must return before touching
  // the DB or requiring smsService at all when the flag is off.
  await assert.doesNotReject(() => sendBookingConfirmationSmsBestEffort(null, null));
});

test('sendBookingConfirmationSmsBestEffort: never throws even on malformed input (best-effort, never fails the booking response)', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    await assert.doesNotReject(() => sendBookingConfirmationSmsBestEffort(undefined, undefined));
    await assert.doesNotReject(() => sendBookingConfirmationSmsBestEffort({ id: 'x' }, null));
  } finally {
    delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  }
});
