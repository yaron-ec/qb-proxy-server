/* eslint-disable no-undef */
'use strict';

/**
 * qbRateLimitBreaker.int.test.js — REAL-Postgres proof of
 * lib/qbRateLimitBreaker.js's closed/open/half-open state machine. The
 * module's correctness hinges entirely on atomic single-row jsonb UPDATEs
 * (conditional on the row's current state) being race-safe across
 * concurrent callers/processes — exactly what a fake query stub can't
 * actually prove, so this runs against a real, disposable Postgres.
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, breaker;
if (DB_URL) {
  db = require('../../db/client');
  breaker = require('../../lib/qbRateLimitBreaker');
}

test.beforeEach(async () => {
  if (!DB_URL) return;
  await db.query(`DELETE FROM app_settings WHERE key = $1`, [breaker.KEY]);
});

test('closed by default: a fresh row allows every call and starts with zero failures', { skip }, async () => {
  const gate = await breaker.checkAndMaybeAllow();
  assert.deepStrictEqual(gate, { allow: true, state: gate.state });
  assert.strictEqual(gate.state.state, 'closed');
  assert.strictEqual(gate.state.consecutive_failures, 0);
});

test('a lone failure never opens the breaker; it keeps allowing calls', { skip }, async () => {
  await breaker.recordFailure(429);
  const gate = await breaker.checkAndMaybeAllow();
  assert.strictEqual(gate.allow, true);
  assert.strictEqual(gate.state.state, 'closed');
  assert.strictEqual(gate.state.consecutive_failures, 1);
});

test('a success resets the consecutive-failure count back to zero', { skip }, async () => {
  await breaker.recordFailure(429);
  await breaker.recordFailure(429);
  await breaker.recordSuccess();
  const gate = await breaker.checkAndMaybeAllow();
  assert.strictEqual(gate.state.consecutive_failures, 0);
});

test('SUSTAINED failures (hitting FAILURE_THRESHOLD) open the breaker and deny further calls until the cooldown', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  const gate = await breaker.checkAndMaybeAllow();
  assert.strictEqual(gate.allow, false);
  assert.strictEqual(gate.reason, 'cooldown');
  assert.strictEqual(gate.state.state, 'open');
  assert.strictEqual(gate.state.opens_count, 1);
  assert.ok(new Date(gate.retryAt).getTime() > Date.now(), 'cooldown is in the future');
});

test('while open and still cooling down, every concurrent caller is denied — never a network call let through', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  const gates = await Promise.all([breaker.checkAndMaybeAllow(), breaker.checkAndMaybeAllow(), breaker.checkAndMaybeAllow()]);
  for (const g of gates) assert.strictEqual(g.allow, false);
});

test('once the cooldown elapses, exactly ONE caller among many concurrent ones wins the half-open trial', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  // Force the cooldown into the past so it reads as elapsed.
  await db.query(
    `UPDATE app_settings SET value = jsonb_set(value, '{cooldown_until}', to_jsonb((NOW() - interval '1 second')::text)) WHERE key = $1`,
    [breaker.KEY]
  );
  const gates = await Promise.all(Array.from({ length: 8 }, () => breaker.checkAndMaybeAllow()));
  const winners = gates.filter((g) => g.allow);
  assert.strictEqual(winners.length, 1, 'exactly one caller gets the trial slot');
  assert.strictEqual(winners[0].trial, true);
  const losers = gates.filter((g) => !g.allow);
  assert.strictEqual(losers.length, 7);
});

test('a successful half-open trial closes the breaker completely (fresh state, zero failures)', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  await db.query(
    `UPDATE app_settings SET value = jsonb_set(value, '{cooldown_until}', to_jsonb((NOW() - interval '1 second')::text)) WHERE key = $1`,
    [breaker.KEY]
  );
  const gate = await breaker.checkAndMaybeAllow();
  assert.strictEqual(gate.trial, true);
  await breaker.recordSuccess();
  const after = await breaker.getState();
  assert.strictEqual(after.state, 'closed');
  assert.strictEqual(after.consecutive_failures, 0);
  const next = await breaker.checkAndMaybeAllow();
  assert.strictEqual(next.allow, true);
  assert.strictEqual(next.trial, undefined, 'back to ordinary closed operation, not another trial');
});

test('a FAILED half-open trial reopens with a longer (doubled, capped) cooldown — never shorter', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  const firstOpenState = await breaker.getState();
  const firstCooldownUntil = new Date(firstOpenState.cooldown_until).getTime();
  await db.query(
    `UPDATE app_settings SET value = jsonb_set(value, '{cooldown_until}', to_jsonb((NOW() - interval '1 second')::text)) WHERE key = $1`,
    [breaker.KEY]
  );
  const trial = await breaker.checkAndMaybeAllow();
  assert.strictEqual(trial.trial, true);
  const beforeFailAt = Date.now();
  await breaker.recordFailure(503);
  const reopened = await breaker.getState();
  assert.strictEqual(reopened.state, 'open');
  assert.strictEqual(reopened.opens_count, 2, 'second open — cooldown should have at least doubled the base');
  const secondCooldownMs = new Date(reopened.cooldown_until).getTime() - beforeFailAt;
  assert.ok(secondCooldownMs >= breaker.BASE_COOLDOWN_MS * 2 - 1000, `expected roughly doubled cooldown, got ${secondCooldownMs}ms`);
  assert.ok(new Date(reopened.cooldown_until).getTime() > firstCooldownUntil - 1000);
});

test('cooldown growth is capped at MAX_COOLDOWN_MS even after many repeated reopens', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  for (let round = 0; round < 6; round++) {
    await db.query(
      `UPDATE app_settings SET value = jsonb_set(value, '{cooldown_until}', to_jsonb((NOW() - interval '1 second')::text)) WHERE key = $1`,
      [breaker.KEY]
    );
    const trial = await breaker.checkAndMaybeAllow();
    assert.strictEqual(trial.trial, true);
    const before = Date.now();
    await breaker.recordFailure(429);
    const state = await breaker.getState();
    const cooldownMs = new Date(state.cooldown_until).getTime() - before;
    assert.ok(cooldownMs <= breaker.MAX_COOLDOWN_MS + 5000, `round ${round}: cooldown ${cooldownMs}ms must never exceed the cap plus jitter`);
  }
});

test('a half-open trial that never reports back self-recovers after HALF_OPEN_TIMEOUT_MS instead of deadlocking forever', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  await db.query(
    `UPDATE app_settings SET value = jsonb_set(value, '{cooldown_until}', to_jsonb((NOW() - interval '1 second')::text)) WHERE key = $1`,
    [breaker.KEY]
  );
  const trial = await breaker.checkAndMaybeAllow();
  assert.strictEqual(trial.trial, true);
  // Simulate the trial caller crashing before recordSuccess/recordFailure —
  // age the half_open_since timestamp past the self-recovery window instead
  // of actually sleeping HALF_OPEN_TIMEOUT_MS in a test.
  await db.query(
    `UPDATE app_settings SET value = jsonb_set(value, '{half_open_since}', to_jsonb((NOW() - interval '1 minute')::text)) WHERE key = $1`,
    [breaker.KEY]
  );
  const recovered = await breaker.checkAndMaybeAllow();
  assert.strictEqual(recovered.allow, true, 'a fresh trial is granted instead of staying stuck in half_open forever');
  assert.strictEqual(recovered.trial, true);
});

test('a still-in-progress half-open trial denies other concurrent callers (not yet timed out)', { skip }, async () => {
  for (let i = 0; i < breaker.FAILURE_THRESHOLD; i++) await breaker.recordFailure(429);
  await db.query(
    `UPDATE app_settings SET value = jsonb_set(value, '{cooldown_until}', to_jsonb((NOW() - interval '1 second')::text)) WHERE key = $1`,
    [breaker.KEY]
  );
  const trial = await breaker.checkAndMaybeAllow();
  assert.strictEqual(trial.trial, true);
  const other = await breaker.checkAndMaybeAllow();
  assert.strictEqual(other.allow, false);
  assert.strictEqual(other.reason, 'half_open_in_progress');
});
