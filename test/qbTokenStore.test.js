#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * test/qbTokenStore.test.js
 *
 * Validates the QuickBooks adapter (lib/qbTokenStore.js) over the generic
 * credential store.
 *
 * Pure / dev-fs suite (always runs):
 *   - initial OAuth save using realm_id; provider=intuit; credential_type=quickbooks
 *   - startup load without a known realm_id
 *   - startup rejection when multiple connected QuickBooks credentials exist
 *   - refresh-token rotation (access/refresh updated; expires_at + refreshed_at updated)
 *   - key_version persistence (defaults to 1; exposed on token object)
 *   - markUsed updates last_used_at; preserves connected_at/refreshed_at/created_at
 *   - markError updates last_error_at; truncates message to 255; preserves status
 *   - secrets never stored in last_error_message
 *   - markUsed / markError return null when realmId omitted
 *   - metadata (last_used_at/last_error_at) survives refresh-token rotation
 *   - metadata survives restart (re-require)
 *   - metadata survives reconnect (re-save preserves operational metadata)
 *   - expires_at metadata update (credential_expires_at)
 *   - simulated restart persistence
 *   - disconnect/delete (with realm_id; without realm_id)
 *   - status change to expired (markExpired) — row retained, not active
 *   - status change to revoked (markRevoked) — row retained, not active
 *   - production refusal to use filesystem-only storage
 *   - no plaintext tokens in stored rows or dev file
 *
 * DB suite (runs when DATABASE_URL is set):
 *   - same cycle against Postgres + raw row no plaintext + key_version + expires_at query
 *
 * Run: node test/qbTokenStore.test.js
 */
'use strict';

// Set a test-only ENCRYPTION_KEY so the credential store can encrypt/decrypt
// without requiring a production secret. This is a unit-test environment —
// the key is never used outside this process.
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-only-00';
}

const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');

const qb = require('../lib/qbTokenStore');
const store = require('../lib/integrationCredentialStore');
const db = require('../db/client');

const ENV = 'qb-test';
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

function qbTokens(overrides = {}) {
  return {
    access_token: 'access-' + crypto.randomBytes(3).toString('hex'),
    refresh_token: 'refresh-' + crypto.randomBytes(3).toString('hex'),
    realm_id: 'realm-1',
    environment: ENV,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86400 * 1000).toISOString(),
    connected_at: new Date().toISOString(),
    last_refresh_at: null,
    ...overrides,
  };
}

function summarize() {
  const p = results.filter((r) => r.ok).length, f = results.filter((r) => !r.ok).length;
  console.log('\n[qbTokenStore] ' + p + ' passed, ' + f + ' failed');
  return f === 0 ? 0 : 1;
}

async function devCleanup() {
  try { await store.deleteCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }); } catch (e) {}
  try {
    if (fs.existsSync(store.DEV_FILE)) {
      const m = JSON.parse(fs.readFileSync(store.DEV_FILE, 'utf8'));
      if (Object.keys(m).length === 0) fs.unlinkSync(store.DEV_FILE);
    }
  } catch (e) {}
}

async function dbCleanup() {
  try { await db.query('DELETE FROM integration_credentials WHERE provider=$1 AND environment=$2', ['intuit', ENV]); } catch (e) {}
}

