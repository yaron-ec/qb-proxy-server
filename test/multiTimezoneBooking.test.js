/* eslint-disable no-undef */
/**
 * multiTimezoneBooking.test.js — PRODUCTIZATION PHASE 2, Section 4: proves
 * there is no hidden Pacific-time assumption in the booking-time conversion
 * used by the public capture path and Lead Detail appointment booking.
 *
 * lib/captureValidation.js#laToUtcStart(date, time, timezone) and
 * lib/booking/slotBlocking.js#toUtcIso(date, time, timezone) both take an
 * explicit timezone parameter (default 'America/Los_Angeles', preserving
 * EC's exact historical behavior) — the production callers
 * (routes/publicCapture.js, routes/metaWebhook.js, routes/leads.js) now
 * resolve it from company_settings.timezone instead of hardcoding the
 * literal. This test proves the SAME wall-clock date/time produces a
 * DIFFERENT UTC instant depending on which company's timezone is passed —
 * i.e. Company #2 in a materially different timezone is not silently
 * treated as Pacific.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { laToUtcStart } = require('../lib/captureValidation');
const { toUtcIso } = require('../lib/booking/slotBlocking');

describe('laToUtcStart — company timezone, not a hidden Pacific assumption', () => {
  test('default (no timezone passed) preserves EC\'s historical Pacific interpretation', () => {
    // 2026-08-10 is PDT (UTC-7): 11:00 America/Los_Angeles -> 18:00 UTC.
    const utc = laToUtcStart('2026-08-10', '11:00');
    assert.strictEqual(new Date(utc).toISOString(), '2026-08-10T18:00:00.000Z');
  });

  test('two materially different timezones for the SAME wall-clock date/time produce DIFFERENT UTC instants', () => {
    const pacific = laToUtcStart('2026-08-10', '11:00', 'America/Los_Angeles');
    const eastern = laToUtcStart('2026-08-10', '11:00', 'America/New_York');
    const tokyo = laToUtcStart('2026-08-10', '11:00', 'Asia/Tokyo');
    assert.notStrictEqual(pacific, eastern, 'Pacific and Eastern must resolve to different UTC instants for the same wall-clock time');
    assert.notStrictEqual(pacific, tokyo, 'Pacific and Tokyo must resolve to different UTC instants for the same wall-clock time');
    assert.notStrictEqual(eastern, tokyo);
  });

  test('Eastern timezone: 11:00 America/New_York (EDT, UTC-4) -> 15:00 UTC — not silently reinterpreted as Pacific', () => {
    const utc = laToUtcStart('2026-08-10', '11:00', 'America/New_York');
    assert.strictEqual(new Date(utc).toISOString(), '2026-08-10T15:00:00.000Z');
  });

  test('a company timezone 3 hours off Pacific produces a UTC instant exactly 3 hours different for the same wall-clock time', () => {
    const pacific = new Date(laToUtcStart('2026-08-10', '14:00', 'America/Los_Angeles')).getTime();
    const eastern = new Date(laToUtcStart('2026-08-10', '14:00', 'America/New_York')).getTime();
    const diffHours = (pacific - eastern) / (1000 * 60 * 60);
    assert.strictEqual(diffHours, 3, 'Pacific is 3 hours behind Eastern for this DST-aligned date');
  });
});

describe('toUtcIso (lib/booking/slotBlocking.js) — same guarantee at the slot-blocking layer', () => {
  test('two different company timezones produce different UTC instants for the same booked slot', () => {
    const a = toUtcIso('2026-11-15', '09:00', 'America/Los_Angeles');
    const b = toUtcIso('2026-11-15', '09:00', 'America/Chicago');
    assert.notStrictEqual(a, b);
  });
});
