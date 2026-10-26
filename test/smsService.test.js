/* eslint-disable no-undef */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectKeyword, isQuietHours, QUIET_HOURS_START, QUIET_HOURS_END, KNOWN_SMS_STATUSES, normalizeSmsStatus, OUTBOUND_STATUS_RANK } = require('../lib/smsService');

// ── OUTBOUND_STATUS_RANK — October 2026 production report: the out-of-order/
// duplicate status-callback regression guard in handleStatusCallback (see
// test/integration/sms.int.test.js for the real-Postgres behavioral proof;
// these are the pure-data-shape checks).
test('OUTBOUND_STATUS_RANK: every KNOWN_SMS_STATUSES outbound-reachable status has a rank (inbound-only receiving/received are exempt)', () => {
  for (const s of KNOWN_SMS_STATUSES) {
    if (s === 'received' || s === 'receiving') continue;
    assert.strictEqual(typeof OUTBOUND_STATUS_RANK[s], 'number', `expected a rank for "${s}"`);
  }
});

test('OUTBOUND_STATUS_RANK: the lifecycle progresses strictly forward up to "sent"', () => {
  assert.ok(OUTBOUND_STATUS_RANK.accepted < OUTBOUND_STATUS_RANK.queued);
  assert.ok(OUTBOUND_STATUS_RANK.queued < OUTBOUND_STATUS_RANK.sending);
  assert.ok(OUTBOUND_STATUS_RANK.sending < OUTBOUND_STATUS_RANK.sent);
  assert.ok(OUTBOUND_STATUS_RANK.sent < OUTBOUND_STATUS_RANK.delivered);
});

test('OUTBOUND_STATUS_RANK: every truly terminal status shares the same (highest) rank — none supersedes another', () => {
  const terminalRanks = new Set(['delivered', 'undelivered', 'failed', 'canceled'].map((s) => OUTBOUND_STATUS_RANK[s]));
  assert.strictEqual(terminalRanks.size, 1, 'delivered/undelivered/failed/canceled must all share one rank');
});

// ── KNOWN_SMS_STATUSES / normalizeSmsStatus — production incident regression
// (October 2026): a real manual SMS send failed with "new row for relation
// sms_messages violates check constraint sms_messages_status_check" because
// Twilio's real initial status for a Messaging-Service send is 'accepted',
// not 'queued', and smsClient.js passes Twilio's status through verbatim.
// See db/migrations/2026-65-sms-messages-status-check-widen.sql and
// test/integration/sms.int.test.js (real-Postgres reproduction + proof of
// fix) for the full story. These are the pure-function-level checks.
test('KNOWN_SMS_STATUSES includes every real Twilio Message-resource status this installation can receive (plain two-way SMS, Messaging Service or bare From, no Schedule Send, no WhatsApp)', () => {
  for (const s of ['accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'canceled', 'receiving', 'received']) {
    assert.ok(KNOWN_SMS_STATUSES.has(s), `expected "${s}" to be a known status`);
  }
});

test('KNOWN_SMS_STATUSES deliberately excludes statuses this integration cannot produce (WhatsApp read receipts, broadcast partial-delivery, Schedule Send) — not guessed in', () => {
  for (const s of ['read', 'partially_delivered', 'scheduled']) {
    assert.ok(!KNOWN_SMS_STATUSES.has(s), `"${s}" should not be allowed — this integration never uses that feature`);
  }
});

test('normalizeSmsStatus: a known status passes through unchanged', () => {
  assert.strictEqual(normalizeSmsStatus('accepted', 'queued'), 'accepted');
  assert.strictEqual(normalizeSmsStatus('delivered', 'queued'), 'delivered');
});

test('normalizeSmsStatus: an unrecognized status falls back to the given safe value instead of being returned as-is', () => {
  assert.strictEqual(normalizeSmsStatus('some_future_twilio_status', 'queued'), 'queued');
});

test('detectKeyword: recognizes every documented STOP-equivalent keyword, case-insensitively', () => {
  for (const kw of ['stop', 'STOP', 'StopAll', 'unsubscribe', 'Cancel', 'END', 'quit']) {
    assert.strictEqual(detectKeyword(kw), 'STOP', `expected STOP for "${kw}"`);
  }
});

test('detectKeyword: recognizes every documented START-equivalent keyword, case-insensitively', () => {
  for (const kw of ['start', 'START', 'Yes', 'unstop']) {
    assert.strictEqual(detectKeyword(kw), 'START', `expected START for "${kw}"`);
  }
});

test('detectKeyword: recognizes HELP/INFO, case-insensitively', () => {
  assert.strictEqual(detectKeyword('help'), 'HELP');
  assert.strictEqual(detectKeyword('INFO'), 'HELP');
});

test('detectKeyword: tolerates surrounding whitespace', () => {
  assert.strictEqual(detectKeyword('  stop  '), 'STOP');
});

test('detectKeyword: only matches the WHOLE message, never a substring — "please stop" is an ordinary message, not a keyword', () => {
  assert.strictEqual(detectKeyword('please stop texting me'), null);
  assert.strictEqual(detectKeyword('Can you help me with my estimate?'), null);
});

test('detectKeyword: an ordinary conversational reply is never misdetected', () => {
  assert.strictEqual(detectKeyword('Yes, that time works for me!'), null, 'punctuation/extra words must not match START\'s "Yes"');
  assert.strictEqual(detectKeyword(''), null);
  assert.strictEqual(detectKeyword(null), null);
});

test('isQuietHours: a time inside the default 8:00-21:00 Pacific window is NOT quiet hours', () => {
  // 2026-06-15T18:00:00Z = 11:00 AM Pacific (PDT, UTC-7) in summer.
  const noon = new Date('2026-06-15T18:00:00Z');
  assert.strictEqual(isQuietHours(noon, 'America/Los_Angeles'), false);
});

test('isQuietHours: a time outside the window (late night) IS quiet hours', () => {
  // 2026-06-15T09:00:00Z = 2:00 AM Pacific.
  const lateNight = new Date('2026-06-15T09:00:00Z');
  assert.strictEqual(isQuietHours(lateNight, 'America/Los_Angeles'), true);
});

test('isQuietHours: exact boundary hours are documented and consistent (QUIET_HOURS_START/END exports match env defaults)', () => {
  assert.strictEqual(QUIET_HOURS_START, 8);
  assert.strictEqual(QUIET_HOURS_END, 21);
});