async function run() {
  console.log('\n[qbTokenStore] pure / dev-fs suite');

  await test('initial OAuth save using realm_id; provider=intuit; credential_type=quickbooks (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        const t = qbTokens({ realm_id: 'realm-1' });
        const how = await qb.savePersistedTokens(ENV, t);
        assert.strictEqual(how, 'filesystem');
        const cred = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.ok(cred);
        assert.strictEqual(cred.provider, 'intuit');
        assert.strictEqual(cred.credentialType, 'quickbooks');
        assert.strictEqual(cred.status, 'connected');
        assert.strictEqual(cred.accountIdentifier, 'realm-1');
        assert.ok(cred.displayName && /realm-1/.test(cred.displayName), 'neutral display name includes realm');
        const loaded = await qb.loadPersistedTokens(ENV);
        assert.strictEqual(loaded.access_token, t.access_token);
        assert.strictEqual(loaded.refresh_token, t.refresh_token);
        assert.strictEqual(loaded.realm_id, 'realm-1');
        assert.strictEqual(loaded.status, 'connected');
      } finally { await devCleanup(); }
    })
  );

  await test('startup load without known realm_id (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-99' }));
        const loaded = await qb.loadPersistedTokens(ENV);
        assert.ok(loaded, 'startup load returns the active credential');
        assert.strictEqual(loaded.realm_id, 'realm-99');
      } finally { await devCleanup(); }
    })
  );

  await test('rejects when multiple connected QuickBooks credentials exist (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-A' }));
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-B' }));
        await assert.rejects(() => qb.loadPersistedTokens(ENV), /Multiple connected credentials/);
      } finally { await devCleanup(); }
    })
  );

  await test('refresh-token rotation updates access/refresh + expires_at + refreshed_at (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        const t0 = qbTokens({ realm_id: 'realm-1', access_token: 'A0', refresh_token: 'R0' });
        await qb.savePersistedTokens(ENV, t0);
        const before = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        await sleep(15);
        const newExpiry = new Date(Date.now() + 7200 * 1000).toISOString();
        const rotated = qbTokens({ realm_id: 'realm-1', access_token: 'A2', refresh_token: 'R2', expires_at: newExpiry, last_refresh_at: new Date().toISOString() });
        await qb.savePersistedTokens(ENV, rotated);
        const after = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(after.payload.access_token, 'A2');
        assert.strictEqual(after.payload.refresh_token, 'R2');
        assert.strictEqual(after.expiresAt, newExpiry, 'expires_at updated');
        assert.ok(after.refreshedAt, 'refreshed_at set');
        assert.strictEqual(after.connectedAt, before.connectedAt, 'connected_at retained');
        assert.strictEqual(after.displayName, before.displayName, 'display_name retained');
        assert.strictEqual(after.status, 'connected', 'status stays connected');
        assert.strictEqual(await store.countCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }), 1);
        const loaded = await qb.loadPersistedTokens(ENV);
        assert.strictEqual(loaded.credential_expires_at, newExpiry, 'credential_expires_at metadata exposed');
        assert.ok(loaded.last_refresh_at, 'refreshed_at exposed as last_refresh_at');
      } finally { await devCleanup(); }
    })
  );

  await test('key_version persistence (defaults to 1; exposed on token object)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        const loaded = await qb.loadPersistedTokens(ENV);
        assert.strictEqual(loaded.key_version, 1, 'key_version defaults to 1');
        const cred = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(cred.keyVersion, 1, 'stored key_version = 1');
      } finally { await devCleanup(); }
    })
  );

  await test('markUsed updates last_used_at; preserves connected_at/refreshed_at/created_at (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        const t = qbTokens({ realm_id: 'realm-1' });
        await qb.savePersistedTokens(ENV, t);
        const before = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(before.lastUsedAt, null, 'last_used_at null before use');
        await sleep(15);
        const res = await qb.markUsed(ENV, 'realm-1');
        assert.strictEqual(res, 'used');
        const after = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.ok(after.lastUsedAt, 'last_used_at set after use');
        assert.notStrictEqual(after.lastUsedAt, before.lastUsedAt, 'last_used_at changed');
        assert.strictEqual(after.connectedAt, before.connectedAt, 'connected_at preserved');
        assert.strictEqual(after.refreshedAt, before.refreshedAt, 'refreshed_at preserved');
        assert.strictEqual(after.createdAt, before.createdAt, 'created_at preserved');
      } finally { await devCleanup(); }
    })
  );

  await test('markError updates last_error_at; truncates message to 255; preserves status (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        const longMsg = 'Refresh token invalid or revoked. ' + 'x'.repeat(300);
        const res = await qb.markError(ENV, 'realm-1', longMsg);
        assert.strictEqual(res, 'error');
        const after = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.ok(after.lastErrorAt, 'last_error_at set');
        assert.ok(after.lastErrorMessage, 'last_error_message set');
        assert.strictEqual(after.lastErrorMessage.length, 255, 'message truncated to 255');
        assert.ok(after.lastErrorMessage.startsWith('Refresh token invalid or revoked.'), 'message prefix preserved');
        assert.strictEqual(after.status, 'connected', 'status unchanged by markError');
      } finally { await devCleanup(); }
    })
  );

  await test('secrets never stored in last_error_message (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        const t = qbTokens({ realm_id: 'realm-1', access_token: 'secret-access-XYZ', refresh_token: 'secret-refresh-XYZ' });
        await qb.savePersistedTokens(ENV, t);
        // Caller passes a CLEAN message (never a token). Verify the store does
        // not inject secrets into last_error_message and the token never leaks.
        await qb.markError(ENV, 'realm-1', 'Authentication failed during refresh');
        const after = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(after.lastErrorMessage, 'Authentication failed during refresh', 'clean message stored verbatim');
        assert.ok(!after.lastErrorMessage.includes('secret-access-XYZ'), 'no access token in message');
        assert.ok(!after.lastErrorMessage.includes('secret-refresh-XYZ'), 'no refresh token in message');
        const raw = fs.readFileSync(store.DEV_FILE, 'utf8');
        const devMap = JSON.parse(raw);
        const row = Object.values(devMap).find((r) => r.provider === 'intuit' && r.environment === ENV);
        assert.strictEqual(row.lastErrorMessage, 'Authentication failed during refresh', 'clean message stored in lastErrorMessage');
        assert.ok(!row.lastErrorMessage.includes('secret-access-XYZ'), 'no access token in lastErrorMessage column');
        assert.ok(!row.lastErrorMessage.includes('secret-refresh-XYZ'), 'no refresh token in lastErrorMessage column');
      } finally { await devCleanup(); }
    })
  );

  await test('markUsed / markError return null when realmId omitted', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        assert.strictEqual(await qb.markUsed(ENV), null, 'markUsed null without realmId');
        assert.strictEqual(await qb.markError(ENV, null, 'msg'), null, 'markError null without realmId');
      } finally { await devCleanup(); }
    })
  );

  await test('metadata (last_used_at/last_error_at) survives refresh-token rotation (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        await qb.markUsed(ENV, 'realm-1');
        await qb.markError(ENV, 'realm-1', 'transient timeout');
        const before = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.ok(before.lastUsedAt && before.lastErrorAt, 'metadata set before rotation');
        await sleep(15);
        // Rotate (re-save with new tokens + new expiry).
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'A2', refresh_token: 'R2', expires_at: new Date(Date.now() + 7200 * 1000).toISOString(), last_refresh_at: new Date().toISOString() }));
        const after = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(after.lastUsedAt, before.lastUsedAt, 'last_used_at preserved across rotation');
        assert.strictEqual(after.lastErrorAt, before.lastErrorAt, 'last_error_at preserved across rotation');
        assert.strictEqual(after.lastErrorMessage, before.lastErrorMessage, 'last_error_message preserved across rotation');
        assert.strictEqual(after.keyVersion, 1, 'key_version preserved');
      } finally { await devCleanup(); }
    })
  );

  await test('metadata survives restart (re-require) (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        await qb.markUsed(ENV, 'realm-1');
        await qb.markError(ENV, 'realm-1', 'pre-restart error');
        const before = await qb.loadPersistedTokens(ENV);
        assert.ok(before.last_used_at && before.last_error_at, 'metadata present before restart');
        delete require.cache[require.resolve('../lib/qbTokenStore')];
        delete require.cache[require.resolve('../lib/integrationCredentialStore')];
        const qb2 = require('../lib/qbTokenStore');
        const after = await qb2.loadPersistedTokens(ENV);
        assert.strictEqual(after.last_used_at, before.last_used_at, 'last_used_at survives restart');
        assert.strictEqual(after.last_error_at, before.last_error_at, 'last_error_at survives restart');
        assert.strictEqual(after.key_version, 1, 'key_version survives restart');
      } finally { await devCleanup(); }
    })
  );

  await test('metadata survives reconnect (re-save preserves operational metadata) (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        await qb.markUsed(ENV, 'realm-1');
        await qb.markError(ENV, 'realm-1', 'before reconnect');
        const before = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        await sleep(15);
        // Reconnect: a fresh OAuth (new payload, same realm) re-saves the credential.
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'fresh-access', refresh_token: 'fresh-refresh' }));
        const after = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(after.lastUsedAt, before.lastUsedAt, 'last_used_at preserved across reconnect');
        assert.strictEqual(after.lastErrorAt, before.lastErrorAt, 'last_error_at preserved across reconnect');
        assert.strictEqual(after.lastErrorMessage, before.lastErrorMessage, 'last_error_message preserved across reconnect');
        assert.strictEqual(after.payload.access_token, 'fresh-access', 'payload refreshed');
      } finally { await devCleanup(); }
    })
  );

  await test('simulated restart persistence (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'before-restart' }));
        const before = await qb.loadPersistedTokens(ENV);
        delete require.cache[require.resolve('../lib/qbTokenStore')];
        delete require.cache[require.resolve('../lib/integrationCredentialStore')];
        const qb2 = require('../lib/qbTokenStore');
        const after = await qb2.loadPersistedTokens(ENV);
        assert.strictEqual(after.access_token, 'before-restart');
        assert.deepStrictEqual(after, before);
      } finally { await devCleanup(); }
    })
  );

  await test('disconnect/delete with realm_id (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        const how = await qb.deletePersistedTokens(ENV, 'realm-1');
        assert.strictEqual(how, 'filesystem');
        assert.strictEqual(await qb.loadPersistedTokens(ENV), null);
        assert.strictEqual(await store.countCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }), 0);
      } finally { await devCleanup(); }
    })
  );

  await test('disconnect without realm_id deletes the single connected credential (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-7' }));
        const how = await qb.deletePersistedTokens(ENV); // no realmId -> resolve active
        assert.strictEqual(how, 'filesystem');
        assert.strictEqual(await qb.loadPersistedTokens(ENV), null);
      } finally { await devCleanup(); }
    })
  );

  await test('markExpired changes status to expired without deleting row (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        const res = await qb.markExpired(ENV);
        assert.strictEqual(res, 'expired');
        const cred = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(cred.status, 'expired');
        assert.strictEqual(await store.countCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }), 1, 'row retained');
        assert.strictEqual(await qb.loadPersistedTokens(ENV), null, 'no longer active');
      } finally { await devCleanup(); }
    })
  );

  await test('markRevoked changes status to revoked without deleting row (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
        const res = await qb.markRevoked(ENV);
        assert.strictEqual(res, 'revoked');
        const cred = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
        assert.strictEqual(cred.status, 'revoked');
        assert.strictEqual(await store.countCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }), 1, 'row retained');
        assert.strictEqual(await qb.loadPersistedTokens(ENV), null, 'no longer active');
      } finally { await devCleanup(); }
    })
  );

  await test('production refuses filesystem-only storage (save throws)', () =>
    withEnv('production', false, () =>
      assert.rejects(() => qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' })), /filesystem-only storage refused/)
    )
  );

  await test('no plaintext tokens in dev file (dev-fs)', () =>
    withEnv('development', false, async () => {
      try {
        await devCleanup();
        await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'plaintext-access-secret', refresh_token: 'plaintext-refresh-secret' }));
        const raw = fs.readFileSync(store.DEV_FILE, 'utf8');
        assert.ok(!raw.includes('plaintext-access-secret'));
        assert.ok(!raw.includes('plaintext-refresh-secret'));
      } finally { await devCleanup(); }
    })
  );

  if (!process.env.DATABASE_URL) {
    console.log('\n[qbTokenStore] DB suite SKIPPED (DATABASE_URL not set)');
    return summarize();
  }

  console.log('\n[qbTokenStore] DB suite (DATABASE_URL set)');

  await test('DB initial OAuth save; provider=intuit; credential_type=quickbooks', async () => {
    await dbCleanup();
    const t = qbTokens({ realm_id: 'realm-1' });
    const how = await qb.savePersistedTokens(ENV, t);
    assert.strictEqual(how, 'postgres');
    const cred = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
    assert.strictEqual(cred.provider, 'intuit');
    assert.strictEqual(cred.credentialType, 'quickbooks');
    assert.strictEqual(cred.status, 'connected');
    const loaded = await qb.loadPersistedTokens(ENV);
    assert.strictEqual(loaded.access_token, t.access_token);
    assert.strictEqual(loaded.realm_id, 'realm-1');
  });

  await test('DB startup load without known realm_id', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
    const loaded = await qb.loadPersistedTokens(ENV);
    assert.ok(loaded && loaded.realm_id === 'realm-1');
  });

  await test('DB rejects when multiple connected QuickBooks credentials exist', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-A' }));
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-B' }));
    await assert.rejects(() => qb.loadPersistedTokens(ENV), /Multiple connected credentials/);
  });

  await test('DB refresh-token rotation (expires_at + refreshed_at + retained fields + key_version)', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'A0', refresh_token: 'R0' }));
    const before = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
    await sleep(15);
    const newExpiry = new Date(Date.now() + 7200 * 1000).toISOString();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'A2', refresh_token: 'R2', expires_at: newExpiry, last_refresh_at: new Date().toISOString() }));
    const after = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
    assert.strictEqual(after.payload.access_token, 'A2');
    assert.strictEqual(after.expiresAt, newExpiry);
    assert.ok(after.refreshedAt);
    assert.strictEqual(after.connectedAt, before.connectedAt);
    assert.strictEqual(after.createdAt, before.createdAt, 'created_at stable');
    assert.strictEqual(after.keyVersion, 1, 'key_version = 1');
    assert.strictEqual(await store.countCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }), 1);
  });

  await test('DB key_version persistence + unknown version rejection', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
    const loaded = await qb.loadPersistedTokens(ENV);
    assert.strictEqual(loaded.key_version, 1);
    // Unknown key version must be rejected (store-level).
    assert.throws(() => store.encryptPayload({ a: 1 }, 99), /Unknown encryption key version/);
    // A blob encrypted with v1 cannot be decrypted claiming v99.
    const enc = store.encryptPayload({ a: 1 }, 1);
    assert.throws(() => store.decryptPayload(enc, 99), /Unknown encryption key version/);
  });

  await test('DB markUsed / markError + truncation + metadata preservation', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
    await qb.markUsed(ENV, 'realm-1');
    await qb.markError(ENV, 'realm-1', 'x'.repeat(300));
    let cred = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
    assert.ok(cred.lastUsedAt, 'last_used_at set');
    assert.ok(cred.lastErrorAt, 'last_error_at set');
    assert.strictEqual(cred.lastErrorMessage.length, 255, 'truncated to 255');
    assert.strictEqual(cred.status, 'connected', 'status unchanged');
    // Rotation preserves operational metadata.
    await sleep(15);
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'A2', refresh_token: 'R2' }));
    cred = await store.loadCredential({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV, accountIdentifier: 'realm-1' });
    assert.ok(cred.lastUsedAt, 'last_used_at preserved across rotation');
    assert.ok(cred.lastErrorAt, 'last_error_at preserved across rotation');
  });

  await test('DB expires_at monitoring query works', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'expired-realm', expires_at: new Date(Date.now() - 60000).toISOString() }));
    const expiring = (await db.query("SELECT account_identifier FROM integration_credentials WHERE provider='intuit' AND status='connected' AND expires_at IS NOT NULL AND expires_at < NOW()")).rows.map((r) => r.account_identifier);
    assert.ok(expiring.includes('expired-realm'));
  });

  await test('DB encryption at rest (raw row has no plaintext)', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'plaintext-access-secret', refresh_token: 'plaintext-refresh-secret' }));
    const row = (await db.query("SELECT encrypted_payload, last_error_message FROM integration_credentials WHERE provider='intuit' AND environment=$1 AND account_identifier='realm-1'", [ENV])).rows[0];
    assert.ok(!row.encrypted_payload.includes('plaintext-access-secret'));
    assert.ok(!row.encrypted_payload.includes('plaintext-refresh-secret'));
  });

  await test('DB simulated restart persistence', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1', access_token: 'persisted-across-restart' }));
    await qb.markUsed(ENV, 'realm-1');
    const before = await qb.loadPersistedTokens(ENV);
    delete require.cache[require.resolve('../lib/qbTokenStore')];
    delete require.cache[require.resolve('../lib/integrationCredentialStore')];
    const qb2 = require('../lib/qbTokenStore');
    const after = await qb2.loadPersistedTokens(ENV);
    assert.strictEqual(after.access_token, 'persisted-across-restart');
    assert.strictEqual(after.last_used_at, before.last_used_at, 'last_used_at survives restart');
  });

  await test('DB markExpired / markRevoked retain row, not active', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
    assert.strictEqual(await qb.markExpired(ENV), 'expired');
    assert.strictEqual(await qb.loadPersistedTokens(ENV), null);
    assert.strictEqual(await store.countCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }), 1, 'row retained after expired');
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-2' }));
    assert.strictEqual(await qb.markRevoked(ENV), 'revoked');
    assert.strictEqual(await qb.loadPersistedTokens(ENV), null);
    assert.strictEqual(await store.countCredentials({ provider: 'intuit', credentialType: 'quickbooks', environment: ENV }), 2, 'rows retained after revoked');
  });

  await test('DB disconnect/delete', async () => {
    await dbCleanup();
    await qb.savePersistedTokens(ENV, qbTokens({ realm_id: 'realm-1' }));
    const how = await qb.deletePersistedTokens(ENV, 'realm-1');
    assert.strictEqual(how, 'postgres');
    assert.strictEqual(await qb.loadPersistedTokens(ENV), null);
  });

  await test('DB cleanup', async () => {
    await dbCleanup();
    const n = (await db.query("SELECT COUNT(*)::int AS n FROM integration_credentials WHERE provider='intuit' AND environment=$1", [ENV])).rows[0].n;
    assert.strictEqual(n, 0);
  });

  return summarize();
}

run().then((code) => process.exit(code)).catch((e) => { console.error('FATAL', e); process.exit(1); });