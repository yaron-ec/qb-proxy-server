/* eslint-disable no-undef */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CLOSED_LOST_STATUS, isEnteringClosedLost } = require('../lib/leadStatus');

test('CLOSED_LOST_STATUS is the exact literal used throughout the CRM', () => {
  assert.strictEqual(CLOSED_LOST_STATUS, 'Closed Lost');
});

test('isEnteringClosedLost: true only on the actual edge (old != Closed Lost, new == Closed Lost)', () => {
  assert.strictEqual(isEnteringClosedLost('New', 'Closed Lost'), true);
  assert.strictEqual(isEnteringClosedLost('Active', 'Closed Lost'), true);
  assert.strictEqual(isEnteringClosedLost(null, 'Closed Lost'), true);
});

test('isEnteringClosedLost: false when already Closed Lost (not a re-entry)', () => {
  assert.strictEqual(isEnteringClosedLost('Closed Lost', 'Closed Lost'), false);
});

test('isEnteringClosedLost: false when leaving Closed Lost (reopening is not an entry)', () => {
  assert.strictEqual(isEnteringClosedLost('Closed Lost', 'New'), false);
  assert.strictEqual(isEnteringClosedLost('Closed Lost', 'Active'), false);
});

test('isEnteringClosedLost: false for any other status change', () => {
  assert.strictEqual(isEnteringClosedLost('New', 'Active'), false);
  assert.strictEqual(isEnteringClosedLost('Active', 'Sold'), false);
});
