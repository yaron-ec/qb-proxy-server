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
  for (const fn of ['getState', 'checkAndMaybeAllow', 'recordSuccess', 'recordFailure', 'isCoolingDown']) {
    assert.strictEqual(typeof breaker[fn], 'function', `${fn} must be exported`);
  }
});

// October 2026 "still 429ing after the breaker shipped" incident, round 3:
// MAX_COOLDOWN_MS was originally 10 minutes — strictly LESS than the
// 15-minute interval both QB crons run on — so once opens_count grew large
// enough to hit the cap, the cooldown had always already elapsed by the next
// tick, meaning every tick spent its one half-open trial against the real
// Intuit API no matter how long the underlying rate-limit had actually been
// sustained. This is the regression guard: the cap must stay strictly
// greater than the 15-minute cron interval so a sustained block gets at
// least one full tick of real silence before being probed again.
const QB_CRON_INTERVAL_MS = 15 * 60 * 1000;
test('MAX_COOLDOWN_MS stays strictly greater than the 15-minute QB cron interval', () => {
  assert.ok(
    breaker.MAX_COOLDOWN_MS > QB_CRON_INTERVAL_MS,
    `MAX_COOLDOWN_MS (${breaker.MAX_COOLDOWN_MS}ms) must exceed the cron interval (${QB_CRON_INTERVAL_MS}ms) or every tick re-probes a still-sustained rate limit`
  );
});

test('isCoolingDown: true only for an open breaker whose cooldown has not yet elapsed', () => {
  const future = new Date(Date.now() + 60000).toISOString();
  const past = new Date(Date.now() - 60000).toISOString();
  assert.strictEqual(breaker.isCoolingDown({ state: 'open', cooldown_until: future }), true);
  assert.strictEqual(breaker.isCoolingDown({ state: 'open', cooldown_until: past }), false, 'cooldown already elapsed');
  assert.strictEqual(breaker.isCoolingDown({ state: 'open', cooldown_until: null }), false, 'no cooldown_until at all');
  assert.strictEqual(breaker.isCoolingDown({ state: 'closed', cooldown_until: future }), false, 'not open');
  assert.strictEqual(breaker.isCoolingDown({ state: 'half_open', cooldown_until: future }), false, 'half_open is not "cooling down"');
  assert.strictEqual(breaker.isCoolingDown(null), false);
  assert.strictEqual(breaker.isCoolingDown(undefined), false);
});
