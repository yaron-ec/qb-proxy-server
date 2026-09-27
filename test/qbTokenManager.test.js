/* eslint-disable no-undef */
'use strict';

/**
 * qbTokenManager.test.js — the ONE QuickBooks refresh path (lib/qbTokenManager).
 *
 * Production finding: /health showed connected=true, tokenExpired=true.
 * Two independent refresh implementations ran on the same 15-minute cron
 * minute in one process — server.js (in-memory, mutexed, never re-read the DB)
 * and lib/qbInboundSync.js (DB, no lock, dropped refresh_token_expires_at).
 * Intuit rotates refresh tokens, so the inbound path left server.js holding a
 * stale pair: /health reported the stale copy as expired, and server.js's next
 * refresh could present a rotated refresh token (→ invalid_grant → "revoked").
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// In-memory token store + fake advisory-lock pool + fake Intuit.
let persisted = null;
const store = {
  saves: 0, revoked: 0, errors: 0,
  loadPersistedTokens: async () => (persisted ? { ...persisted } : null),
  savePersistedTokens: async (_env, t) => { store.saves++; persisted = { ...t }; return 'postgres'; },
  markRevoked: async () => { store.revoked++; },
  markError: async () => { store.errors++; },
};
const storePath = require.resolve('../lib/qbTokenStore');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: store };

const mgr = require('../lib/qbTokenManager');
let lockCalls = [];
let lockHeld = Promise.resolve();
const pool = {
  connect: async () => ({
    query: async (sql) => {
      lockCalls.push(sql.includes('unlock') ? 'unlock' : 'lock');
      if (!sql.includes('unlock')) { const prev = lockHeld; let release; lockHeld = new Promise(r => { release = r; }); pool._release = release; await prev; }
      else if (pool._release) pool._release();
      return { rows: [] };
    },
    release() {},
  }),
};
let intuitCalls = 0;
let intuitResponse = () => ({ ok: true, body: { access_token: `at-${intuitCalls}`, refresh_token: `rt-${intuitCalls}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 } });
mgr._setDeps({
  pool: () => pool, clientId: () => 'id', clientSecret: () => 'secret',
  fetch: async (url, init) => {
    intuitCalls++;
    assert.match(String(init.body), /grant_type=refresh_token/);
    await new Promise(r => setTimeout(r, 10));
    const r = intuitResponse();
    return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.body };
  },
});

const expired = () => ({ access_token: 'old', refresh_token: 'rt-old', realm_id: 'R1',
  expires_at: new Date(Date.now() - 60000).toISOString(), refresh_expires_at: new Date(Date.now() + 86400000).toISOString() });

test.beforeEach(() => { intuitCalls = 0; lockCalls = []; store.saves = 0; store.revoked = 0; store.errors = 0; });

test('a valid access token is returned from the store without any refresh or lock', async () => {
  persisted = { ...expired(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  const t = await mgr.getValidTokens('production');
  assert.strictEqual(t.access_token, 'old');
  assert.strictEqual(intuitCalls, 0);
  assert.deepStrictEqual(lockCalls, []);
});

test('expired: 6 simultaneous callers → exactly ONE Intuit refresh; rotated token AND its expiry persisted', async () => {
  persisted = expired();
  const results = await Promise.all(Array.from({ length: 6 }, () => mgr.getValidTokens('production')));
  assert.strictEqual(intuitCalls, 1);
  assert.ok(results.every(t => t.access_token === 'at-1'));
  assert.strictEqual(persisted.refresh_token, 'rt-1');
  assert.ok(new Date(persisted.refresh_expires_at) > new Date(Date.now() + 80 * 86400000), 'refresh-token expiry updated');
  assert.ok(persisted.last_refresh_at);
});

test('another process refreshed while we waited for the lock → reuse its token, never rotate twice', async () => {
  persisted = expired();
  const realLoad = store.loadPersistedTokens;
  let n = 0;
  store.loadPersistedTokens = async () => {
    n++;
    if (n === 2) persisted = { ...persisted, access_token: 'fresh-from-other-process', refresh_token: 'rt-other', expires_at: new Date(Date.now() + 3600000).toISOString() };
    return { ...persisted };
  };
  try {
    const t = await mgr.getValidTokens('production');
    assert.strictEqual(t.access_token, 'fresh-from-other-process');
    assert.strictEqual(intuitCalls, 0);
    assert.deepStrictEqual(lockCalls, ['lock', 'unlock']);
  } finally { store.loadPersistedTokens = realLoad; }
});

test('force after a 401: skipped when the stored token already changed; refreshes when it is the rejected one', async () => {
  persisted = { ...expired(), access_token: 'newer', expires_at: new Date(Date.now() + 3600000).toISOString() };
  assert.strictEqual((await mgr.getValidTokens('production', { force: true, staleAccessToken: 'rejected' })).access_token, 'newer');
  assert.strictEqual(intuitCalls, 0);
  assert.strictEqual((await mgr.getValidTokens('production', { force: true, staleAccessToken: 'newer' })).access_token, 'at-1');
  assert.strictEqual(intuitCalls, 1);
});

test('invalid_grant → credential marked revoked and ReconnectRequiredError (reconnectRequired=true)', async () => {
  persisted = expired();
  intuitResponse = () => ({ ok: false, body: { error: 'invalid_grant', error_description: 'Token invalid' } });
  try {
    await assert.rejects(mgr.getValidTokens('production'), (e) => e.reconnectRequired === true && /RECONNECT_REQUIRED/.test(e.message));
    assert.strictEqual(store.revoked, 1);
  } finally {
    intuitResponse = () => ({ ok: true, body: { access_token: `at-${intuitCalls}`, refresh_token: `rt-${intuitCalls}`, expires_in: 3600 } });
  }
});

test('an expired refresh token never calls Intuit; never-connected is null for inbound sync, an error otherwise', async () => {
  persisted = { ...expired(), refresh_expires_at: new Date(Date.now() - 1000).toISOString() };
  await assert.rejects(mgr.getValidTokens('production'), /Refresh token expired/);
  assert.strictEqual(intuitCalls, 0);
  persisted = null;
  assert.strictEqual(await mgr.getValidTokens('production', { requireConnected: false }), null);
  await assert.rejects(mgr.getValidTokens('production'), /never been connected/);
});

test('one implementation: server.js, qbInboundSync (and qbSyncTrigger through it) all delegate to qbTokenManager', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const inbound = fs.readFileSync(path.join(root, 'lib/qbInboundSync.js'), 'utf8');
  const count = (src) => (src.match(/grant_type:\s*'refresh_token'/g) || []).length;
  assert.strictEqual(count(inbound), 0, 'qbInboundSync no longer refreshes on its own');
  assert.strictEqual(count(server), 0, 'server.js no longer refreshes on its own');
  assert.match(server, /qbTokens\.getValidTokens\(QB_ENVIRONMENT\)/);
  assert.match(inbound, /qbTokenManager\.getValidTokens\(environment, \{ requireConnected: false \}\)/);
  assert.match(fs.readFileSync(path.join(root, 'lib/qbSyncTrigger.js'), 'utf8'), /require\('\.\/qbInboundSync'\)/);
  // /health reads the persisted credential, not an in-memory copy.
  const health = server.slice(server.indexOf('async function buildHealthPayload'), server.indexOf('// General health'));
  assert.match(health, /tokenStore\.loadPersistedTokens\(QB_ENVIRONMENT\)/);
  assert.doesNotMatch(health, /storedTokens/);
  assert.match(health, /expired_refreshes_on_next_use/);
});
