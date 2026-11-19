/* eslint-disable no-undef */
'use strict';

/**
 * dbClientGuardedConnections.test.js — November 2026 P0 outage fix at its
 * source.
 *
 * Root cause (confirmed via the crash's own stack trace —
 * "Emitted 'error' event on Client instance at: Client._handleErrorEvent"):
 * every long-lived client checked out via `pool.connect()` and held across
 * non-trivial async work (an advisory lock spanning a real QuickBooks
 * network call, a token refresh, a migration run) had NO 'error' listener
 * of its own. `pool.on('error', ...)` in db/client.js only covers IDLE,
 * pool-owned clients — a checked-out client is a separate EventEmitter, and
 * Node's default behavior for an unhandled 'error' event is to THROW,
 * crashing the whole process. A transient Postgres network blip hit exactly
 * this window (a client idle mid-fn(), waiting on a QuickBooks API call)
 * and killed qb-proxy-server outright.
 *
 * Fixed: db/client.js#guardClient(client, label) attaches a listener (never
 * throws) and exposes client._guardErrored() so the caller's own finally
 * block can discard the now-broken connection instead of returning it to
 * the pool. Wired into every pool.connect() call site that holds a client
 * across real async work: lib/advisoryLock.js (both functions),
 * lib/qbEstimateInvoice.js#withDealLock, lib/qbTokenManager.js (both
 * refreshUnderLock and saveAuthorizedTokens), db/migrate.js#runMigrations,
 * and db/client.js#ensureSchema's own rare DDL path.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('guardClient attaches a listener that prevents an unhandled-error crash, and tracks that it fired', () => {
  const { EventEmitter } = require('events');
  const { guardClient } = require('../db/client');
  const fakeClient = new EventEmitter();
  fakeClient.release = () => {};
  const guarded = guardClient(fakeClient, 'test-label');

  assert.strictEqual(typeof guarded._guardErrored, 'function');
  assert.strictEqual(guarded._guardErrored(), false, 'must report false before any error');

  // Without a listener, this line would throw (Node's default 'error' behavior).
  // With guardClient, it must not.
  assert.doesNotThrow(() => {
    guarded.emit('error', new Error('simulated connection drop'));
  });
  assert.strictEqual(guarded._guardErrored(), true, 'must report true after an error fires');
});

test('guardClient logs the label and error message (operator-visible, never silent)', () => {
  const { EventEmitter } = require('events');
  const { guardClient } = require('../db/client');
  const fakeClient = new EventEmitter();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const guarded = guardClient(fakeClient, 'my-label');
    guarded.emit('error', new Error('read ETIMEDOUT'));
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some((l) => l.includes('my-label') && l.includes('read ETIMEDOUT')), `expected a log line naming the label and error, got: ${JSON.stringify(logged)}`);
});

// ── Source-level guards: every long-lived pool.connect() call site must ────
// route through guardClient, and every release() alongside it must consult
// client._guardErrored() so a broken connection is discarded, not recycled.
function sourceOf(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const GUARDED_SITES = [
  { file: 'lib/advisoryLock.js', count: 2 },
  { file: 'lib/qbEstimateInvoice.js', count: 1 },
  { file: 'lib/qbTokenManager.js', count: 2 },
  { file: 'db/migrate.js', count: 1 },
];

for (const { file, count } of GUARDED_SITES) {
  test(`${file}: every pool.connect() call site is wrapped in guardClient, and every release() consults _guardErrored()`, () => {
    const src = sourceOf(file);
    const connectCount = (src.match(/pool\(\)\.connect\(\)|pool\.connect\(\)/g) || []).length;
    const guardedConnectCount = (src.match(/guardClient\(await [^,]*\.connect\(\)/g) || []).length;
    assert.strictEqual(connectCount, count, `expected exactly ${count} pool.connect() call(s) in ${file}, found ${connectCount}`);
    assert.strictEqual(guardedConnectCount, connectCount, `every pool.connect() in ${file} must be wrapped in guardClient(...) — found ${guardedConnectCount} guarded of ${connectCount} total`);
    const releaseWithGuardCheck = (src.match(/client\.release\([^)]*_guardErrored\(\)/g) || []).length;
    assert.strictEqual(releaseWithGuardCheck, count, `every client.release(...) paired with a guarded connect in ${file} must check client._guardErrored() — found ${releaseWithGuardCheck} of ${count}`);
  });
}

test('db/client.js#ensureSchema\'s own rare DDL-path pool.connect() is also guarded', () => {
  const src = sourceOf('db/client.js');
  assert.match(src, /const client = guardClient\(await pool\.connect\(\), 'ensureSchema'\)/);
  assert.match(src, /client\.release\(client\._guardErrored\(\)\)/);
});

test('guardClient is exported from db/client.js', () => {
  const { guardClient } = require('../db/client');
  assert.strictEqual(typeof guardClient, 'function');
});
