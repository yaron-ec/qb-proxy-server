/* eslint-disable no-undef */
'use strict';

/**
 * localeConfig.test.js — PRODUCTIZATION PHASE 2: proves
 * lib/reminderTime.js#formatDate (used in customer-facing reminder emails —
 * lib/reminderEngine.js, lib/phoneCallReminders.js) respects the
 * installation's configured locale (company_settings.locale) instead of a
 * hardcoded 'en-US' literal.
 */
const test = require('node:test');
const assert = require('node:assert');
const { formatDate } = require('../lib/reminderTime');

test('default (no locale passed) preserves EC\'s historical en-US format', () => {
  assert.strictEqual(formatDate('2026-07-22'), 'Wednesday, July 22, 2026');
});

test('a configured non-default locale produces a genuinely different format, not a hidden en-US assumption', () => {
  const enUS = formatDate('2026-07-22', 'en-US');
  const enGB = formatDate('2026-07-22', 'en-GB');
  assert.notStrictEqual(enUS, enGB);
  assert.strictEqual(enUS, 'Wednesday, July 22, 2026');
  assert.strictEqual(enGB, 'Wednesday, 22 July 2026');
});
