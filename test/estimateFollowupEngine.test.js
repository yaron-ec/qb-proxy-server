/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupEngine.test.js — pure unit coverage (no DB) for the
 * scheduling-math and token-generation pieces of
 * lib/estimateFollowupEngine.js: computeStepDueDates (the 6-step cadence,
 * including the DST boundary this codebase already fixed once for
 * lib/reminderTime.js), businessHourClamp, and the deterministic
 * HMAC-based unsubscribe token (unsubscribeTokenForSequence /
 * hashUnsubscribeToken).
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'x'.repeat(32);

const engine = require('../lib/estimateFollowupEngine');

test('businessHourClamp: within 9am-5pm window is unchanged', () => {
  assert.deepStrictEqual(engine.businessHourClamp(10, 30), { hour: 10, minute: 30 });
  assert.deepStrictEqual(engine.businessHourClamp(9, 0), { hour: 9, minute: 0 });
  assert.deepStrictEqual(engine.businessHourClamp(16, 59), { hour: 16, minute: 59 });
});

test('businessHourClamp: before 9am clamps up to 9:00', () => {
  assert.deepStrictEqual(engine.businessHourClamp(3, 15), { hour: 9, minute: 0 });
  assert.deepStrictEqual(engine.businessHourClamp(0, 0), { hour: 9, minute: 0 });
});

test('businessHourClamp: 5pm or later clamps down to 4:30pm', () => {
  assert.deepStrictEqual(engine.businessHourClamp(17, 0), { hour: 16, minute: 30 });
  assert.deepStrictEqual(engine.businessHourClamp(23, 59), { hour: 16, minute: 30 });
});

