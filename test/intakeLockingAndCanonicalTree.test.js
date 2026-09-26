/* eslint-disable no-undef */
'use strict';

/**
 * intakeLockingAndCanonicalTree.test.js — CI guards (no database needed) for:
 *
 * 1. RUNTIME DDL (root cause of the "deadlock detected" → "Submission failed"
 *    intake defect). db/schema.sql is executed only by db/migrate.js; runtime
 *    ensureSchema() is a checksum SELECT once the base schema is recorded, and
 *    per-request column checks read the catalog instead of running
 *    `ALTER TABLE … IF NOT EXISTS` (which takes an AccessExclusiveLock even as
 *    a no-op). Real-Postgres proof: test/integration/leadIntakeConcurrency.int.test.js.
 * 2. INTAKE LOCK ORDER. Every lead-creating transaction first takes sorted,
 *    transaction-scoped advisory locks on the identities it may create or
 *    match (phone / email / external_ref / idempotency key), before any row or
 *    owner-schedule lock.
 * 3. ONE CANONICAL IMPLEMENTATION. The stale top-level src/ tree (older
 *    divergent copies of server.js, routes/routing.js, routes/signnow.js,
 *    lib/googleMapsClient.js and four frontend files, some still documenting
 *    Base44 env vars) and the Base44-builder reminder-action-handoff/ patch
 *    bundle were proven unreferenced and removed; they must not come back or be
 *    wired into any image, service or require.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function jsFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  })(dir);
  return out;
}

// ── 1. Runtime DDL ──────────────────────────────────────────────────────────

function loadClientWithFakePg(checksumRow) {
  const calls = [];
  const fakeClient = {
    query: async (sql, params) => {
      calls.push(String(sql).trim().slice(0, 60));
      if (/SELECT checksum FROM schema_migrations/.test(sql)) return { rows: checksumRow() ? [{ checksum: checksumRow() }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  class Pool {
    constructor() { this.on = () => {}; }
    query(sql, params) { return fakeClient.query(sql, params); }
    connect() { return Promise.resolve(fakeClient); }
  }
  const pgPath = require.resolve('pg');
  const clientPath = require.resolve('../db/client');
  const savedPg = require.cache[pgPath];
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool } };
  delete require.cache[clientPath];
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://fake/fake';
  const client = require('../db/client');
  if (savedPg) require.cache[pgPath] = savedPg; else delete require.cache[pgPath];
  delete require.cache[clientPath];
  return { client, calls, restore: () => { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved; } };
}

test('1a. ensureSchema() runs NO DDL when the recorded base-schema checksum matches (one SELECT, concurrent callers share it)', async () => {
  const crypto = require('crypto');
  const sum = crypto.createHash('sha256').update(read('db/schema.sql')).digest('hex').substring(0, 16);
  const { client, calls, restore } = loadClientWithFakePg(() => sum);
  try {
    await Promise.all([client.ensureSchema(), client.ensureSchema(), client.ensureSchema()]);
    await client.ensureSchema();
    assert.deepStrictEqual(calls.filter(c => !/^SELECT checksum/.test(c)), [], 'no DDL, no advisory lock');
    assert.strictEqual(calls.length, 1, 'exactly one catalog read for the whole process');
  } finally { restore(); }
});

test('1b. a missing/stale checksum applies schema.sql once, under the migration advisory lock with a lock_timeout, and records it', async () => {
  let recorded = null;
  const { client, calls, restore } = loadClientWithFakePg(() => recorded);
  try {
    await client.ensureSchema();
    const idx = (re) => calls.findIndex(c => re.test(c));
    assert.ok(idx(/pg_advisory_lock/) >= 0, 'takes the migration advisory lock');
    assert.ok(idx(/SET lock_timeout/) > idx(/pg_advisory_lock/), 'bounded lock wait at runtime');
    assert.ok(calls.some(c => /INSERT INTO schema_migrations/.test(c)), 'records the checksum');
    assert.ok(idx(/pg_advisory_unlock/) > idx(/INSERT INTO schema_migrations/), 'releases the lock after');
    assert.ok(calls.some(c => /SET statement_timeout = '10s'/.test(c)), 'restores the pooled statement_timeout');
  } finally { restore(); }
});

test('1c. db/migrate.js applies the base schema on its own locked client (never a second connection)', () => {
  const src = read('db/migrate.js');
  assert.match(src, /await db\.applyBaseSchema\(client\)/);
  assert.doesNotMatch(src, /db\.ensureSchema\(/);
  assert.match(src, /const ADVISORY_LOCK_KEY = db\.MIGRATION_LOCK_KEY/);
});

test('1d. no request/worker code runs ALTER TABLE … ADD COLUMN IF NOT EXISTS (catalog-checked ensureColumns instead)', () => {
  const offenders = [];
  for (const f of [...jsFiles('lib'), ...jsFiles('routes')]) {
    if (/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS/.test(read(f))) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, []);
  assert.match(read('db/client.js'), /information_schema\.columns/);
});

// ── 2. Intake lock order ────────────────────────────────────────────────────

const { identityLockKeys, lockLeadIdentity, INTAKE_LOCK_NAMESPACE } = require('../lib/booking/leadResolution');
const { APPOINTMENT_LOCK_NAMESPACE } = require('../lib/booking/appointmentWriter');

test('2a. identity keys are normalized so every intake path locks the same person identically', () => {
  const a = identityLockKeys({ email: ' Dana@Example.COM ', phone: '+1 (310) 555-0101' });
  const b = identityLockKeys({ email: 'dana@example.com', phone: '3105550101' });
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(identityLockKeys({ external_ref: 'ec-website-lead-x', idempotency_key: 'k' }), ['ref:ec-website-lead-x', 'idem:k']);
  assert.deepStrictEqual(identityLockKeys({ phone: '12' }), [], 'too-short phone is not an identity');
  assert.notStrictEqual(INTAKE_LOCK_NAMESPACE, APPOINTMENT_LOCK_NAMESPACE);
});

test('2b. lockLeadIdentity acquires transaction-scoped locks in ascending hash order (deadlock-free)', async () => {
  const issued = [];
  const client = {
    query: async (sql, params) => {
      if (/hashtext/.test(sql)) return { rows: [{ h: 900 }, { h: -5 }, { h: 42 }] };
      issued.push([sql, params]);
      return { rows: [] };
    },
  };
  await lockLeadIdentity(client, { email: 'a@b.co', phone: '3105550101', external_ref: 'r' });
  assert.deepStrictEqual(issued.map(([, p]) => p[1]), [-5, 42, 900]);
  assert.ok(issued.every(([sql, p]) => /pg_advisory_xact_lock/.test(sql) && p[0] === INTAKE_LOCK_NAMESPACE));
  const none = [];
  await lockLeadIdentity({ query: async (s) => { none.push(s); return { rows: [] }; } }, {});
  assert.deepStrictEqual(none, [], 'no identity → no locking, no query');
});

test('2c. createBooking takes the identity lock FIRST (before idempotency, owner, lead or schedule locks)', () => {
  const src = read('lib/booking/bookingService.js');
  const body = src.slice(src.indexOf('async function createBooking('), src.indexOf('async function cancelAppointment('));
  const at = (s) => body.indexOf(s);
  assert.ok(at("await client.query('BEGIN')") >= 0);
  assert.ok(at('await lockLeadIdentity(client') > at("await client.query('BEGIN')"));
  for (const later of ['FROM booking_idempotency', 'resolveOwnerClient(client', 'resolveLead(client', 'assertSlotFree(client']) {
    assert.ok(at(later) > at('await lockLeadIdentity(client'), `${later} comes after the identity lock`);
  }
  assert.match(body, /withTxRetry\('createBooking'/, 'bounded deadlock/serialization retry as defense in depth');
  assert.match(src, /RETRYABLE_PG_CODES = new Set\(\['40P01', '40001'\]\)/);
});

test('2d. admin create re-checks duplicates inside its transaction under the same identity lock', () => {
  const src = read('routes/leads.js');
  const tx = src.slice(src.indexOf("await client.query('BEGIN');\n      await lockLeadIdentity(client, { email, phone });"));
  assert.ok(tx.length > 0, 'identity lock right after BEGIN');
  assert.ok(tx.indexOf('findCreateDuplicate(client, email, phone)') < tx.indexOf('INSERT INTO leads'));
});

test('2e. a new owner is created race-safely (owners.email UNIQUE → ON CONFLICT, then re-read)', () => {
  assert.match(read('lib/booking/bookingService.js'), /INSERT INTO owners \(email, display_name\) VALUES \(\$1, \$2\) ON CONFLICT \(email\) DO NOTHING RETURNING \*/);
});

