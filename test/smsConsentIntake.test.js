/* eslint-disable no-undef */
'use strict';

/**
 * smsConsentIntake.test.js — lib/smsConsentIntake.js's pure logic (a fake
 * queryFn, no real DB) for both call sites: the phone-intake checkbox
 * (applyAppointmentSmsConsent, called inside bookingService.createBooking's
 * transaction) and a later authorized Lead Detail change
 * (recordManualConsentChange, routes/leads.js's PUT /:id/sms-consent).
 *
 * The highest-stakes case here: a STOP opt-out is NEVER overridden by either
 * path — granting consent is refused, with an activity note explaining why,
 * never silently granted and never silently dropped.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  applyAppointmentSmsConsent, recordManualConsentChange, isPhoneOptedOut,
  PHONE_INTAKE_CONSENT_SOURCE, MANUAL_UPDATE_SOURCE,
} = require('../lib/smsConsentIntake');

function fakeDb({ phone = '3105551234', optedOut = false } = {}) {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT phone FROM leads/.test(sql)) return { rows: [{ phone }] };
    if (/SELECT opted_out FROM sms_opt_outs/.test(sql)) return { rows: optedOut ? [{ opted_out: true }] : [] };
    if (/UPDATE leads SET/.test(sql)) return { rows: [] };
    if (/INSERT INTO activities/.test(sql)) return { rows: [] };
    throw new Error('unexpected query: ' + sql);
  };
  return { queryFn, calls };
}

// ── applyAppointmentSmsConsent (phone intake) ───────────────────────────────

test('applyAppointmentSmsConsent: unchecked box -> no-op, no DB writes at all', async () => {
  const { queryFn, calls } = fakeDb();
  const res = await applyAppointmentSmsConsent(queryFn, 'lead-1', { confirmed: false });
  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.reason, 'not_confirmed');
  assert.strictEqual(calls.length, 0, 'must never touch the DB when the box was not checked');
});

test('applyAppointmentSmsConsent: confirmed + not opted out -> sets consent, source, recorded_by, and logs an activity note', async () => {
  const { queryFn, calls } = fakeDb({ optedOut: false });
  const res = await applyAppointmentSmsConsent(queryFn, 'lead-1', { confirmed: true, recordedBy: 'mike@ecconstructiongroup.com' });
  assert.strictEqual(res.applied, true);
  const update = calls.find(c => /UPDATE leads SET/.test(c.sql));
  assert.ok(update, 'expected an UPDATE leads');
  assert.match(update.sql, /sms_consent = true/);
  assert.match(update.sql, /sms_consent_recorded_by/);
  assert.ok(update.params.includes(PHONE_INTAKE_CONSENT_SOURCE));
  assert.ok(update.params.includes('mike@ecconstructiongroup.com'));
  const note = calls.find(c => /INSERT INTO activities/.test(c.sql));
  assert.ok(note, 'expected an activities audit-trail note');
  assert.match(note.params[1], /SMS consent confirmed/);
});

test('applyAppointmentSmsConsent: NEVER overrides an existing STOP opt-out — consent is not granted, a note explains why', async () => {
  const { queryFn, calls } = fakeDb({ optedOut: true });
  const res = await applyAppointmentSmsConsent(queryFn, 'lead-1', { confirmed: true, recordedBy: 'mike@ecconstructiongroup.com' });
  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.reason, 'opted_out');
  assert.ok(!calls.some(c => /UPDATE leads SET/.test(c.sql)), 'must never write sms_consent=true for an opted-out number');
  const note = calls.find(c => /INSERT INTO activities/.test(c.sql));
  assert.ok(note, 'expected an explanatory activity note even though consent was refused');
  assert.match(note.params[1], /opted out/);
});

test('applyAppointmentSmsConsent: lead has no phone -> no-op, never crashes', async () => {
  const { queryFn } = fakeDb({ phone: null });
  const res = await applyAppointmentSmsConsent(queryFn, 'lead-1', { confirmed: true });
  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.reason, 'no_phone');
});

test('applyAppointmentSmsConsent: lead not found -> no-op, never crashes', async () => {
  const queryFn = async (sql) => {
    if (/SELECT phone FROM leads/.test(sql)) return { rows: [] };
    throw new Error('unexpected query: ' + sql);
  };
  const res = await applyAppointmentSmsConsent(queryFn, 'missing-lead', { confirmed: true });
  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.reason, 'lead_not_found');
});

// ── recordManualConsentChange (Lead Detail, authorized later change) ───────

test('recordManualConsentChange: grant, not opted out -> sets consent true with the manual-update source + actor + evidence note', async () => {
  const { queryFn, calls } = fakeDb({ optedOut: false });
  const res = await recordManualConsentChange(queryFn, 'lead-1', { confirmed: true, actor: 'admin@ecconstructiongroup.com', evidenceNote: 'Customer confirmed by text.' });
  assert.strictEqual(res.applied, true);
  const update = calls.find(c => /UPDATE leads SET/.test(c.sql));
  assert.match(update.sql, /sms_consent = true/);
  assert.ok(update.params.includes(MANUAL_UPDATE_SOURCE));
  const note = calls.find(c => /INSERT INTO activities/.test(c.sql));
  assert.match(note.params[1], /re-confirmed/);
  assert.match(note.params[1], /Customer confirmed by text\./);
});

test('recordManualConsentChange: grant is refused for an opted-out number — never silently overrides STOP', async () => {
  const { queryFn, calls } = fakeDb({ optedOut: true });
  const res = await recordManualConsentChange(queryFn, 'lead-1', { confirmed: true, actor: 'admin@ecconstructiongroup.com' });
  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.reason, 'opted_out');
  assert.ok(!calls.some(c => /UPDATE leads SET/.test(c.sql)));
});

test('recordManualConsentChange: revoke is ALWAYS allowed, even for an opted-out number (it can only reduce sending)', async () => {
  const { queryFn, calls } = fakeDb({ optedOut: true });
  const res = await recordManualConsentChange(queryFn, 'lead-1', { confirmed: false, actor: 'admin@ecconstructiongroup.com', evidenceNote: 'Customer asked to stop by phone.' });
  assert.strictEqual(res.applied, true);
  const update = calls.find(c => /UPDATE leads SET/.test(c.sql));
  assert.match(update.sql, /sms_consent = false/);
  const note = calls.find(c => /INSERT INTO activities/.test(c.sql));
  assert.match(note.params[1], /revoked/);
});

// ── isPhoneOptedOut ──────────────────────────────────────────────────────────

test('isPhoneOptedOut: normalizes the phone before checking sms_opt_outs', async () => {
  let queriedWith = null;
  const queryFn = async (sql, params) => { queriedWith = params; return { rows: [{ opted_out: true }] }; };
  const out = await isPhoneOptedOut(queryFn, '+1 (310) 555-1234');
  assert.strictEqual(out, true);
  assert.strictEqual(queriedWith[0], '3105551234');
});

test('isPhoneOptedOut: no phone -> false, never queries', async () => {
  let called = false;
  const queryFn = async () => { called = true; return { rows: [] }; };
  const out = await isPhoneOptedOut(queryFn, '');
  assert.strictEqual(out, false);
  assert.strictEqual(called, false);
});
