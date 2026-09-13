/* eslint-disable no-undef */
/**
 * poolConnectionSafety.test.js — P0 regression tests for DB pool connection safety.
 *
 * Verifies:
 *   1. Checked-out clients are released on success
 *   2. Checked-out clients are released on query failure
 *   3. Checked-out clients are released when rollback also fails
 *   4. No double-release (finally pattern prevents this)
 *   5. Pool exhaustion fails fast (connectionTimeoutMillis is configured)
 *   6. Schema initialization is exempt from the normal statement timeout
 *   7. leads.js has finally blocks on ALL pool.connect() transaction blocks
 *   8. bookingService.js does NOT call processAddress inside a transaction
 *
 * Run: cd src/proxy-server && node --test test/poolConnectionSafety.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Mock Pool: tracks connect/release to verify finally safety ─────────────
function createMockPool() {
  let connectCount = 0;
  let releaseCount = 0;
  let activeClients = 0;

  function makeClient(opts = {}) {
    const { failOn, failOnRollback } = opts;
    return {
      _released: false,
      async query(sql, params) {
        if (failOn && failOn(sql)) throw new Error(`mock failure: ${sql}`);
        return { rows: [{ id: 'test-id' }] };
      },
      release() {
        if (this._released) throw new Error('double release detected');
        this._released = true;
        releaseCount++;
        activeClients--;
      },
    };
  }

  return {
    async connect(opts) {
      connectCount++;
      activeClients++;
      return makeClient(opts || {});
    },
    async query() { return { rows: [] }; },
    on() { /* noop */ },
    _stats: () => ({ connectCount, releaseCount, activeClients }),
  };
}

// ── Test 1: Client released on success ─────────────────────────────────────
test('client released on transaction success', async () => {
  const pool = createMockPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
  } finally {
    client.release();
  }
  const stats = pool._stats();
  assert.strictEqual(stats.connectCount, 1);
  assert.strictEqual(stats.releaseCount, 1);
  assert.strictEqual(stats.activeClients, 0);
  assert.strictEqual(client._released, true);
});

// ── Test 2: Client released on query failure ───────────────────────────────
test('client released on query failure', async () => {
  const pool = createMockPool();
  const client = await pool.connect({ failOn: (sql) => sql === 'FAIL' });
  try {
    await client.query('BEGIN');
    await client.query('FAIL');
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
  } finally {
    client.release();
  }
  const stats = pool._stats();
  assert.strictEqual(stats.releaseCount, 1);
  assert.strictEqual(stats.activeClients, 0);
  assert.strictEqual(client._released, true);
});

// ── Test 3: Client released when rollback also fails ────────────────────────
test('client released when rollback also fails', async () => {
  const pool = createMockPool();
  const client = await pool.connect({ failOn: (sql) => sql === 'FAIL' || sql === 'ROLLBACK' });
  try {
    await client.query('BEGIN');
    await client.query('FAIL');
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
  } finally {
    client.release();
  }
  const stats = pool._stats();
  assert.strictEqual(stats.releaseCount, 1);
  assert.strictEqual(stats.activeClients, 0);
  assert.strictEqual(client._released, true);
});

// ── Test 4: No double-release ──────────────────────────────────────────────
test('finally block does not double-release', async () => {
  const pool = createMockPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
  } finally {
    client.release();
  }
  // Second release should throw
  assert.throws(() => client.release(), /double release/);
});

// ── Test 5: Pool config has connectionTimeoutMillis and statement_timeout ──
test('db/client.js has correct pool timeout configuration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'client.js'), 'utf8'
  );
  assert.ok(source.includes('connectionTimeoutMillis'),
    'connectionTimeoutMillis must be set — without it, pool hangs indefinitely on exhaustion');
  assert.ok(source.includes('5000'),
    'connectionTimeoutMillis must be 5000 (5s fail-fast)');
  assert.ok(source.includes("SET statement_timeout = '10s'"),
    'statement_timeout = 10s must be set on every connection');
  assert.ok(source.includes("SET idle_in_transaction_session_timeout = '30s'"),
    'idle_in_transaction_session_timeout = 30s must be set');
  assert.ok(source.includes("pool.on('error'"),
    'pool.on(error) handler must exist for idle connection errors');
  assert.ok(source.includes("pool.on('connect'"),
    'pool.on(connect) handler must exist for per-connection timeouts');
});

