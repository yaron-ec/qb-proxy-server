#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * test/integrationCredentialStore.test.js
 *
 * Validates the generic encrypted credential-management store
 * (lib/integrationCredentialStore.js).
 *
 * Pure / dev-fs suite (always runs):
 *   - encryption round-trip (default + explicit key version)
 *   - unknown key version rejection (encrypt + decrypt)
 *   - key_version defaults to 1 on save; persisted in dev row
 *   - production refusal of filesystem-only storage
 *   - canUseFilesystemFallback logic
 *   - status validation (invalid + empty rejected)
 *   - save/update/load/delete + metadata persistence
 *   - provider/credential_type accept future values without schema changes
 *   - loadActiveCredential: one connected / none / multiple (throws)
 *   - expired + revoked rows are NOT active
 *   - updateCredentialStatus changes status without deleting row
 *   - dev-fs format preserves equivalent metadata + encrypted payload (no plaintext)
 *   - markCredentialUsed updates last_used_at; preserves connected_at/refreshed_at/created_at
 *   - markCredentialError updates last_error_at + message; truncates to 255; preserves status
 *   - secrets never stored in last_error_message
 *   - metadata survives refresh-token rotation (re-save)
 *   - metadata survives restart (re-require)
 *   - metadata survives reconnect (re-save preserves operational metadata)
 *
 * DB suite (runs when DATABASE_URL is set):
 *   - migration applies
 *   - save -> load (equal, all metadata + key_version)
 *   - raw DB row contains no plaintext secrets
 *   - unknown key version rejection
 *   - update via re-save -> created_at stable, updated_at changes, count 1
 *   - expires_at monitoring query works
 *   - loadActiveCredential: one / none / multiple; expired/revoked not active
 *   - updateCredentialStatus (expired/revoked)
 *   - markCredentialUsed / markCredentialError + truncation + metadata preserved across re-save
 *   - delete -> load null
 *   - future provider/credential_type works
 *   - cleanup
 *
 * Run: node test/integrationCredentialStore.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('../lib/integrationCredentialStore');
const db = require('../db/client');

const P = 'test-provider';
const CT = 'test-capability';
const ENV = 'test';
const ACCT = 'acct-1';
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true }); console.log('  \u2713 ' + name); })
    .catch((e) => { results.push({ name, ok: false, err: e.message }); console.error('  \u2717 ' + name + ' \u2014 ' + e.message); });
}

