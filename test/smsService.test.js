/* eslint-disable no-undef */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectKeyword, isQuietHours, QUIET_HOURS_START, QUIET_HOURS_END } = require('../lib/smsService');

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