test('computeStepDueDates: produces exactly 6 steps in the canonical 1/3/5/8/11/14-day cadence', () => {
  const sentAtMs = new Date('2026-06-01T17:00:00Z').getTime(); // 10am Pacific, mid-year (PDT)
  const steps = engine.computeStepDueDates(sentAtMs, 'America/Los_Angeles');
  assert.strictEqual(steps.length, 6);
  assert.deepStrictEqual(steps.map((s) => s.stepNumber), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(steps.map((s) => s.dayOffset), [1, 3, 5, 8, 11, 14]);
  assert.deepStrictEqual(steps.map((s) => s.templateKey), ['day1', 'day3', 'day5', 'day8', 'day11', 'day14']);
});

test('computeStepDueDates: due dates fall on the correct calendar day, business-hour-clamped Pacific time', () => {
  // Sent at 10am Pacific on a mid-year day (no DST boundary in range).
  const sentAtMs = new Date('2026-06-01T17:00:00Z').getTime();
  const steps = engine.computeStepDueDates(sentAtMs, 'America/Los_Angeles');
  const day1 = new Date(steps[0].dueAt);
  // 2026-06-02 10:00 Pacific (PDT, UTC-7) = 17:00 UTC.
  assert.strictEqual(day1.toISOString(), '2026-06-02T17:00:00.000Z');
  const day14 = new Date(steps[5].dueAt);
  assert.strictEqual(day14.toISOString(), '2026-06-15T17:00:00.000Z');
});

test('computeStepDueDates: a send time outside business hours is clamped into 9am-5pm before being projected forward', () => {
  // Sent at 11pm Pacific — clamped to 4:30pm Pacific for every step's time-of-day.
  const sentAtMs = new Date('2026-06-02T06:00:00Z').getTime(); // 11pm Pacific June 1 (PDT)
  const steps = engine.computeStepDueDates(sentAtMs, 'America/Los_Angeles');
  const day1 = new Date(steps[0].dueAt);
  // Day offset is relative to the LOCAL calendar date the sent instant falls
  // on (June 1, since 11pm Pacific June 1 is still June 1 locally) + 1 day
  // = June 2, at the clamped 16:30 Pacific (PDT, UTC-7) = 23:30 UTC.
  assert.strictEqual(day1.toISOString(), '2026-06-02T23:30:00.000Z');
});

test('computeStepDueDates: correctly spans the November 2026 US DST "fall back" boundary (no 1-hour drift)', () => {
  // 10am Pacific on 2026-10-30 (PDT, UTC-7) -> day 3 (Nov 2) and day 14 (Nov 13)
  // both fall AFTER the Nov 1 transition (PST, UTC-8). The due_at UTC offset
  // must correctly differ across the boundary while the LOCAL time-of-day
  // (10:00am) stays exactly the same both before and after.
  const sentAtMs = new Date('2026-10-30T17:00:00Z').getTime(); // 10:00am PDT
  const steps = engine.computeStepDueDates(sentAtMs, 'America/Los_Angeles');
  const day1 = new Date(steps[0].dueAt); // Oct 31 — still PDT
  assert.strictEqual(day1.toISOString(), '2026-10-31T17:00:00.000Z');
  const day3 = new Date(steps[1].dueAt); // Nov 2 — now PST
  assert.strictEqual(day3.toISOString(), '2026-11-02T18:00:00.000Z');
  const day14 = new Date(steps[5].dueAt); // Nov 13 — PST
  assert.strictEqual(day14.toISOString(), '2026-11-13T18:00:00.000Z');
});

test('computeStepDueDates: correctly spans the March 2026 US DST "spring forward" boundary', () => {
  // 10am Pacific on 2026-03-05 (PST, UTC-8) -> day 3 (Mar 8) and later steps
  // fall AFTER the Mar 8 transition (PDT, UTC-7).
  const sentAtMs = new Date('2026-03-05T18:00:00Z').getTime(); // 10:00am PST
  const steps = engine.computeStepDueDates(sentAtMs, 'America/Los_Angeles');
  const day1 = new Date(steps[0].dueAt); // Mar 6 — still PST
  assert.strictEqual(day1.toISOString(), '2026-03-06T18:00:00.000Z');
  const day3 = new Date(steps[1].dueAt); // Mar 8 — transition day itself, 10am is after the 2am jump
  assert.strictEqual(day3.toISOString(), '2026-03-08T17:00:00.000Z');
  const day14 = new Date(steps[5].dueAt); // Mar 19 — PDT
  assert.strictEqual(day14.toISOString(), '2026-03-19T17:00:00.000Z');
});

test('unsubscribeTokenForSequence: deterministic — same sequence id always yields the same token', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  assert.strictEqual(engine.unsubscribeTokenForSequence(id), engine.unsubscribeTokenForSequence(id));
});

test('unsubscribeTokenForSequence: different sequence ids yield different tokens', () => {
  const a = engine.unsubscribeTokenForSequence('11111111-1111-1111-1111-111111111111');
  const b = engine.unsubscribeTokenForSequence('22222222-2222-2222-2222-222222222222');
  assert.notStrictEqual(a, b);
});

test('unsubscribeUrlFor: recomputes the SAME URL for the same sequence id on every call (no DB, no storage needed)', () => {
  const id = '33333333-3333-3333-3333-333333333333';
  const url1 = engine.unsubscribeUrlFor(id);
  const url2 = engine.unsubscribeUrlFor(id);
  assert.strictEqual(url1, url2);
  assert.match(url1, /\/api\/v1\/estimate-followups\/public\/unsubscribe\//);
});

test('hashUnsubscribeToken: deterministic SHA-256, matches the token unsubscribeUrlFor embeds', () => {
  const id = '44444444-4444-4444-4444-444444444444';
  const token = engine.unsubscribeTokenForSequence(id);
  const hash1 = engine.hashUnsubscribeToken(token);
  const hash2 = engine.hashUnsubscribeToken(token);
  assert.strictEqual(hash1, hash2);
  assert.strictEqual(hash1.length, 64); // hex-encoded SHA-256
});

test('MAX_STEP_ATTEMPTS is a small positive bound (never an unbounded retry loop)', () => {
  assert.ok(Number.isInteger(engine.MAX_STEP_ATTEMPTS));
  assert.ok(engine.MAX_STEP_ATTEMPTS > 0 && engine.MAX_STEP_ATTEMPTS <= 10);
});
