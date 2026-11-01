/* eslint-disable no-undef */
'use strict';

/**
 * reminderEngineExtendedEmailWindows.test.js — the new 48h/24h customer
 * EMAIL reminder windows added to lib/reminderEngine.js (November 2026 —
 * approved six-customer-email schedule: immediate confirmation + 48h + 24h +
 * 12h + 2h + 30min). Pure/no-live-DB logic only.
 *
 * Covers: the EMAIL_EXTENDED_REMINDERS_ENABLED kill switch (48h/24h are
 * completely inert by default — deploying this code cannot itself start
 * sending them), that the pre-existing 12h/2h/30min windows are BYTE-FOR-BYTE
 * unaffected by the flag's value either way (the "preserve already-working
 * email functionality" requirement), that SMS stays confirmation+12h+2h
 * regardless of the flag (SMS_WINDOW_KEYS never includes 48h/24h), the
 * catch-up window's "earliest window whose target has passed" semantics with
 * the new windows present, and that a long-past 48h/24h target is correctly
 * excluded from the narrow eligibility band (never a reminder for a window
 * that has already passed).
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  REMINDER_WINDOWS, EXTENDED_EMAIL_WINDOW_KEYS, extendedEmailRemindersEnabled,
  activeReminderWindows, computeWindowsForLead, getAppointmentMs, SMS_WINDOW_KEYS,
} = require('../lib/reminderEngine');

test('REMINDER_WINDOWS: 48h and 24h exist, in descending order ahead of 12h/2h/30min', () => {
  const keys = REMINDER_WINDOWS.map((w) => w.key);
  assert.deepStrictEqual(keys, ['48h', '24h', '12h', '2h', '30min']);
  const by = Object.fromEntries(REMINDER_WINDOWS.map((w) => [w.key, w.minutesBefore]));
  assert.strictEqual(by['48h'], 48 * 60);
  assert.strictEqual(by['24h'], 24 * 60);
});

test('EXTENDED_EMAIL_WINDOW_KEYS contains exactly 48h and 24h', () => {
  assert.deepStrictEqual([...EXTENDED_EMAIL_WINDOW_KEYS].sort(), ['24h', '48h']);
});

test('extendedEmailRemindersEnabled: false/unset by default (safe by default, matching REMINDER_DRY_RUN/SMS_AUTOMATED_REMINDERS_ENABLED precedent)', () => {
  delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  assert.strictEqual(extendedEmailRemindersEnabled(), false);
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'false';
  assert.strictEqual(extendedEmailRemindersEnabled(), false);
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  assert.strictEqual(extendedEmailRemindersEnabled(), true);
  delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
});

test('activeReminderWindows: excludes 48h/24h by default; includes all 5 once explicitly enabled', () => {
  delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  assert.deepStrictEqual(activeReminderWindows().map((w) => w.key), ['12h', '2h', '30min']);
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    assert.deepStrictEqual(activeReminderWindows().map((w) => w.key), ['48h', '24h', '12h', '2h', '30min']);
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});

test('SMS_WINDOW_KEYS never includes 48h/24h regardless of EMAIL_EXTENDED_REMINDERS_ENABLED — SMS schedule is independent of the email flag', () => {
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    assert.deepStrictEqual([...SMS_WINDOW_KEYS].sort(), ['12h', '2h']);
    assert.ok(!SMS_WINDOW_KEYS.has('48h') && !SMS_WINDOW_KEYS.has('24h') && !SMS_WINDOW_KEYS.has('30min'), 'SMS must stay confirmation+12h+2h only, per the approved spec');
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});

test('computeWindowsForLead: flag OFF -> a 48h-out appointment produces NO eligible window yet (inert by default)', () => {
  delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  const now = Date.now();
  const leadCreatedMs = now - 72 * 3600000; // created well before any catch-up window
  const appt = { ms: now + 48 * 3600000 };
  const wins = computeWindowsForLead(appt, leadCreatedMs, now);
  assert.deepStrictEqual(wins, [], 'with the flag off, no window (48h or otherwise) should fire for an appointment 48h out');
});

test('computeWindowsForLead: flag ON -> a 48h-out appointment fires the 48h window exactly (never 24h/12h/2h/30min at the same instant)', () => {
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    const now = Date.now();
    const leadCreatedMs = now - 72 * 3600000;
    const appt = { ms: now + 48 * 3600000 };
    const wins = computeWindowsForLead(appt, leadCreatedMs, now);
    assert.strictEqual(wins.length, 1);
    assert.strictEqual(wins[0].key, '48h');
    assert.strictEqual(wins[0].isCatchUp, false);
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});

test('computeWindowsForLead: flag ON -> a 24h-out appointment fires the 24h window exactly', () => {
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    const now = Date.now();
    const leadCreatedMs = now - 72 * 3600000;
    const appt = { ms: now + 24 * 3600000 };
    const wins = computeWindowsForLead(appt, leadCreatedMs, now);
    assert.strictEqual(wins.length, 1);
    assert.strictEqual(wins[0].key, '24h');
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});

test('computeWindowsForLead: the pre-existing 12h/2h/30min windows are BYTE-FOR-BYTE unaffected by the flag (preserves already-working functionality)', () => {
  const now = Date.now();
  const leadCreatedMs = now - 72 * 3600000;
  for (const minutesBefore of [12 * 60, 2 * 60, 30]) {
    const appt = { ms: now + minutesBefore * 60000 };
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
    const winsOff = computeWindowsForLead(appt, leadCreatedMs, now);
    process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
    const winsOn = computeWindowsForLead(appt, leadCreatedMs, now);
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
    assert.deepStrictEqual(winsOff, winsOn, `window at ${minutesBefore}min-before must be identical regardless of EMAIL_EXTENDED_REMINDERS_ENABLED`);
    assert.strictEqual(winsOff.length, 1);
  }
});

test('computeWindowsForLead: never fires a reminder for a window that has already passed (a 48h target more than 25 minutes in the past is excluded, flag on)', () => {
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    const now = Date.now();
    const leadCreatedMs = now - 72 * 3600000;
    // Appointment is 47 hours out -> the 48h target (appt.ms - 48h) was 1 hour ago, well outside the ~25min live band.
    const appt = { ms: now + 47 * 3600000 };
    const wins = computeWindowsForLead(appt, leadCreatedMs, now);
    assert.deepStrictEqual(wins, [], 'a long-past 48h target must never fire a stale reminder');
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});

test('computeWindowsForLead: catch-up (lead created <24h ago) fires the 48h window first when enabled and multiple windows have already passed', () => {
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    const now = Date.now();
    const leadCreatedMs = now - 60000; // created 1 minute ago -> eligible for catch-up
    // Appointment is only 10 hours out -> the 48h, 24h and 12h targets have ALL already passed;
    // determineCatchUpWindow must pick the FIRST (most generous) one in array order: 48h.
    const appt = { ms: now + 10 * 3600000 };
    const wins = computeWindowsForLead(appt, leadCreatedMs, now);
    assert.strictEqual(wins.length, 1);
    assert.strictEqual(wins[0].key, '48h');
    assert.strictEqual(wins[0].isCatchUp, true);
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});

test('computeWindowsForLead: catch-up still picks 12h (not 48h/24h) when the flag is off, even for a short-notice booking', () => {
  delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  const now = Date.now();
  const leadCreatedMs = now - 60000;
  const appt = { ms: now + 10 * 3600000 };
  const wins = computeWindowsForLead(appt, leadCreatedMs, now);
  assert.strictEqual(wins.length, 1);
  assert.strictEqual(wins[0].key, '12h', 'with 48h/24h inert, the earliest still-active window (12h) is the correct catch-up pick');
  assert.strictEqual(wins[0].isCatchUp, true);
});

test('getAppointmentMs: a cancelled/rescheduled-away appointment (reminder_leads projection cleared appointment_date) is excluded for EVERY window, 48h/24h included — no new exclusion logic needed, this is the SAME existing guard every window already relied on', () => {
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    // Mirrors what lib/reminderProjection.js#syncLeadToReminders already does
    // on cancellation/terminal-lost (clears appointment_date/time) and on a
    // reschedule to a brand-new appointment row (a fresh projection, never a
    // stale leftover) — getAppointmentMs returning null here is what makes
    // the whole lead a no-op for this tick, for every window uniformly.
    const cancelledLead = { appointment_date: null, appointment_time: null };
    assert.strictEqual(getAppointmentMs(cancelledLead, 'America/Los_Angeles'), null);
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});

test('DST integration: a 48h-out appointment landing on the Nov 1 2026 fall-back day computes its target instant via the PR #54-fixed pacificToUtcMs, not the old noon-anchor bug', () => {
  process.env.EMAIL_EXTENDED_REMINDERS_ENABLED = 'true';
  try {
    // Appointment at 00:30 AM Pacific on the fall-back day -- the exact
    // wall-clock hour the pre-PR#54 pacificToUtcMs miscalculated by 1 hour.
    const lead = { appointment_date: '2026-11-01', appointment_time: '00:30', appointment_type: 'Meeting' };
    const appt = getAppointmentMs(lead, 'America/Los_Angeles');
    assert.strictEqual(appt.ms, Date.parse('2026-11-01T07:30:00.000Z'), 'must use the DST-correct PDT offset (-7h), matching test/reminderTime.test.js\'s own fixed-value assertion for this exact date/time');

    // Now prove the 48h window fires correctly relative to that corrected instant.
    const now = appt.ms - 48 * 3600000;
    const leadCreatedMs = now - 72 * 3600000;
    const wins = computeWindowsForLead(appt, leadCreatedMs, now);
    assert.strictEqual(wins.length, 1);
    assert.strictEqual(wins[0].key, '48h');
  } finally {
    delete process.env.EMAIL_EXTENDED_REMINDERS_ENABLED;
  }
});
