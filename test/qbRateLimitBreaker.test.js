/* eslint-disable no-undef */
'use strict';

/**
 * qbRateLimitBreaker.test.js — pure unit coverage for the parts of
 * lib/qbRateLimitBreaker.js that don't need real Postgres (the exponential/
 * capped/jittered cooldown formula). The actual closed/open/half-open state
 * machine — which depends entirely on atomic single-row UPDATE semantics —
 * is proven against real Postgres in
 * test/integration/qbRateLimitBreaker.int.test.js instead of faked here.
 */
const test = require('node:test');
const assert = require('node:assert');
const breaker = require('../lib/qbRateLimitBreaker');

test('_computeCooldownMs: doubles per open, capped at MAX_COOLDOWN_MS, plus bounded jitter', () => {
  for (let opensCount = 1; opensCount <= 10; opensCount++) {
    const ms = breaker._computeCooldownMs(opensCount);
    const base = Math.min(breaker.BASE_COOLDOWN_MS * Math.pow(2, opensCount - 1), breaker.MAX_COOLDOWN_MS);
    assert.ok(ms >= base, `opensCount=${opensCount}: ${ms} should be at least the un-jittered base ${base}`);
    assert.ok(ms <= base + 5000, `opensCount=${opensCount}: jitter must be bounded`);
    assert.ok(ms <= breaker.MAX_COOLDOWN_MS + 5000, `opensCount=${opensCount}: never exceeds the hard cap plus jitter`);
  }
});

test('_computeCooldownMs: first open is roughly BASE_COOLDOWN_MS, never less', () => {
  const ms = breaker._computeCooldownMs(1);
  assert.ok(ms >= breaker.BASE_COOLDOWN_MS);
  assert.ok(ms < breaker.BASE_COOLDOWN_MS + 5000);
});

test('module exports the documented constants and functions', () => {
  assert.strictEqual(typeof breaker.FAILURE_THRESHOLD, 'number');
  assert.strictEqual(typeof breaker.BASE_COOLDOWN_MS, 'number');
  assert.strictEqual(typeof breaker.MAX_COOLDOWN_MS, 'number');
  assert.strictEqual(typeof breaker.HALF_OPEN_TIMEOUT_MS, 'number');
  assert.ok(breaker.MAX_COOLDOWN_MS > breaker.BASE_COOLDOWN_MS);
  for (const fn of ['getState', 'checkAndMaybeAllow', 'recordSuccess', 'recordFailure']) {
    assert.strictEqual(typeof breaker[fn], 'function', `${fn} must be exported`);
  }
});
