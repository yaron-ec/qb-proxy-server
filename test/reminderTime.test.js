/* eslint-disable no-undef */
'use strict';

/**
 * reminderTime.test.js — lib/reminderTime.js#pacificToUtcMs DST correctness.
 *
 * Production bug (November 2026): the original implementation probed the
 * UTC offset at a FIXED anchor (noon UTC of the calendar date) and applied
 * that single offset to every time of day on that date. On the day a DST
 * transition actually happens, a date straddles TWO different offsets (the
 * US "fall back" day is PDT before ~2:00 AM local, PST from ~1:00 AM local
 * onward), so the noon anchor — always well past the transition — silently
 * applied the WRONG offset to every early-morning time on that date, a full
 * 1-hour miscalculation. This was discovered via
 * test/phoneCallRemindersMichelleExclusion.test.js intermittently failing
 * only when CI happened to run inside the ~2-hour window this bug affected
 * on 2026-11-01 (confirmed by reproducing the exact drift with a fixed
 * "now" value — see this file's own test below).
 *
 * This suite locks in the fix: every wall-clock hour on both 2026 US DST
 * transition dates round-trips to the EXACT requested local date/time
 * (except the genuinely nonexistent "spring forward" gap hour, which has no
 * correct answer by construction and is asserted only to resolve
 * deterministically, not to round-trip) — plus an ordinary, non-transition
 * date to guard against any regression in the common case.
 */

const test = require('node:test');
const assert = require('node:assert');
const { pacificToUtcMs } = require('../lib/reminderTime');

const LA = 'America/Los_Angeles';

function laWallClock(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(ms).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  let hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

test('pacificToUtcMs: ordinary non-transition date round-trips exactly (no regression)', () => {
  const ms = pacificToUtcMs('2026-07-15', '14:00', LA);
  assert.strictEqual(laWallClock(ms), '2026-07-15 14:00');
  assert.strictEqual(new Date(ms).toISOString(), '2026-07-15T21:00:00.000Z'); // PDT = UTC-7
});

test('pacificToUtcMs: ordinary winter date round-trips exactly (no regression)', () => {
  const ms = pacificToUtcMs('2026-01-15', '09:00', LA);
  assert.strictEqual(laWallClock(ms), '2026-01-15 09:00');
  assert.strictEqual(new Date(ms).toISOString(), '2026-01-15T17:00:00.000Z'); // PST = UTC-8
});

// 2026 US "fall back": clocks go from 1:59:59 AM PDT to 1:00:00 AM PST at
// 2026-11-01T09:00:00Z. Every local hour from midnight through ~2 AM is
// affected by the bug (the noon-UTC probe always lands on PST for this
// date, which is correct from ~1 AM onward but WRONG before it).
test('pacificToUtcMs: fall-back day, midnight (unambiguous PDT) round-trips exactly', () => {
  const ms = pacificToUtcMs('2026-11-01', '00:00', LA);
  assert.strictEqual(laWallClock(ms), '2026-11-01 00:00');
  assert.strictEqual(new Date(ms).toISOString(), '2026-11-01T07:00:00.000Z'); // PDT
});

test('pacificToUtcMs: fall-back day, 00:30 (unambiguous PDT) round-trips exactly — this is the exact case the original bug miscalculated by 1 hour', () => {
  const ms = pacificToUtcMs('2026-11-01', '00:30', LA);
  assert.strictEqual(laWallClock(ms), '2026-11-01 00:30');
  assert.strictEqual(new Date(ms).toISOString(), '2026-11-01T07:30:00.000Z'); // PDT (the buggy old code produced 08:30Z / "1:30 AM")
});

test('pacificToUtcMs: fall-back day, the AMBIGUOUS repeated hour (01:xx) round-trips exactly and deterministically resolves to the earlier (PDT) occurrence', () => {
  const ms = pacificToUtcMs('2026-11-01', '01:25', LA);
  assert.strictEqual(laWallClock(ms), '2026-11-01 01:25');
  assert.strictEqual(new Date(ms).toISOString(), '2026-11-01T08:25:00.000Z'); // PDT occurrence (earlier of the two valid instants)
});

test('pacificToUtcMs: fall-back day, 02:00 (unambiguous PST, first non-repeated hour) round-trips exactly and matches pre-fix behavior', () => {
  const ms = pacificToUtcMs('2026-11-01', '02:00', LA);
  assert.strictEqual(laWallClock(ms), '2026-11-01 02:00');
  assert.strictEqual(new Date(ms).toISOString(), '2026-11-01T10:00:00.000Z'); // PST
});

test('pacificToUtcMs: fall-back day, afternoon is unaffected (matches pre-fix behavior)', () => {
  const ms = pacificToUtcMs('2026-11-01', '12:00', LA);
  assert.strictEqual(laWallClock(ms), '2026-11-01 12:00');
  assert.strictEqual(new Date(ms).toISOString(), '2026-11-01T20:00:00.000Z'); // PST
});

// 2026 US "spring forward": clocks jump from 1:59:59 AM PST to 3:00:00 AM
// PDT at 2026-03-08T10:00:00Z. 2:00-2:59 AM local does not exist that day.
test('pacificToUtcMs: spring-forward day, 01:30 (unambiguous PST, before the gap) round-trips exactly', () => {
  const ms = pacificToUtcMs('2026-03-08', '01:30', LA);
  assert.strictEqual(laWallClock(ms), '2026-03-08 01:30');
  assert.strictEqual(new Date(ms).toISOString(), '2026-03-08T09:30:00.000Z'); // PST
});

test('pacificToUtcMs: spring-forward day, the NONEXISTENT gap hour (02:xx) resolves deterministically without throwing (no correct answer exists by construction)', () => {
  const ms = pacificToUtcMs('2026-03-08', '02:30', LA);
  assert.strictEqual(typeof ms, 'number');
  assert.ok(Number.isFinite(ms));
  // Resolves to the post-transition side (3:30 AM PDT) — deterministic, not asserted as "correct" since no correct answer exists.
  assert.strictEqual(new Date(ms).toISOString(), '2026-03-08T10:30:00.000Z');
});

test('pacificToUtcMs: spring-forward day, 03:00 (unambiguous PDT, after the gap) round-trips exactly', () => {
  const ms = pacificToUtcMs('2026-03-08', '03:00', LA);
  assert.strictEqual(laWallClock(ms), '2026-03-08 03:00');
  assert.strictEqual(new Date(ms).toISOString(), '2026-03-08T10:00:00.000Z'); // PDT
});

// The actual reported regression: a lead's follow-up/appointment time
// computed as "now + 1 hour" on 2026-11-01 around the CI run that first
// surfaced this (test/phoneCallRemindersMichelleExclusion.test.js).
test('pacificToUtcMs: reproduces and fixes the exact drift reported in CI (2026-11-01T07:25:21Z + 1h)', () => {
  const now = Date.parse('2026-11-01T07:25:21Z');
  const future = now + 60 * 60 * 1000; // 2026-11-01T08:25:21Z = 01:25 AM PDT
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(future);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: LA, hour: '2-digit', minute: '2-digit', hour12: false }).format(future);
  const ms = pacificToUtcMs(date, time, LA);
  // Before the fix this returned 2026-11-01T09:25:00Z — a full hour later
  // than the true instant, which is exactly what made the reminder window
  // check (now - targetMs) go negative and silently skip sending.
  const driftMs = Math.abs(ms - future);
  assert.ok(driftMs < 60000, `expected round-trip within 1 minute (second-level truncation only), got drift of ${driftMs}ms`);
});
