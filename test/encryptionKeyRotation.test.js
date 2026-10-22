#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * test/encryptionKeyRotation.test.js — pure/no-DB coverage for the
 * ENCRYPTION_KEY version-2 capability added to
 * lib/integrationCredentialStore.js for the October 2026 Railway
 * security-disclosure credential-rotation response, and for the pure
 * helper functions in scripts/rotateEncryptionKey.js. Real-Postgres
 * end-to-end rotation coverage lives in
 * test/integration/rotateEncryptionKey.int.test.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.ENCRYPTION_KEY = 'test-v1-key-do-not-use-in-production';

function freshStore() {
  delete require.cache[require.resolve('../lib/integrationCredentialStore')];
  return require('../lib/integrationCredentialStore');
}

test('CURRENT_KEY_VERSION defaults to 1 when ACTIVE_ENCRYPTION_KEY_VERSION is unset — existing behavior unchanged', () => {
  delete process.env.ACTIVE_ENCRYPTION_KEY_VERSION;
  const store = freshStore();
  assert.strictEqual(store.CURRENT_KEY_VERSION, 1);
});

test('CURRENT_KEY_VERSION follows ACTIVE_ENCRYPTION_KEY_VERSION when explicitly set to 2', () => {
  process.env.ACTIVE_ENCRYPTION_KEY_VERSION = '2';
  process.env.ENCRYPTION_KEY_V2 = 'test-v2-key-do-not-use-in-production';
  const store = freshStore();
  assert.strictEqual(store.CURRENT_KEY_VERSION, 2);
  delete process.env.ACTIVE_ENCRYPTION_KEY_VERSION;
  delete process.env.ENCRYPTION_KEY_V2;
});

test('version 2 is now a KNOWN key version (was previously unknown/rejected)', () => {
  const store = freshStore();
  assert.ok(store.KNOWN_KEY_VERSIONS.has(2));
});

test('encrypting at version 2 requires ENCRYPTION_KEY_V2 — clear error, never falls back to v1\'s key', () => {
  delete process.env.ENCRYPTION_KEY_V2;
  const store = freshStore();
  assert.throws(() => store.encryptPayload({ a: 1 }, 2), /ENCRYPTION_KEY_V2 not configured/);
});

test('encrypt/decrypt round-trip at version 2 succeeds once ENCRYPTION_KEY_V2 is set, and version 1 is completely unaffected', () => {
  process.env.ENCRYPTION_KEY_V2 = 'test-v2-key-do-not-use-in-production';
  const store = freshStore();
  const payload = { access_token: 'fake', refresh_token: 'also-fake' };

  const encV1 = store.encryptPayload(payload, 1);
  const encV2 = store.encryptPayload(payload, 2);
  assert.deepStrictEqual(store.decryptPayload(encV1, 1), payload);
  assert.deepStrictEqual(store.decryptPayload(encV2, 2), payload);
  // The two ciphertexts must differ (different keys) even for identical plaintext.
  assert.notStrictEqual(encV1, encV2);
  // A v2 blob can never be decrypted by asking for v1 (embedded version check).
  assert.throws(() => store.decryptPayload(encV2, 1), /version mismatch/);
  delete process.env.ENCRYPTION_KEY_V2;
});

test('version 99 (still genuinely unknown) is still rejected — adding version 2 did not loosen validation generally', () => {
  const store = freshStore();
  assert.throws(() => store.encryptPayload({ a: 1 }, 99), /Unknown encryption key version/);
});

// ── scripts/rotateEncryptionKey.js pure helpers ─────────────────────────────
test('rotateEncryptionKey selfCheck: passes when the target version key is configured', async () => {
  process.env.ENCRYPTION_KEY_V2 = 'test-v2-key-do-not-use-in-production';
  delete require.cache[require.resolve('../lib/integrationCredentialStore')];
  delete require.cache[require.resolve('../scripts/rotateEncryptionKey')];
  const rotate = require('../scripts/rotateEncryptionKey');
  await assert.doesNotReject(() => rotate.selfCheck(2));
  delete process.env.ENCRYPTION_KEY_V2;
});

test('rotateEncryptionKey selfCheck: fails clearly when the target version key is NOT configured', async () => {
  delete process.env.ENCRYPTION_KEY_V2;
  delete require.cache[require.resolve('../lib/integrationCredentialStore')];
  delete require.cache[require.resolve('../scripts/rotateEncryptionKey')];
  const rotate = require('../scripts/rotateEncryptionKey');
  await assert.rejects(() => rotate.selfCheck(2), /ENCRYPTION_KEY_V2 not configured/);
});
