/* eslint-disable no-undef */
'use strict';

/**
 * rotateEncryptionKey.int.test.js — REAL-Postgres proof of
 * scripts/rotateEncryptionKey.js: the ENCRYPTION_KEY → ENCRYPTION_KEY_V2
 * migration tool built for the October 2026 Railway security-disclosure
 * credential-rotation response. Seeds real integration_credentials rows
 * encrypted under version 1, then proves report-only leaves them untouched,
 * --apply re-encrypts them to version 2 with a verified round-trip, a
 * second apply run is a no-op (idempotent), and a row whose old-version
 * decrypt fails is reported as an error rather than silently skipped or
 * corrupted. Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

const V1_KEY = 'int-test-v1-key-do-not-use-in-production';
const V2_KEY = 'int-test-v2-key-do-not-use-in-production';
const RUN = `rotkey${Date.now().toString(36)}`;

let db, store;

test.before(async () => {
  if (skip) return;
  process.env.ENCRYPTION_KEY = V1_KEY;
  // Needed in-process too (not just in the spawned script's env below) since
  // this test file calls store.decryptPayload(..., 2) directly to verify
  // what the script wrote.
  process.env.ENCRYPTION_KEY_V2 = V2_KEY;
  db = require(path.join(ROOT, 'db/client'));
  delete require.cache[require.resolve(path.join(ROOT, 'lib/integrationCredentialStore'))];
  store = require(path.join(ROOT, 'lib/integrationCredentialStore'));
});
test.after(async () => {
  if (skip) return;
  await db.query(`DELETE FROM integration_credentials WHERE account_identifier LIKE $1`, [`${RUN}%`]);
  await db.pool.end();
});

function runScript(extra = []) {
  const out = execFileSync(process.execPath, ['scripts/rotateEncryptionKey.js', '--json', ...extra], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB_URL, ENCRYPTION_KEY: V1_KEY, ENCRYPTION_KEY_V2: V2_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return JSON.parse(out.slice(out.indexOf('{')));
}
const host = () => new URL(DB_URL).hostname;

async function seedV1Row(accountSuffix, payload) {
  const enc = store.encryptPayload(payload, 1);
  const r = await db.query(
    `INSERT INTO integration_credentials (provider, credential_type, environment, account_identifier, status, encrypted_payload, key_version)
     VALUES ('test_provider', 'oauth', 'production', $1, 'connected', $2, 1) RETURNING id`,
    [`${RUN}-${accountSuffix}`, enc]
  );
  return r.rows[0].id;
}

test('report-only mode: lists rows needing rotation and changes nothing', { skip }, async () => {
  const id = await seedV1Row('report', { access_token: 'secret-1', refresh_token: 'secret-2' });
  const report = runScript();
  assert.strictEqual(report.mode, 'report-only');
  assert.strictEqual(report.self_check, 'passed');
  assert.ok(report.rows.some((r) => r.account_identifier === `${RUN}-report` && r.current_key_version === 1));

  const after = (await db.query('SELECT key_version FROM integration_credentials WHERE id = $1', [id])).rows[0];
  assert.strictEqual(after.key_version, 1, 'report-only must never write');
});

test('--apply without --confirm-host refuses and changes nothing', { skip }, async () => {
  const id = await seedV1Row('refuse', { access_token: 'secret-3' });
  assert.throws(() => runScript(['--apply']), /confirm-host/);
  const after = (await db.query('SELECT key_version FROM integration_credentials WHERE id = $1', [id])).rows[0];
  assert.strictEqual(after.key_version, 1);
});

test('--apply re-encrypts a version-1 row to version 2 with a verified round-trip, preserving the exact payload', { skip }, async () => {
  const payload = { access_token: 'secret-4', refresh_token: 'secret-5', nested: { ok: true } };
  const id = await seedV1Row('apply', payload);

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  const result = report.results.find((r) => r.account_identifier === `${RUN}-apply`);
  assert.ok(result, 'row is reported');
  assert.strictEqual(result.rotated, true);
  assert.strictEqual(result.from_version, 1);
  assert.strictEqual(result.to_version, 2);

  const row = (await db.query('SELECT encrypted_payload, key_version FROM integration_credentials WHERE id = $1', [id])).rows[0];
  assert.strictEqual(row.key_version, 2);
  const decrypted = store.decryptPayload(row.encrypted_payload, 2);
  assert.deepStrictEqual(decrypted, payload, 'payload must be byte-for-byte identical after rotation');
  // The old version-1 key must NEVER be able to decrypt the new blob.
  assert.throws(() => store.decryptPayload(row.encrypted_payload, 1), /version mismatch/);
});

test('idempotent re-run: a row already at the target version is skipped, not re-rotated', { skip }, async () => {
  const id = await seedV1Row('idempotent', { access_token: 'secret-6' });
  const first = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(first.results.some((r) => r.account_identifier === `${RUN}-idempotent` && r.rotated));

  const second = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(!second.rows.some((r) => r.account_identifier === `${RUN}-idempotent`), 'second run finds nothing left to rotate for this row');

  const row = (await db.query('SELECT key_version FROM integration_credentials WHERE id = $1', [id])).rows[0];
  assert.strictEqual(row.key_version, 2, 'stays at the rotated version — never flips back');
});

test('a row whose stored payload cannot be decrypted under its own recorded key_version is reported as an error, never silently skipped or corrupted', { skip }, async () => {
  const id = (await db.query(
    `INSERT INTO integration_credentials (provider, credential_type, environment, account_identifier, status, encrypted_payload, key_version)
     VALUES ('test_provider', 'oauth', 'production', $1, 'connected', $2, 1) RETURNING id`,
    [`${RUN}-corrupt`, '1:deadbeefdeadbeefdeadbeefdeadbeef:00112233']
  )).rows[0].id;

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  const result = report.results.find((r) => r.account_identifier === `${RUN}-corrupt`);
  assert.ok(result, 'corrupt row is reported');
  assert.ok(result.error, 'reported as an error, not silently skipped');
  assert.ok(!result.rotated);

  const row = (await db.query('SELECT key_version FROM integration_credentials WHERE id = $1', [id])).rows[0];
  assert.strictEqual(row.key_version, 1, 'an unrotatable row is left exactly as it was — never partially written');
});
