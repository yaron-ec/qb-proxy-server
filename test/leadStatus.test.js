/* eslint-disable no-undef */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  CLOSED_LOST_STATUS,
  TERMINAL_LOST_STATUSES,
  isTerminalLostStatus,
  isEnteringTerminalLostStatus,
  isEnteringClosedLost,
} = require('../lib/leadStatus');

test('CLOSED_LOST_STATUS is the exact literal used throughout the CRM', () => {
  assert.strictEqual(CLOSED_LOST_STATUS, 'Closed Lost');
});

test('TERMINAL_LOST_STATUSES covers every real-world "lead is dead" status, including the live-UI-reachable "Lost"', () => {
  assert.deepStrictEqual(TERMINAL_LOST_STATUSES, ['Lost', 'Closed Lost', 'DNQ', 'Cancelled']);
});

test('TERMINAL_LOST_STATUSES deliberately excludes positive outcomes, Duplicate, and unconfirmed-reachable statuses', () => {
  for (const excluded of ['Sold', 'Won', 'Duplicate', 'Archived', 'Closed', 'New', 'Appointment scheduled']) {
    assert.strictEqual(TERMINAL_LOST_STATUSES.includes(excluded), false, `${excluded} must not be in TERMINAL_LOST_STATUSES`);
  }
});

test('isTerminalLostStatus: true for every value in the set, false otherwise', () => {
  assert.strictEqual(isTerminalLostStatus('Lost'), true);
  assert.strictEqual(isTerminalLostStatus('Closed Lost'), true);
  assert.strictEqual(isTerminalLostStatus('DNQ'), true);
  assert.strictEqual(isTerminalLostStatus('Cancelled'), true);
  assert.strictEqual(isTerminalLostStatus('Sold'), false);
  assert.strictEqual(isTerminalLostStatus('New'), false);
  assert.strictEqual(isTerminalLostStatus(null), false);
  assert.strictEqual(isTerminalLostStatus(undefined), false);
});

test('isEnteringTerminalLostStatus: true only on the actual edge into ANY terminal status, including the real-world "Lost" (Rita Wilcher scenario)', () => {
  assert.strictEqual(isEnteringTerminalLostStatus('New', 'Lost'), true);
  assert.strictEqual(isEnteringTerminalLostStatus('Appointment scheduled', 'Lost'), true);
  assert.strictEqual(isEnteringTerminalLostStatus('New', 'Closed Lost'), true);
  assert.strictEqual(isEnteringTerminalLostStatus('New', 'DNQ'), true);
  assert.strictEqual(isEnteringTerminalLostStatus('New', 'Cancelled'), true);
  assert.strictEqual(isEnteringTerminalLostStatus(null, 'Lost'), true);
});

test('isEnteringTerminalLostStatus: false when already in a terminal status (not a re-entry)', () => {
  assert.strictEqual(isEnteringTerminalLostStatus('Lost', 'Lost'), false);
  assert.strictEqual(isEnteringTerminalLostStatus('Closed Lost', 'Closed Lost'), false);
});

test('isEnteringTerminalLostStatus: false when moving BETWEEN two terminal statuses (e.g. Lost -> DNQ)', () => {
  assert.strictEqual(isEnteringTerminalLostStatus('Lost', 'DNQ'), false);
  assert.strictEqual(isEnteringTerminalLostStatus('DNQ', 'Closed Lost'), false);
  assert.strictEqual(isEnteringTerminalLostStatus('Cancelled', 'Lost'), false);
});

test('isEnteringTerminalLostStatus: false when leaving a terminal status (reopening is not an entry)', () => {
  assert.strictEqual(isEnteringTerminalLostStatus('Lost', 'New'), false);
  assert.strictEqual(isEnteringTerminalLostStatus('Closed Lost', 'New'), false);
  assert.strictEqual(isEnteringTerminalLostStatus('Closed Lost', 'Active'), false);
});

test('isEnteringTerminalLostStatus: false for any other status change', () => {
  assert.strictEqual(isEnteringTerminalLostStatus('New', 'Active'), false);
  assert.strictEqual(isEnteringTerminalLostStatus('Active', 'Sold'), false);
});

test('isEnteringClosedLost (deprecated alias) is kept backward compatible: now covers the full terminal set, not just the literal "Closed Lost"', () => {
  // Original literal behavior still holds.
  assert.strictEqual(isEnteringClosedLost('New', 'Closed Lost'), true);
  assert.strictEqual(isEnteringClosedLost('Closed Lost', 'Closed Lost'), false);
  assert.strictEqual(isEnteringClosedLost('Closed Lost', 'New'), false);
  // Generalized: the real-world "Lost" status now also fires through this
  // same alias, so any caller still using the old name is automatically
  // fixed rather than silently continuing to miss the common case.
  assert.strictEqual(isEnteringClosedLost('New', 'Lost'), true);
});
