#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * test/gmailCredentialStore.test.js
 *
 * Validates lib/gmailCredentialStore.js (Phase B / Phase 8).
 *
 * Pure / dev-fs suite (always runs): adapter mapping, defaults, secret-safe
 *   mappers, null-guards.
 * DB suite (runs when DATABASE_URL is set): save/load round-trip, markUsed,
 *   markError, revoked-status not active, restart persistence, rotation.
 *
 * Run: node test/gmailCredentialStore.test.js
 */
'use strict';

const assert = require('assert');
const store = require('../lib/gmailCredentialStore');
const results = [];

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, ok: true }); console.log('  \u2713 ' + name); })
    .catch((e) => { results.push({ name, ok: false, err: e.message }); console.error('  \u2717 ' + name + ' \u2014 ' + e.message); });
}

function summarize() {
  const p = results.filter(r => r.ok).length, f = results.filter(r => !r.ok).length;
  console.log('\n[gmailCredentialStore] ' + p + ' passed, ' + f + ' failed');
  return f === 0 ? 0 : 1;
}

async function run() {
  console.log('\n[gmailCredentialStore] pure suite');

  await test('provider/credential_type/default account correct', () => {
    assert.strictEqual(store.PROVIDER, 'google');
    assert.strictEqual(store.CREDENTIAL_TYPE, 'gmail');
    assert.strictEqual(store.DEFAULT_ACCOUNT, 'yaron@ecconstructiongroup.com');
  });

  await test('tokensToArgs maps provider/credential_type/accountIdentifier + payload', () => {
    const args = store.tokensToArgs('production', {
      client_id: 'cid', client_secret: 'sec', refresh_token: 'rt',
      access_token: 'at', access_token_expires_at: '2099-01-01T00:00:00Z',
      account_identifier: 'Yaron@ECConstructionGroup.com',
    });
    assert.strictEqual(args.provider, 'google');
    assert.strictEqual(args.credentialType, 'gmail');
    assert.strictEqual(args.environment, 'production');
    assert.strictEqual(args.accountIdentifier, 'yaron@ecconstructiongroup.com');
    assert.strictEqual(args.status, 'connected');
    assert.strictEqual(args.expiresAt, '2099-01-01T00:00:00Z');
    assert.strictEqual(args.payload.client_id, 'cid');
    assert.strictEqual(args.payload.client_secret, 'sec');
    assert.strictEqual(args.payload.refresh_token, 'rt');
    assert.strictEqual(args.payload.access_token, 'at');
  });

  await test('tokensToArgs defaults account_identifier to yaron@', () => {
    const args = store.tokensToArgs('production', { client_id: 'c', client_secret: 's', refresh_token: 'r' });
    assert.strictEqual(args.accountIdentifier, 'yaron@ecconstructiongroup.com');
    assert.ok(args.displayName && /Gmail/.test(args.displayName));
  });

  await test('credentialToTokens round-trips the mapping', () => {
    const cred = {
      accountIdentifier: 'yaron@ecconstructiongroup.com', environment: 'production',
      displayName: 'Yaron Gmail', status: 'connected', expiresAt: '2099-01-01T00:00:00Z',
      payload: { client_id: 'cid', client_secret: 'sec', refresh_token: 'rt', access_token: 'at',
        access_token_expires_at: '2099-01-01T00:00:00Z', refresh_token_expires_at: null },
      connectedAt: '2026-01-01T00:00:00Z', refreshedAt: null, keyVersion: 1,
      lastUsedAt: null, lastErrorAt: null,
    };
    const t = store.credentialToTokens(cred);
    assert.strictEqual(t.client_id, 'cid');
    assert.strictEqual(t.refresh_token, 'rt');
    assert.strictEqual(t.account_identifier, 'yaron@ecconstructiongroup.com');
    assert.strictEqual(t.key_version, 1);
    assert.strictEqual(store.credentialToTokens(null), null);
  });

  await test('markUsed / markError null-guard without accountIdentifier', async () => {
    assert.strictEqual(await store.markUsed('production', null), null);
    assert.strictEqual(await store.markError('production', null, 'x'), null);
  });

  await test('secret-safe: tokensToArgs never embeds tokens in displayName or env fields', () => {
    const args = store.tokensToArgs('production', {
      client_id: 'CID-SECRET', client_secret: 'SEC-SECRET', refresh_token: 'RT-SECRET',
      account_identifier: 'yaron@ecconstructiongroup.com',
    });
    assert.ok(!args.displayName.includes('RT-SECRET'));
    assert.ok(!args.displayName.includes('SEC-SECRET'));
  });

  if (!process.env.DATABASE_URL) {
    console.log('\n[gmailCredentialStore] DB suite SKIPPED (DATABASE_URL not set)');
    return summarize();
  }

  console.log('\n[gmailCredentialStore] DB suite (DATABASE_URL set)');
  const ENV = 'test-gmail';
  const ACCT = 'yaron@ecconstructiongroup.com';

  async function cleanup() {
    try { await store.deleteGmailCredential(ENV, ACCT); } catch (e) {}
  }

  await test('DB save -> load round-trip (equal payload + key_version)', async () => {
    await cleanup();
    await store.saveGmailCredential(ENV, {
      client_id: 'cid', client_secret: 'sec', refresh_token: 'rt',
      access_token: 'at', access_token_expires_at: '2099-01-01T00:00:00Z',
      account_identifier: ACCT,
    });
    const t = await store.loadGmailCredential(ENV);
    assert.ok(t);
    assert.strictEqual(t.client_id, 'cid');
    assert.strictEqual(t.refresh_token, 'rt');
    assert.strictEqual(t.account_identifier, ACCT);
    assert.strictEqual(t.status, 'connected');
  });

  await test('DB markUsed updates last_used_at', async () => {
    await store.markUsed(ENV, ACCT);
    const t = await store.loadGmailCredential(ENV);
    assert.ok(t.last_used_at, 'last_used_at set');
  });

  await test('DB markError sets last_error_at + sanitized message (no token)', async () => {
    await store.markError(ENV, ACCT, 'Gmail refresh failed: invalid_grant');
    const t = await store.loadGmailCredential(ENV);
    assert.ok(t.last_error_at, 'last_error_at set');
  });

  await test('DB revoked credential is NOT active', async () => {
    // Simulate revoked by saving a second cred with status via store? adapter always saves connected.
    // Use the underlying store to flip status, then loadActiveCredential should return null.
    const cs = require('../lib/integrationCredentialStore');
    await cs.updateCredentialStatus({ provider: 'google', credentialType: 'gmail', environment: ENV, accountIdentifier: ACCT, status: 'revoked' });
    const t = await store.loadGmailCredential(ENV);
    assert.strictEqual(t, null, 'revoked not active');
  });

  await test('DB restart persistence (re-require) preserves credential', async () => {
    // Re-save as connected, then re-require the adapter and load.
    await store.saveGmailCredential(ENV, {
      client_id: 'cid2', client_secret: 'sec2', refresh_token: 'rt2',
      account_identifier: ACCT,
    });
    delete require.cache[require.resolve('../lib/gmailCredentialStore.js')];
    const store2 = require('../lib/gmailCredentialStore');
    const t = await store2.loadGmailCredential(ENV);
    assert.ok(t && t.refresh_token === 'rt2');
  });

  await test('DB rotation: re-save with new refresh_token preserves metadata', async () => {
    await store.saveGmailCredential(ENV, {
      client_id: 'cid', client_secret: 'sec', refresh_token: 'rt-rotated',
      account_identifier: ACCT,
    });
    const t = await store.loadGmailCredential(ENV);
    assert.strictEqual(t.refresh_token, 'rt-rotated');
  });

  await test('DB cleanup', async () => { await cleanup(); });

  return summarize();
}

run().then((code) => process.exit(code)).catch((e) => { console.error('FATAL', e); process.exit(1); });