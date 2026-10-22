/* eslint-disable no-undef */
'use strict';

/**
 * reminderEngineSms.test.js — the new 12h/2h customer SMS reminder windows
 * added to lib/reminderEngine.js (confirmation is a SEPARATE, one-time send
 * in bookingService.js — not covered here; see bookingSmsConfirmation.test.js).
 *
 * Covers: window scoping (12h/2h only, never 30min), no catch-up/stale sends
 * for short-notice bookings, the SMS_AUTOMATED_REMINDERS_ENABLED kill switch,
 * the enabled_modules.sms gate, and that an SmsError (consent/opt-out/quiet-
 * hours/etc.) from smsService is treated as a non-fatal skip, never thrown.
 * Full end-to-end (a real reminder claim + a fake Twilio client) is in
 * test/integration/smsAppointmentLifecycle.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { sendWindowSms, smsReminderKey, SMS_WINDOW_KEYS, REMINDER_WINDOWS } = require('../lib/reminderEngine');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

test('SMS_WINDOW_KEYS only contains 12h and 2h — never 30min (staff/email-only window)', () => {
  assert.deepStrictEqual([...SMS_WINDOW_KEYS].sort(), ['12h', '2h']);
  assert.ok(REMINDER_WINDOWS.some((w) => w.key === '30min'), 'sanity: 30min window still exists for email');
});

test('smsReminderKey produces a namespace DISTINCT from the email reminderKey (never collides)', () => {
  const { reminderKey } = require('../lib/reminderEngine');
  const email = reminderKey('lead-1', '12h', '2026-10-29');
  const sms = smsReminderKey('lead-1', '12h', '2026-10-29');
  assert.notStrictEqual(email, sms);
  assert.match(sms, /^sms-reminder:/);
});

test('sendWindowSms: a catch-up window (short-notice booking) is NEVER attempted — no stale "in 12 hours" SMS', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    const res = await sendWindowSms({ id: 'lead-1', first_name: 'Sarah' }, { key: '12h', isCatchUp: true }, { date: '2026-10-29', time: '14:00' });
    assert.strictEqual(res.attempted, false);
  } finally { delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('sendWindowSms: the 30min window is never attempted (SMS is 12h/2h only)', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    const res = await sendWindowSms({ id: 'lead-1' }, { key: '30min', isCatchUp: false }, { date: '2026-10-29', time: '14:00' });
    assert.strictEqual(res.attempted, false);
  } finally { delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('sendWindowSms: SMS_AUTOMATED_REMINDERS_ENABLED unset -> never attempted (deploy cannot itself activate sending)', async () => {
  delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  const res = await sendWindowSms({ id: 'lead-1' }, { key: '12h', isCatchUp: false }, { date: '2026-10-29', time: '14:00' });
  assert.strictEqual(res.attempted, false);
});

test('sendWindowSms: enabled_modules.sms off -> never attempted even with the kill switch on', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  const restore = stub('../lib/companyConfig', {
    isModuleEnabled: async () => false,
    getCompanyConfig: async () => ({}),
  });
  try {
    const res = await sendWindowSms({ id: 'lead-1' }, { key: '2h', isCatchUp: false }, { date: '2026-10-29', time: '14:00' });
    assert.strictEqual(res.attempted, false);
  } finally { restore(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('sendWindowSms: when enabled, calls smsService.sendSms with the correct template body for the window', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  const restoreCfg = stub('../lib/companyConfig', {
    isModuleEnabled: async () => true,
    getCompanyConfig: async () => ({ company_name: 'EC Construction Group', company_website: 'https://www.ecconstructiongroup.com' }),
  });
  let sentWith = null;
  const restoreSms = stub('../lib/smsService', {
    sendSms: async (args) => { sentWith = args; return { id: 'row-1' }; },
    SmsError: class SmsError extends Error {},
  });
  try {
    const res = await sendWindowSms({ id: 'lead-1', first_name: 'Sarah' }, { key: '12h', isCatchUp: false }, { date: '2026-10-29', time: '14:00' });
    assert.strictEqual(res.attempted, true);
    assert.strictEqual(res.sent, true);
    assert.strictEqual(sentWith.leadId, 'lead-1');
    assert.match(sentWith.body, /Reminder: Your EC Construction Group appointment is on/);
    assert.match(sentWith.body, /2:00 PM/);
  } finally { restoreCfg(); restoreSms(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('sendWindowSms: 2h window uses the 2h template, not the 12h one', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  const restoreCfg = stub('../lib/companyConfig', { isModuleEnabled: async () => true, getCompanyConfig: async () => ({}) });
  let sentWith = null;
  const restoreSms = stub('../lib/smsService', { sendSms: async (args) => { sentWith = args; return {}; }, SmsError: class extends Error {} });
  try {
    await sendWindowSms({ id: 'lead-1', first_name: 'Sarah' }, { key: '2h', isCatchUp: false }, { date: '2026-10-29', time: '14:00' });
    assert.match(sentWith.body, /is in 2 hours, at 2:00 PM/);
    assert.doesNotMatch(sentWith.body, /Reminder:/);
  } finally { restoreCfg(); restoreSms(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('sendWindowSms: deferred:true passes through to the 2h template (non-misleading wording) and tags sentBy for traceability', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  const restoreCfg = stub('../lib/companyConfig', { isModuleEnabled: async () => true, getCompanyConfig: async () => ({}) });
  let sentWith = null;
  const restoreSms = stub('../lib/smsService', { sendSms: async (args) => { sentWith = args; return {}; }, SmsError: class extends Error {} });
  try {
    await sendWindowSms({ id: 'lead-1', first_name: 'Sarah' }, { key: '2h', isCatchUp: false }, { date: '2026-10-29', time: '14:00' }, { deferred: true });
    assert.match(sentWith.body, /is today at 2:00 PM/);
    assert.doesNotMatch(sentWith.body, /in 2 hours/);
    assert.match(sentWith.sentBy, /_deferred$/);
  } finally { restoreCfg(); restoreSms(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('sendWindowSms: deferred:true on the 12h window is a wording no-op (already absolute)', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  const restoreCfg = stub('../lib/companyConfig', { isModuleEnabled: async () => true, getCompanyConfig: async () => ({}) });
  let sentWith = null;
  const restoreSms = stub('../lib/smsService', { sendSms: async (args) => { sentWith = args; return {}; }, SmsError: class extends Error {} });
  try {
    await sendWindowSms({ id: 'lead-1', first_name: 'Sarah' }, { key: '12h', isCatchUp: false }, { date: '2026-10-29', time: '14:00' }, { deferred: true });
    assert.match(sentWith.body, /Reminder: Your .* appointment is on/);
  } finally { restoreCfg(); restoreSms(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});

test('sendWindowSms: a rejected send (SmsError — e.g. quiet hours, opt-out, no consent) is a non-fatal skip, never thrown', async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  class SmsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const restoreCfg = stub('../lib/companyConfig', { isModuleEnabled: async () => true, getCompanyConfig: async () => ({}) });
  const restoreSms = stub('../lib/smsService', {
    sendSms: async () => { throw new SmsError('quiet_hours', 'outside sending window'); },
    SmsError,
  });
  try {
    const res = await sendWindowSms({ id: 'lead-1', first_name: 'Sarah' }, { key: '2h', isCatchUp: false }, { date: '2026-10-29', time: '14:00' });
    assert.strictEqual(res.attempted, true);
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'quiet_hours');
  } finally { restoreCfg(); restoreSms(); delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED; }
});