test('2f. a redelivered Meta lead-only webhook is an idempotent no-op (external_ref UNIQUE)', () => {
  assert.match(read('routes/metaWebhook.js'), /ON CONFLICT \(external_ref\) DO NOTHING\s+RETURNING id/);
});

// ── 3. One canonical implementation ─────────────────────────────────────────

test('3a. the stale src/ tree and the Base44-builder handoff bundle stay deleted', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'src')), false, 'canonical backend = repo root; canonical frontend = crm-frontend/');
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'reminder-action-handoff')), false);
});

test('3b. no image, service, script or module references a src/ implementation', () => {
  for (const f of ['Dockerfile', 'Dockerfile.worker', 'railway.json', 'package.json', '.github/workflows/ci.yml']) {
    assert.doesNotMatch(read(f), /(^|[\s"'(./])src\//m, `${f} must not reference src/`);
  }
  const offenders = [];
  const roots = ['server.js', 'reminderWorker.js', 'reminderWatchdog.js', 'productionWatchdog.js', 'validateRuntime.js'];
  for (const f of [...roots, ...jsFiles('lib'), ...jsFiles('routes'), ...jsFiles('scripts'), ...jsFiles('db'), ...jsFiles('test')]) {
    if (/require\(\s*['"][./]*src\//.test(read(f)) || /src\/proxy-server/.test(read(f))) offenders.push(f);
  }
  assert.deepStrictEqual(offenders.filter(f => f !== path.join('test', 'intakeLockingAndCanonicalTree.test.js')), []);
});

// ── 4. Base44: no code path of any kind ─────────────────────────────────────

test('4a. no shipped backend or frontend code uses the Base44 SDK, API credentials or migration helpers', () => {
  const pattern = /@base44\/sdk|BASE44_API_KEY|BASE44_APP_ID|VITE_BASE44|base44_access_token|migrationHelpers/;
  const files = [
    'server.js', 'reminderWorker.js', 'reminderWatchdog.js', 'productionWatchdog.js', 'validateRuntime.js',
    ...jsFiles('lib'), ...jsFiles('routes'), ...jsFiles('scripts'), ...jsFiles('db'),
  ];
  (function walk(d) {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.jsx?$/.test(e.name)) files.push(rel);
    }
  })(path.join('crm-frontend', 'src'));
  const offenders = files.filter(f => {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return pattern.test(code);
  });
  assert.deepStrictEqual(offenders, []);
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'crm-frontend/src/lib/app-params.js')), false,
    'the Base44 URL-token/app-id module stays deleted');
});

test('4b. the Base44-comparing system-wide-reconciliation endpoint stays removed', () => {
  assert.doesNotMatch(read('routes/cronJobs.js'), /system-wide-reconciliation|systemWideReconciliation/);
});