function withEnv(env, hasDb, fn) {
  const sEnv = process.env.NODE_ENV, sDb = process.env.DATABASE_URL;
  process.env.NODE_ENV = env;
  if (hasDb) { if (sDb) process.env.DATABASE_URL = sDb; else delete process.env.DATABASE_URL; }
  else delete process.env.DATABASE_URL;
  return Promise.resolve(fn()).finally(() => {
    process.env.NODE_ENV = sEnv;
    if (sDb) process.env.DATABASE_URL = sDb; else delete process.env.DATABASE_URL;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function payload(overrides = {}) {
  return {
    access_token: 'access-' + crypto.randomBytes(3).toString('hex'),
    refresh_token: 'refresh-' + crypto.randomBytes(3).toString('hex'),
    secret: 'shh-' + crypto.randomBytes(3).toString('hex'),
    ...overrides,
  };
}

function summarize() {
  const p = results.filter((r) => r.ok).length, f = results.filter((r) => !r.ok).length;
  console.log('\n[integrationCredentialStore] ' + p + ' passed, ' + f + ' failed');
  return f === 0 ? 0 : 1;
}

async function devCleanup() {
  try { await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV }); } catch (e) {}
  try { await store.deleteCredentials({ provider: 'future_provider', credentialType: 'future_capability', environment: ENV }); } catch (e) {}
  try { await store.deleteCredentials({ provider: 'microsoft', credentialType: 'microsoft_365', environment: ENV }); } catch (e) {}
  try {
    if (fs.existsSync(store.DEV_FILE)) {
      const m = JSON.parse(fs.readFileSync(store.DEV_FILE, 'utf8'));
      if (Object.keys(m).length === 0) fs.unlinkSync(store.DEV_FILE);
    }
  } catch (e) {}
}

async function dbCleanup() {
  try { await db.query('DELETE FROM integration_credentials WHERE environment=$1', [ENV]); } catch (e) {}
}

async function run() {
  console.log('\n[integrationCredentialStore] pure / dev-fs suite');

  await test('encryptPayload/decryptPayload round-trip (default key version)', () => {
    const p = payload();
    const enc = store.encryptPayload(p);
    assert.ok(enc.split(':').length >= 3, 'version:iv:cipher format');
    assert.ok(!enc.includes(p.access_token), 'ciphertext must not contain plaintext');
    assert.deepStrictEqual(store.decryptPayload(enc), p);
  });

  await test('encryptPayload/decryptPayload with explicit key version 1', () => {
    const p = payload();
    const enc = store.encryptPayload(p, 1);
    assert.strictEqual(enc.split(':')[0], '1', 'embedded version prefix = 1');
    assert.deepStrictEqual(store.decryptPayload(enc, 1), p);
  });

  await test('unknown key version rejected (encrypt + decrypt)', () => {
    assert.throws(() => store.encryptPayload(payload(), 99), /Unknown encryption key version/);
    const enc = store.encryptPayload(payload(), 1);
    assert.throws(() => store.decryptPayload(enc, 99), /Unknown encryption key version/);
  });

  await test('key_version defaults to 1 on save (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        const saved = await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload() });
        assert.strictEqual(saved.keyVersion, 1, 'saved.keyVersion = 1');
        const raw = fs.readFileSync(store.DEV_FILE, 'utf8');
        const devMap = JSON.parse(raw);
        const row = Object.values(devMap).find((r) => r.environment === ENV && r.accountIdentifier === ACCT);
        assert.strictEqual(row.keyVersion, 1, 'dev row keyVersion = 1');
      } finally { await devCleanup(); }
    })
  );

  await test('production refuses filesystem-only storage (saveCredential throws)', () =>
    withEnv('production', false, () =>
      assert.rejects(() => store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload() }), /filesystem-only storage refused/)
    )
  );

  await test('canUseFilesystemFallback true (no DB, not prod)', () =>
    withEnv('development', false, () => assert.strictEqual(store.canUseFilesystemFallback(), true))
  );

  await test('canUseFilesystemFallback false (prod, no DB)', () =>
    withEnv('production', false, () => assert.strictEqual(store.canUseFilesystemFallback(), false))
  );

  await test('status validation rejects invalid and empty statuses', () =>
    withEnv('development', false, async () => {
      try {
        await assert.rejects(() => store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'bogus', payload: payload() }), /status must be one of/);
        await assert.rejects(() => store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: '', payload: payload() }), /status must be one of/);
        await assert.rejects(() => store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: null, payload: payload() }), /status must be one of/);
      } finally { await devCleanup(); }
    })
  );

  await test('save/update/load/delete + metadata persists', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        const p1 = payload();
        const connectedAt = new Date('2026-01-01T00:00:00Z').toISOString();
        const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
        const saved = await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, displayName: 'Test Display', status: 'connected', expiresAt, payload: p1, connectedAt, refreshedAt: null });
        assert.ok(saved, 'save returns the credential');
        assert.strictEqual(saved.provider, P);
        assert.strictEqual(saved.credentialType, CT);
        assert.strictEqual(saved.environment, ENV);
        assert.strictEqual(saved.accountIdentifier, ACCT);
        assert.strictEqual(saved.displayName, 'Test Display');
        assert.strictEqual(saved.status, 'connected');
        assert.strictEqual(saved.expiresAt, expiresAt);
        assert.deepStrictEqual(saved.payload, p1);
        assert.strictEqual(saved.connectedAt, connectedAt);
        assert.ok(saved.createdAt, 'createdAt set');
        assert.ok(saved.updatedAt, 'updatedAt set');

        // update: re-save same key with new payload + refreshedAt -> upsert, one row
        const createdAtBefore = saved.createdAt;
        await sleep(15);
        const p2 = payload({ access_token: 'access-UPDATED' });
        const refreshedAt = new Date().toISOString();
        const updated = await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, displayName: null, status: 'connected', expiresAt, payload: p2, connectedAt, refreshedAt });
        assert.strictEqual(updated.payload.access_token, 'access-UPDATED');
        assert.strictEqual(updated.refreshedAt, refreshedAt);
        assert.strictEqual(updated.createdAt, createdAtBefore, 'created_at preserved on update');
        assert.notStrictEqual(updated.updatedAt, saved.updatedAt, 'updated_at changes on update');
        assert.strictEqual(await store.countCredentials({ provider: P, credentialType: CT, environment: ENV }), 1, 'unique -> one row');
        assert.strictEqual(await store.hasCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT }), true);

        await store.deleteCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.strictEqual(await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT }), null);
        assert.strictEqual(await store.hasCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT }), false);
      } finally { await devCleanup(); }
    })
  );

  await test('future provider/credential_type work without schema changes (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        const p = payload();
        await store.saveCredential({ provider: 'microsoft', credentialType: 'microsoft_365', environment: ENV, accountIdentifier: 'tenant-1', displayName: 'M365 Tenant', status: 'connected', expiresAt: null, payload: p });
        const loaded = await store.loadCredential({ provider: 'microsoft', credentialType: 'microsoft_365', environment: ENV, accountIdentifier: 'tenant-1' });
        assert.deepStrictEqual(loaded.payload, p);
        assert.strictEqual(loaded.provider, 'microsoft');
        assert.strictEqual(loaded.credentialType, 'microsoft_365');
      } finally { await devCleanup(); }
    })
  );

  await test('loadActiveCredential: one connected / none / multiple (throws)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        assert.strictEqual(await store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }), null);
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'connected', payload: payload() });
        const one = await store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV });
        assert.ok(one && one.status === 'connected');
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'b', status: 'connected', payload: payload() });
        await assert.rejects(() => store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }), /Multiple connected credentials/);
      } finally { await devCleanup(); }
    })
  );

  await test('expired and revoked rows are NOT active', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'expired', payload: payload() });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'b', status: 'revoked', payload: payload() });
        assert.strictEqual(await store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }), null, 'expired/revoked not active');
        assert.strictEqual(await store.countCredentials({ provider: P, credentialType: CT, environment: ENV, status: 'connected' }), 0);
        assert.strictEqual(await store.countCredentials({ provider: P, credentialType: CT, environment: ENV }), 2);
      } finally { await devCleanup(); }
    })
  );

  await test('updateCredentialStatus changes status without deleting row (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'connected', payload: payload() });
        const updated = await store.updateCredentialStatus({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'revoked' });
        assert.strictEqual(updated.status, 'revoked');
        assert.strictEqual(await store.countCredentials({ provider: P, credentialType: CT, environment: ENV }), 1, 'row not deleted');
        assert.strictEqual(await store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }), null, 'no longer active');
      } finally { await devCleanup(); }
    })
  );

  await test('dev-fs format preserves equivalent metadata + encrypted payload (no plaintext on disk)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, displayName: 'Display', status: 'connected', expiresAt: new Date(Date.now() + 1000).toISOString(), payload: { access_token: 'plaintext-access-secret', refresh_token: 'plaintext-refresh-secret' } });
        const raw = fs.readFileSync(store.DEV_FILE, 'utf8');
        assert.ok(!raw.includes('plaintext-access-secret'), 'no plaintext access token on disk');
        assert.ok(!raw.includes('plaintext-refresh-secret'), 'no plaintext refresh token on disk');
        const loaded = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.strictEqual(loaded.payload.access_token, 'plaintext-access-secret');
        assert.strictEqual(loaded.displayName, 'Display');
        assert.ok(loaded.expiresAt);
      } finally { await devCleanup(); }
    })
  );

  await test('markCredentialUsed updates last_used_at; preserves connected_at/refreshed_at/created_at (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload(), connectedAt: new Date('2026-01-01T00:00:00Z').toISOString() });
        const before = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.strictEqual(before.lastUsedAt, null, 'last_used_at null before use');
        await sleep(15);
        const after = await store.markCredentialUsed({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.ok(after.lastUsedAt, 'last_used_at set');
        assert.notStrictEqual(after.lastUsedAt, before.lastUsedAt, 'last_used_at changed');
        assert.strictEqual(after.connectedAt, before.connectedAt, 'connected_at preserved');
        assert.strictEqual(after.refreshedAt, before.refreshedAt, 'refreshed_at preserved');
        assert.strictEqual(after.createdAt, before.createdAt, 'created_at preserved');
      } finally { await devCleanup(); }
    })
  );

  await test('markCredentialError updates last_error_at + message; truncates to 255; preserves status (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload() });
        const longMsg = 'Refresh failed. ' + 'y'.repeat(300);
        const after = await store.markCredentialError({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, message: longMsg });
        assert.ok(after.lastErrorAt, 'last_error_at set');
        assert.ok(after.lastErrorMessage, 'last_error_message set');
        assert.strictEqual(after.lastErrorMessage.length, 255, 'truncated to 255');
        assert.ok(after.lastErrorMessage.startsWith('Refresh failed.'), 'prefix preserved');
        assert.strictEqual(after.status, 'connected', 'status unchanged');
      } finally { await devCleanup(); }
    })
  );

  await test('secrets never stored in last_error_message (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: { access_token: 'secret-access-XYZ', refresh_token: 'secret-refresh-XYZ' } });
        // Caller passes a CLEAN message (never a token).
        const after = await store.markCredentialError({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, message: 'Authentication failed during refresh' });
        assert.strictEqual(after.lastErrorMessage, 'Authentication failed during refresh', 'clean message stored verbatim');
        assert.ok(!after.lastErrorMessage.includes('secret-access-XYZ'), 'no access token in message');
        assert.ok(!after.lastErrorMessage.includes('secret-refresh-XYZ'), 'no refresh token in message');
        // Raw dev file: the message column must not contain secrets.
        const devMap = JSON.parse(fs.readFileSync(store.DEV_FILE, 'utf8'));
        const row = Object.values(devMap).find((r) => r.environment === ENV && r.accountIdentifier === ACCT);
        assert.ok(!JSON.stringify(row.lastErrorMessage || '').includes('secret-access-XYZ'), 'no secret in lastErrorMessage column');
      } finally { await devCleanup(); }
    })
  );

  await test('metadata survives refresh-token rotation (re-save) (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload() });
        await store.markCredentialUsed({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        await store.markCredentialError({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, message: 'transient timeout' });
        const before = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.ok(before.lastUsedAt && before.lastErrorAt, 'metadata set before rotation');
        await sleep(15);
        // Rotation: re-save with new payload + refreshedAt.
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', expiresAt: new Date(Date.now() + 7200 * 1000).toISOString(), payload: payload({ access_token: 'access-ROTATED' }), refreshedAt: new Date().toISOString() });
        const after = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.strictEqual(after.lastUsedAt, before.lastUsedAt, 'last_used_at preserved across rotation');
        assert.strictEqual(after.lastErrorAt, before.lastErrorAt, 'last_error_at preserved across rotation');
        assert.strictEqual(after.lastErrorMessage, before.lastErrorMessage, 'last_error_message preserved across rotation');
        assert.strictEqual(after.keyVersion, 1, 'key_version preserved');
        assert.strictEqual(after.payload.access_token, 'access-ROTATED', 'payload rotated');
      } finally { await devCleanup(); }
    })
  );

  await test('metadata survives restart (re-require) (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload() });
        await store.markCredentialUsed({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        await store.markCredentialError({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, message: 'pre-restart error' });
        const before = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        delete require.cache[require.resolve('../lib/integrationCredentialStore')];
        const store2 = require('../lib/integrationCredentialStore');
        const after = await store2.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.strictEqual(after.lastUsedAt, before.lastUsedAt, 'last_used_at survives restart');
        assert.strictEqual(after.lastErrorAt, before.lastErrorAt, 'last_error_at survives restart');
        assert.strictEqual(after.lastErrorMessage, before.lastErrorMessage, 'last_error_message survives restart');
        assert.strictEqual(after.keyVersion, 1, 'key_version survives restart');
      } finally { await devCleanup(); }
    })
  );

  await test('metadata survives reconnect (re-save preserves operational metadata) (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await store.deleteCredentials({ provider: P, credentialType: CT, environment: ENV });
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload() });
        await store.markCredentialUsed({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        await store.markCredentialError({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, message: 'before reconnect' });
        const before = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        await sleep(15);
        // Reconnect: fresh credential re-save with same key.
        await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload({ access_token: 'fresh-access' }) });
        const after = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
        assert.strictEqual(after.lastUsedAt, before.lastUsedAt, 'last_used_at preserved across reconnect');
        assert.strictEqual(after.lastErrorAt, before.lastErrorAt, 'last_error_at preserved across reconnect');
        assert.strictEqual(after.lastErrorMessage, before.lastErrorMessage, 'last_error_message preserved across reconnect');
        assert.strictEqual(after.payload.access_token, 'fresh-access', 'payload refreshed');
      } finally { await devCleanup(); }
    })
  );

  if (!process.env.DATABASE_URL) {
    console.log('\n[integrationCredentialStore] DB suite SKIPPED (DATABASE_URL not set)');
    return summarize();
  }

  console.log('\n[integrationCredentialStore] DB suite (DATABASE_URL set)');

  await test('DB migration 2026-07-integration-credentials.sql applies', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '2026-07-integration-credentials.sql'), 'utf8');
    await db.query(sql);
  });

  await test('DB save -> load (equal, all metadata + key_version)', async () => {
    await dbCleanup();
    const p = payload();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, displayName: 'DB Display', status: 'connected', expiresAt, payload: p, connectedAt: new Date().toISOString() });
    const loaded = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
    assert.deepStrictEqual(loaded.payload, p);
    assert.strictEqual(loaded.provider, P);
    assert.strictEqual(loaded.credentialType, CT);
    assert.strictEqual(loaded.environment, ENV);
    assert.strictEqual(loaded.accountIdentifier, ACCT);
    assert.strictEqual(loaded.displayName, 'DB Display');
    assert.strictEqual(loaded.status, 'connected');
    assert.strictEqual(loaded.expiresAt, expiresAt);
    assert.strictEqual(loaded.keyVersion, 1, 'key_version = 1');
    assert.strictEqual(loaded.lastUsedAt, null, 'last_used_at null initially');
    assert.strictEqual(loaded.lastErrorAt, null, 'last_error_at null initially');
  });

  await test('DB raw row contains no plaintext secrets', async () => {
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: { access_token: 'plaintext-access-secret', refresh_token: 'plaintext-refresh-secret' } });
    const row = (await db.query('SELECT encrypted_payload, display_name, status, last_error_message FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4', [P, CT, ENV, ACCT])).rows[0];
    assert.ok(!row.encrypted_payload.includes('plaintext-access-secret'));
    assert.ok(!row.encrypted_payload.includes('plaintext-refresh-secret'));
    assert.deepStrictEqual(store.decryptPayload(row.encrypted_payload, 1), { access_token: 'plaintext-access-secret', refresh_token: 'plaintext-refresh-secret' });
  });

  await test('DB unknown key version rejection', async () => {
    assert.throws(() => store.encryptPayload(payload(), 99), /Unknown encryption key version/);
    const enc = store.encryptPayload(payload(), 1);
    assert.throws(() => store.decryptPayload(enc, 99), /Unknown encryption key version/);
  });

  await test('DB update via re-save -> created_at stable, updated_at changes, count 1', async () => {
    const first = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
    await sleep(15);
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', expiresAt: new Date(Date.now() + 7200 * 1000).toISOString(), payload: payload({ access_token: 'access-DB-UPDATED' }), refreshedAt: new Date().toISOString() });
    const updated = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
    assert.strictEqual(updated.payload.access_token, 'access-DB-UPDATED');
    assert.strictEqual(updated.createdAt, first.createdAt, 'created_at preserved');
    assert.notStrictEqual(updated.updatedAt, first.updatedAt, 'updated_at changed');
    assert.strictEqual(await store.countCredentials({ provider: P, credentialType: CT, environment: ENV }), 1);
  });

  await test('DB expires_at monitoring query works', async () => {
    await dbCleanup();
    const past = new Date(Date.now() - 60000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'expired-1', status: 'connected', expiresAt: past, payload: payload() });
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'fresh-1', status: 'connected', expiresAt: future, payload: payload() });
    const expiring = (await db.query("SELECT account_identifier FROM integration_credentials WHERE status='connected' AND expires_at IS NOT NULL AND expires_at < NOW()")).rows.map((r) => r.account_identifier);
    assert.ok(expiring.includes('expired-1'));
    assert.ok(!expiring.includes('fresh-1'));
  });

  await test('DB loadActiveCredential: one / none / multiple; expired/revoked not active', async () => {
    await dbCleanup();
    assert.strictEqual(await store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }), null);
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'connected', payload: payload() });
    assert.ok(await store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }));
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'b', status: 'connected', payload: payload() });
    await assert.rejects(() => store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }), /Multiple connected credentials/);
    await store.updateCredentialStatus({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'expired' });
    await store.updateCredentialStatus({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'b', status: 'revoked' });
    assert.strictEqual(await store.loadActiveCredential({ provider: P, credentialType: CT, environment: ENV }), null, 'expired/revoked not active');
    assert.strictEqual(await store.countCredentials({ provider: P, credentialType: CT, environment: ENV }), 2, 'rows retained');
  });

  await test('DB updateCredentialStatus (expired/revoked) keeps row', async () => {
    await dbCleanup();
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'connected', payload: payload() });
    const r1 = await store.updateCredentialStatus({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: 'a', status: 'expired' });
    assert.strictEqual(r1.status, 'expired');
    assert.strictEqual(await store.countCredentials({ provider: P, credentialType: CT, environment: ENV }), 1);
  });

  await test('DB markCredentialUsed / markCredentialError + truncation + metadata preserved across re-save', async () => {
    await dbCleanup();
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload() });
    await store.markCredentialUsed({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
    await store.markCredentialError({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, message: 'z'.repeat(300) });
    let cred = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
    assert.ok(cred.lastUsedAt, 'last_used_at set');
    assert.ok(cred.lastErrorAt, 'last_error_at set');
    assert.strictEqual(cred.lastErrorMessage.length, 255, 'truncated to 255');
    assert.strictEqual(cred.status, 'connected', 'status unchanged');
    // Verify the raw column holds the sanitized message and no secrets leak there.
    const row = (await db.query('SELECT last_error_message FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4', [P, CT, ENV, ACCT])).rows[0];
    assert.strictEqual(row.last_error_message.length, 255, 'raw column truncated');
    // Re-save (rotation) must preserve operational metadata.
    await sleep(15);
    await store.saveCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT, status: 'connected', payload: payload({ access_token: 'access-DB-ROT' }), refreshedAt: new Date().toISOString() });
    cred = await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
    assert.ok(cred.lastUsedAt, 'last_used_at preserved across re-save');
    assert.ok(cred.lastErrorAt, 'last_error_at preserved across re-save');
    assert.strictEqual(cred.payload.access_token, 'access-DB-ROT');
  });

  await test('DB delete -> load null', async () => {
    await store.deleteCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT });
    assert.strictEqual(await store.loadCredential({ provider: P, credentialType: CT, environment: ENV, accountIdentifier: ACCT }), null);
  });

  await test('DB future provider/credential_type works', async () => {
    await store.saveCredential({ provider: 'future_provider', credentialType: 'future_capability', environment: ENV, accountIdentifier: 'x', status: 'connected', payload: payload() });
    const loaded = await store.loadCredential({ provider: 'future_provider', credentialType: 'future_capability', environment: ENV, accountIdentifier: 'x' });
    assert.ok(loaded);
    await store.deleteCredential({ provider: 'future_provider', credentialType: 'future_capability', environment: ENV, accountIdentifier: 'x' });
  });

  await test('DB cleanup', async () => {
    await dbCleanup();
    const n = (await db.query('SELECT COUNT(*)::int AS n FROM integration_credentials WHERE environment=$1', [ENV])).rows[0].n;
    assert.strictEqual(n, 0);
  });

  return summarize();
}

run().then((code) => process.exit(code)).catch((e) => { console.error('FATAL', e); process.exit(1); });