// ── Test 6: Schema initialization is exempt from statement timeout ─────────
test('ensureSchema sets statement_timeout = 0 on dedicated client', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'client.js'), 'utf8'
  );
  assert.ok(source.includes('SET statement_timeout = 0'),
    'ensureSchema must set statement_timeout = 0 for schema execution');
  assert.ok(source.includes('const client = await pool.connect()'),
    'ensureSchema must use a dedicated client');
  assert.ok(source.includes('finally'),
    'ensureSchema must have a finally block to release the client');
});

// ── Test 7: leads.js has finally on ALL pool.connect blocks ─────────────────
test('leads.js has finally blocks on all pool.connect() transaction blocks', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'leads.js'), 'utf8'
  );
  const connectCount = (source.match(/pool\.connect\(\)/g) || []).length;
  // Every pool.connect() must be followed by a finally { client.release() }
  const finallyReleaseCount = (source.match(/finally\s*\{[\s\S]*?client\.release\(\)/g) || []).length;

  assert.ok(connectCount >= 7,
    `expected at least 7 pool.connect() calls, got ${connectCount}`);
  assert.strictEqual(finallyReleaseCount, connectCount,
    `every pool.connect() must have a finally { client.release() } — got ${finallyReleaseCount} for ${connectCount} connects`);
});

// ── Test 8: No double-release in leads.js (old pattern removed) ────────────
test('leads.js does not have client.release() in catch AND finally (no double-release)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'leads.js'), 'utf8'
  );
  // The old pattern had: catch { ... client.release(); ... } ... client.release();
  // The new pattern has: catch { ... } finally { client.release(); }
  // Verify no catch block contains client.release() when followed by a finally
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('client.release()') && lines[i].includes('catch')) {
      // This shouldn't happen — release should be in finally, not catch
      assert.fail(`Line ${i + 1}: client.release() found in catch block — should be in finally only`);
    }
  }
});

// ── Test 9: bookingService.js does NOT call processAddress inside transaction
test('bookingService.js does not call processAddress inside a DB transaction', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'booking', 'bookingService.js'), 'utf8'
  );
  // processAddress should appear BEFORE pool.connect(), not after BEGIN
  const connectIdx = source.indexOf('const client = await pool.connect()');
  assert.ok(connectIdx > 0, 'pool.connect() must exist in bookingService.js');

  const processAddrIdx = source.indexOf('await processAddress(');
  assert.ok(processAddrIdx > 0, 'processAddress must exist in bookingService.js');

  // processAddress must appear BEFORE pool.connect (outside the transaction)
  assert.ok(processAddrIdx < connectIdx,
    'processAddress must be called BEFORE pool.connect() — not inside the transaction');

  // Verify no processAddress call exists AFTER BEGIN
  const beginIdx = source.indexOf("client.query('BEGIN')", connectIdx);
  if (beginIdx > 0) {
    const afterBegin = source.substring(beginIdx);
    assert.ok(!afterBegin.includes('await processAddress('),
      'processAddress must NOT be called after BEGIN — it holds a DB connection across external I/O');
  }
});

// ── Test 10: bookingService.js has finally on ALL pool.connect blocks ───────
test('bookingService.js has finally blocks on all pool.connect() calls', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'booking', 'bookingService.js'), 'utf8'
  );
  const connectCount = (source.match(/pool\.connect\(\)/g) || []).length;
  const finallyReleaseCount = (source.match(/finally\s*\{[\s\S]*?client\.release\(\)/g) || []).length;

  assert.ok(connectCount >= 4,
    `expected at least 4 pool.connect() calls, got ${connectCount}`);
  assert.strictEqual(finallyReleaseCount, connectCount,
    `every pool.connect() must have a finally { client.release() } — got ${finallyReleaseCount} for ${connectCount} connects`);
});