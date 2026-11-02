/* eslint-disable no-undef */
'use strict';

/**
 * reminderDeliveryDiagnostics.test.js — pure unit coverage for
 * lib/reminderDeliveryDiagnostics.js's classification functions
 * (classifyClaimRow, classifyConfirmationSms), the core logic behind the
 * new admin-only Appointment Notification Diagnostics panel (November
 * 2026). No DB — these functions take plain objects and return a plain
 * classification; getAppointmentNotificationDiagnostics()'s own DB
 * wiring (SELECTs only) is covered at the route level in
 * test/reminderDiagnosticsRoute.test.js and via this file's source-level
 * checks confirming it never issues anything but SELECT statements.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { classifyClaimRow, classifyConfirmationSms, getReminderDeliveryDiagnostics } = require('../lib/reminderDeliveryDiagnostics');

const NOW = Date.UTC(2026, 10, 2, 18, 0, 0); // 2026-11-02T18:00:00Z

test('classifyClaimRow: email window, claim sent -> "Sent", never claims delivery (Gmail has no delivery tracking)', () => {
  const r = classifyClaimRow({ claim: { status: 'sent' }, smsMessage: null, channel: 'email', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'sent');
  assert.strictEqual(r.label, 'Sent');
  assert.match(r.detail, /does not track email delivery/);
});

test('classifyClaimRow: sms window, claim sent + sms_messages delivered -> "Delivered"', () => {
  const r = classifyClaimRow({ claim: { status: 'sent' }, smsMessage: { status: 'delivered' }, channel: 'sms', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'delivered');
  assert.strictEqual(r.label, 'Delivered');
});

test('classifyClaimRow: sms window, claim sent + sms_messages undelivered/failed/canceled -> "Failed" with error detail', () => {
  for (const status of ['undelivered', 'failed', 'canceled']) {
    const r = classifyClaimRow({ claim: { status: 'sent' }, smsMessage: { status, error_message: 'carrier rejected' }, channel: 'sms', nowMs: NOW, targetMs: NOW - 1000 });
    assert.strictEqual(r.outcome, 'failed', `status=${status}`);
    assert.strictEqual(r.detail, 'carrier rejected');
  }
});

test('classifyClaimRow: sms window, claim sent but no matching sms_messages row -> "Sent" with an honest caveat, never fabricated "Delivered"', () => {
  const r = classifyClaimRow({ claim: { status: 'sent' }, smsMessage: null, channel: 'sms', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'sent');
  assert.match(r.detail, /no matching sms_messages record/);
});

test('classifyClaimRow: skipped with a recorded reason (post PR #56) -> "Skipped" + the exact reason, never invented', () => {
  const r = classifyClaimRow({ claim: { status: 'skipped_no_recipient', last_error_type: 'no_consent' }, smsMessage: null, channel: 'sms', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'skipped');
  assert.strictEqual(r.reason, 'no_consent');
});

for (const reason of ['recipient_opted_out', 'no_phone', 'twilio_not_configured']) {
  test(`classifyClaimRow: skipped with reason "${reason}" is passed through exactly`, () => {
    const r = classifyClaimRow({ claim: { status: 'skipped_no_recipient', last_error_type: reason }, smsMessage: null, channel: 'sms', nowMs: NOW, targetMs: NOW - 1000 });
    assert.strictEqual(r.reason, reason);
  });
}

test('classifyClaimRow: sms skip with NO recorded reason (pre PR #56) -> explains why the reason is unavailable, never guesses one', () => {
  const r = classifyClaimRow({ claim: { status: 'skipped_no_recipient', last_error_type: null }, smsMessage: null, channel: 'sms', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'skipped');
  assert.match(r.reason, /before the skip-reason persistence fix/);
});

test('classifyClaimRow: email skip with no reason -> a generic, email-appropriate explanation (email never carries a reason code)', () => {
  const r = classifyClaimRow({ claim: { status: 'skipped_no_recipient', last_error_type: null }, smsMessage: null, channel: 'email', nowMs: NOW, targetMs: NOW - 1000 });
  assert.match(r.reason, /no eligible recipient/i);
});

test('classifyClaimRow: failed claim with last_error_type=quiet_hours -> "Pending retry", never a terminal "Failed"', () => {
  const r = classifyClaimRow({ claim: { status: 'failed', last_error_type: 'quiet_hours', last_error: 'outside hours' }, smsMessage: null, channel: 'sms', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'pending_retry');
  assert.match(r.label, /Pending retry/);
});

test('classifyClaimRow: failed claim with a non-quiet_hours reason -> "Failed"', () => {
  const r = classifyClaimRow({ claim: { status: 'failed', last_error_type: 'gmail_send', last_error: 'boom' }, smsMessage: null, channel: 'email', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'failed');
});

test('classifyClaimRow: processing claim -> "In progress"', () => {
  const r = classifyClaimRow({ claim: { status: 'processing' }, smsMessage: null, channel: 'email', nowMs: NOW, targetMs: NOW - 1000 });
  assert.strictEqual(r.outcome, 'in_progress');
});

test('classifyClaimRow: no claim, target time still in the future -> "Not yet due", never "skipped"', () => {
  const r = classifyClaimRow({ claim: null, smsMessage: null, channel: 'email', nowMs: NOW, targetMs: NOW + 60 * 60 * 1000 });
  assert.strictEqual(r.outcome, 'not_yet_due');
});

test('classifyClaimRow: no claim, target time already passed -> "No record / not verified", never inferred as "skipped" (requirement: do not infer missing rows mean sent or skipped)', () => {
  const r = classifyClaimRow({ claim: null, smsMessage: null, channel: 'sms', nowMs: NOW, targetMs: NOW - 60 * 60 * 1000 });
  assert.strictEqual(r.outcome, 'no_record');
  assert.doesNotMatch(r.label.toLowerCase(), /skip/);
});

test('classifyClaimRow: no claim and no target time available at all -> "No record / not verified" with an explanatory detail', () => {
  const r = classifyClaimRow({ claim: null, smsMessage: null, channel: 'email', nowMs: NOW, targetMs: null });
  assert.strictEqual(r.outcome, 'no_record');
  assert.match(r.detail, /No appointment date\/time available/);
});

test('classifyConfirmationSms: no sms_messages row -> "No record / not verified", never "Skipped" (no persisted evidence to support that label)', () => {
  const r = classifyConfirmationSms(null);
  assert.strictEqual(r.outcome, 'no_record');
});

test('classifyConfirmationSms: delivered / failed / otherwise sent', () => {
  assert.strictEqual(classifyConfirmationSms({ status: 'delivered' }).outcome, 'delivered');
  assert.strictEqual(classifyConfirmationSms({ status: 'failed', error_message: 'x' }).outcome, 'failed');
  assert.strictEqual(classifyConfirmationSms({ status: 'queued' }).outcome, 'sent');
});

test('source-level: getReminderDeliveryDiagnostics issues only SELECT statements — purely read-only, same as its pre-extraction form', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/reminderDeliveryDiagnostics.js'), 'utf8');
  const sqlLiterals = source.match(/`\s*(SELECT|INSERT|UPDATE|DELETE)[\s\S]*?`/gi) || [];
  assert.ok(sqlLiterals.length > 0, 'expected to find SQL template literals in the file');
  for (const sql of sqlLiterals) {
    assert.match(sql.trim(), /^`\s*SELECT/i, `found a non-SELECT statement: ${sql.slice(0, 80)}`);
  }
});

test('source-level: getAppointmentNotificationDiagnostics resolves reminder_claims/reminder_leads by the SAME id formula as lib/reminderProjection.js#reminderIdFor (external_ref || id), and sms_messages by the real leads.id', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/reminderDeliveryDiagnostics.js'), 'utf8');
  assert.match(source, /reminderLeadId\s*=\s*leadRow\.external_ref\s*\|\|\s*leadRow\.id/);
  assert.match(source, /FROM reminder_claims WHERE lead_id = \$1[\s\S]*\[reminderLeadId\]/);
  assert.match(source, /FROM sms_messages WHERE lead_id = \$1[\s\S]*\[leadRow\.id\]/);
});

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

test('getReminderDeliveryDiagnostics: lead not found reports found:false (unchanged pre-existing behavior)', async () => {
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [] }) });
  delete require.cache[require.resolve('../lib/reminderDeliveryDiagnostics')];
  const fresh = require('../lib/reminderDeliveryDiagnostics');
  try {
    const result = await fresh.getReminderDeliveryDiagnostics({ lead_id: 'does-not-exist' });
    assert.strictEqual(result.found, false);
  } finally {
    restoreDb();
    delete require.cache[require.resolve('../lib/reminderDeliveryDiagnostics')];
  }
});
