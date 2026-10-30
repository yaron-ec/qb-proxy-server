/* eslint-disable no-undef */
'use strict';

/**
 * syncOutcome.test.js — lib/syncOutcome.js, the shared classifier both QB
 * crons use (October 2026 reliability pass) to decide what to persist to
 * sync_cursors: a clean run advances last_successful_sync_at, anything else
 * advances only last_attempted_at.
 */
const test = require('node:test');
const assert = require('node:assert');
const { classifySyncOutcome, isSuccessfulOutcome } = require('../lib/syncOutcome');

test('no_work: nothing was attempted', () => {
  assert.strictEqual(classifySyncOutcome({ attempted: 0, succeeded: 0, failed: 0, stoppedEarly: false }), 'no_work');
});

test('success: everything attempted succeeded, no early stop', () => {
  assert.strictEqual(classifySyncOutcome({ attempted: 100, succeeded: 100, failed: 0, stoppedEarly: false }), 'success');
});

test('blocked: stopped early with zero successes (breaker open before/at the first item)', () => {
  assert.strictEqual(classifySyncOutcome({ attempted: 100, succeeded: 0, failed: 0, stoppedEarly: true }), 'blocked');
});

test('partial: stopped early after at least one success', () => {
  assert.strictEqual(classifySyncOutcome({ attempted: 100, succeeded: 40, failed: 0, stoppedEarly: true }), 'partial');
});

test('partial: completed (not breaker-blocked) with a mix of success and failure', () => {
  assert.strictEqual(classifySyncOutcome({ attempted: 100, succeeded: 60, failed: 40, stoppedEarly: false }), 'partial');
});

test('failed: completed (not breaker-blocked) and every item failed', () => {
  assert.strictEqual(classifySyncOutcome({ attempted: 100, succeeded: 0, failed: 100, stoppedEarly: false }), 'failed');
});

test('isSuccessfulOutcome: only success and no_work advance last_successful_sync_at', () => {
  assert.strictEqual(isSuccessfulOutcome('success'), true);
  assert.strictEqual(isSuccessfulOutcome('no_work'), true);
  assert.strictEqual(isSuccessfulOutcome('partial'), false);
  assert.strictEqual(isSuccessfulOutcome('blocked'), false);
  assert.strictEqual(isSuccessfulOutcome('failed'), false);
});

test('defaults: an empty object classifies as no_work rather than throwing', () => {
  assert.strictEqual(classifySyncOutcome({}), 'no_work');
});
