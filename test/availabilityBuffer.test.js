/* eslint-disable no-undef */
/**
 * availabilityBuffer.test.js — validates the single-buffer rule in
 * computeBlockedSlots (no DB required).
 *
 * Rule: an 11:00–12:00 appointment stores busy_range = [10:00, 13:00]
 * (1hr before + duration + 1hr after). A candidate [slot, slot+60] is blocked
 * iff it overlaps that protected window. Touching at a point is NOT a conflict.
 *
 * Expected (America/Los_Angeles, 60-min duration):
 *   09:00 → 10:00  = ALLOWED  (touches 10:00, no overlap)
 *   09:30 → 10:30  = BLOCKED  (overlaps 10:00–13:00)
 *   11:00 → 12:00  = BLOCKED  (inside the window)
 *   12:30 → 13:30  = BLOCKED  (overlaps 13:00)
 *   13:00 → 14:00  = ALLOWED  (touches 13:00, no overlap)
 */
'use strict';

const { computeBlockedSlots, SLOTS } = require('../lib/booking/slotBlocking');

const DATE = '2026-08-10';
const TZ = 'America/Los_Angeles';
const DURATION = 60;

// 11:00–12:00 PDT appointment → busy_range = 10:00–13:00 PDT
// PDT (UTC-7): 10:00 PDT = 17:00 UTC, 13:00 PDT = 20:00 UTC
const busyWindows = [
  { start: '2026-08-10T17:00:00.000Z', end: '2026-08-10T20:00:00.000Z', source: 'crm' },
];

const blocked = computeBlockedSlots(SLOTS, DATE, TZ, DURATION, busyWindows);
const blockedSet = new Set(blocked);

const assertions = [
  { slot: '09:00', expect: 'allowed' },
  { slot: '09:30', expect: 'blocked' },
  { slot: '10:00', expect: 'blocked' },
  { slot: '10:30', expect: 'blocked' },
  { slot: '11:00', expect: 'blocked' },
  { slot: '11:30', expect: 'blocked' },
  { slot: '12:00', expect: 'blocked' },
  { slot: '12:30', expect: 'blocked' },
  { slot: '13:00', expect: 'allowed' },
  { slot: '13:30', expect: 'allowed' },
  { slot: '14:00', expect: 'allowed' },
];

let failed = 0;
for (const a of assertions) {
  const isBlocked = blockedSet.has(a.slot);
  const actual = isBlocked ? 'blocked' : 'allowed';
  const ok = actual === a.expect;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${a.slot} → ${actual} (expected ${a.expect})`);
}

// Summary: protected window 10:00–13:00 → blocked slots 09:30..12:30 only.
const expectedBlocked = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];
const blockedMatch =
  expectedBlocked.every(s => blockedSet.has(s)) &&
  blocked.every(s => expectedBlocked.includes(s));
if (!blockedMatch) {
  failed++;
  console.log(`  ✗ blocked set mismatch — got [${blocked.join(', ')}], expected [${expectedBlocked.join(', ')}]`);
} else {
  console.log(`  ✓ blocked set = [${blocked.join(', ')}]`);
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASS: buffer rule verified (single 1hr buffer, no double-buffer)');
process.exit(0);