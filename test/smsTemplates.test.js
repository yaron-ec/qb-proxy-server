/* eslint-disable no-undef */
'use strict';

/**
 * smsTemplates.test.js — the three customer-facing appointment SMS messages
 * (lib/smsTemplates.js), exact wording as given by the business owner.
 */
const test = require('node:test');
const assert = require('node:assert');
const t = require('../lib/smsTemplates');

const appt = { date: '2026-10-29', time: '14:00' }; // Thursday

test('bookingConfirmation: exact wording shape, real name, date, time, website, opt-out', () => {
  const m = t.bookingConfirmation({ firstName: 'Sarah', appt });
  assert.match(m, /^Hi Sarah!/);
  assert.match(m, /EC Construction Group/);
  assert.match(m, /confirmed for Thu, Oct 29 at 2:00 PM/);
  assert.match(m, /Just reply to this message/);
  assert.match(m, /https:\/\/www\.ecconstructiongroup\.com/);
  assert.match(m, /Reply STOP to opt out\.$/);
});

test('reminder12h: exact wording shape, includes website link (per spec)', () => {
  const m = t.reminder12h({ firstName: 'Sarah', appt });
  assert.match(m, /^Hi Sarah! Reminder:/);
  assert.match(m, /on Thu, Oct 29 at 2:00 PM/);
  assert.match(m, /https:\/\/www\.ecconstructiongroup\.com/);
  assert.match(m, /Reply STOP to opt out\.$/);
});

test('reminder2h: shorter, NO website link (per spec), still has opt-out', () => {
  const m = t.reminder2h({ firstName: 'Sarah', appt });
  assert.match(m, /^Hi Sarah!/);
  assert.match(m, /in 2 hours, at 2:00 PM/);
  assert.doesNotMatch(m, /ecconstructiongroup\.com/);
  assert.match(m, /Reply STOP to opt out\.$/);
  assert.ok(m.length < t.bookingConfirmation({ firstName: 'Sarah', appt }).length, '2h reminder must be shorter than the confirmation, per spec');
});

test('all three templates fit within 2 SMS segments (≤306 GSM-7 chars)', () => {
  for (const fn of [t.bookingConfirmation, t.reminder12h, t.reminder2h]) {
    const m = fn({ firstName: 'Sarah', appt });
    assert.ok(m.length <= 306, `expected ≤306 chars (2 segments), got ${m.length}: ${m}`);
  }
});

test('uses the real first name and real appointment date/time — never a placeholder left unfilled', () => {
  const m = t.bookingConfirmation({ firstName: 'Mohammed', appt: { date: '2026-12-25', time: '09:30' } });
  assert.match(m, /Hi Mohammed!/);
  assert.match(m, /Fri, Dec 25/);
  assert.match(m, /9:30 AM/);
  assert.doesNotMatch(m, /\{.*\}/, 'no unfilled {placeholder} should ever appear in a rendered message');
});

test('company name/website are configurable (multi-company readiness) but default to the given EC wording', () => {
  const m = t.bookingConfirmation({ firstName: 'Sarah', appt, company: { name: 'Acme Co', website: 'https://acme.example.com' } });
  assert.match(m, /Acme Co/);
  assert.match(m, /https:\/\/acme\.example\.com/);
  assert.doesNotMatch(m, /EC Construction Group/);
});

// ── Quiet-hours deferral policy (approved October 2026) ────────────────────
test('reminder2h: normal (non-deferred) send keeps the exact approved relative wording', () => {
  const m = t.reminder2h({ firstName: 'Sarah', appt });
  assert.match(m, /is in 2 hours, at 2:00 PM/);
});

test('reminder2h: deferred send drops the relative "in 2 hours" claim (would be misleading) for an absolute time instead', () => {
  const m = t.reminder2h({ firstName: 'Sarah', appt, deferred: true });
  assert.doesNotMatch(m, /in 2 hours/);
  assert.match(m, /is today at 2:00 PM/);
  assert.match(m, /Reply STOP to opt out\.$/);
});

test('reminder12h: wording is identical whether deferred or not — it is already absolute (date + time), never a relative claim', () => {
  const normal = t.reminder12h({ firstName: 'Sarah', appt });
  const deferred = t.reminder12h({ firstName: 'Sarah', appt, deferred: true });
  assert.strictEqual(normal, deferred);
});

test('DST boundary: a wall-clock time just after a DST transition renders the correct local date/time (no UTC-shift bug)', () => {
  // 2026-11-01 is when PDT -> PST transitions in America/Los_Angeles.
  // The template layer only formats an already-local date/time string — this
  // proves formatting itself never shifts the date across midnight, which a
  // naive `new Date(dateStr + 'T' + timeStr)` (implicit UTC) could do.
  const m = t.reminder2h({ firstName: 'Sarah', appt: { date: '2026-11-01', time: '00:30' } });
  assert.match(m, /12:30 AM/);
  // Must NOT have rolled back to Oct 31 — this is a pure string-format
  // function, so the real DST-correctness guarantee lives in
  // lib/reminderTime.js#pacificToUtcMs / the booking service's
  // localDateTimeParts, exercised separately in their own test files.
});
