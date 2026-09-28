/* eslint-disable no-undef */
'use strict';

/**
 * qbTokenLifecycle.int.test.js — REAL-Postgres proof of the QuickBooks OAuth
 * self-healing contract (lib/qbTokenManager + lib/qbTokenStore →
 * integration_credentials, AES-encrypted). Intuit and the QuickBooks API are
 * mocked; the credential store and the advisory lock are real. Skipped without
 * TEST_DATABASE_URL. Never touches a real Intuit account and never prints a
 * token value.
 *
 * Proves: expiry → auto-refresh → request succeeds with the rotated token
 * persisted encrypted; two independent manager instances (separate single-
 * flight maps — i.e. two processes) refreshing at once → ONE Intuit call via
 * the Postgres advisory lock; a transient Intuit failure keeps the credential
 * connected; a true revocation marks it revoked (reconnectRequired) without
 * deleting the row; a reconnect afterwards restores it.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(16).toString('hex');
}

const RUN = `int-${Date.now().toString(36)}`;
let db, store;
let n = 0;
const env = () => `${RUN}-${++n}`;

// A fresh manager module instance = its own in-process single-flight map, like
// a second process (the API and a worker). Only the advisory lock is shared.
function freshManager(intuit, api) {
  const p = require.resolve(path.join(ROOT, 'lib/qbTokenManager'));
  delete require.cache[p];
  const mgr = require(p);
  mgr._setDeps({
    clientId: () => 'test-client', clientSecret: () => 'test-secret',
    sleep: async () => {}, notifyReconnectRequired: async () => {},
    fetch: async (url, init) => (String(url).startsWith('https://oauth.platform.intuit.com/') ? intuit(init) : api(url, init)),
  });
  return mgr;
}
const API_OK = async () => ({ ok: true, status: 200, text: async () => '{"CompanyInfo":{"CompanyName":"Test Co"}}' });
const expiredTokens = (realm) => ({
  realm_id: realm, access_token: `old-at-${realm}`, refresh_token: `old-rt-${realm}`,
  expires_at: new Date(Date.now() - 60000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
});
function rotatingIntuit(counter) {
  return async () => {
    counter.n++;
    await new Promise(r => setTimeout(r, 150)); // hold the lock long enough for the race to be real
    return { ok: true, status: 200, json: async () => ({ access_token: `new-at-${counter.n}`, refresh_token: `new-rt-${counter.n}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 }) };
  };
}
const rawRow = async (environment) => (await db.query(
  `SELECT status, encrypted_payload FROM integration_credentials WHERE provider = 'intuit' AND environment = $1`, [environment])).rows;

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  store = require(path.join(ROOT, 'lib/qbTokenStore'));
});
test.after(async () => {
  if (skip) return;
  await db.query(`DELETE FROM integration_credentials WHERE provider = 'intuit' AND environment LIKE $1`, [`${RUN}-%`]);
  await db.pool.end();
});

test('expired access token → auto-refresh → request succeeds; rotated pair persisted ENCRYPTED', { skip }, async () => {
  const e = env();
  await store.savePersistedTokens(e, expiredTokens('R1'));
  const c = { n: 0 };
  let presented;
  const mgr = freshManager(rotatingIntuit(c), async (url, init) => { presented = init.headers.Authorization; return API_OK(); });
  const r = await mgr.qbApiRequest(e, (t) => `https://quickbooks.api.intuit.com/v3/company/${t.realm_id}/companyinfo/${t.realm_id}`);
  assert.strictEqual(r.res.status, 200);
  assert.strictEqual(c.n, 1);
  assert.strictEqual(presented, 'Bearer new-at-1');
  const t = await store.loadPersistedTokens(e);
  assert.strictEqual(t.refresh_token, 'new-rt-1');
  assert.ok(new Date(t.refresh_expires_at) > new Date(Date.now() + 80 * 86400000));
  const rows = await rawRow(e);
  assert.strictEqual(rows.length, 1);
  assert.ok(!String(rows[0].encrypted_payload).includes('new-rt-1'), 'token is not stored in plaintext');
  assert.strictEqual(await store.credentialStatus(e), 'connected');
});

test('two independent manager instances (≈ two processes) refresh at once → ONE Intuit call (advisory lock)', { skip }, async () => {
  const e = env();
  await store.savePersistedTokens(e, expiredTokens('R2'));
  const c = { n: 0 };
  const a = freshManager(rotatingIntuit(c), API_OK);
  const b = freshManager(rotatingIntuit(c), API_OK);
  assert.notStrictEqual(a, b);
  const [ta, tb, tc] = await Promise.all([a.getValidTokens(e), b.getValidTokens(e), a.getValidTokens(e)]);
  assert.strictEqual(c.n, 1, 'exactly one refresh across both instances');
  assert.strictEqual(ta.refresh_token, 'new-rt-1');
  assert.strictEqual(tb.refresh_token, 'new-rt-1', 'the second instance reuses the rotated token');
  assert.strictEqual(tc.refresh_token, 'new-rt-1');
  assert.strictEqual((await store.loadPersistedTokens(e)).refresh_token, 'new-rt-1');
});

test('transient Intuit failure (503 ×3) → bounded, credential stays CONNECTED with its refresh token; next call heals', { skip }, async () => {
  const e = env();
  await store.savePersistedTokens(e, expiredTokens('R3'));
  let calls = 0;
  const mgr = freshManager(async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; }, API_OK);
  await assert.rejects(mgr.getValidTokens(e), (err) => err.transient === true && !err.reconnectRequired);
  assert.strictEqual(calls, 3);
  assert.strictEqual(await store.credentialStatus(e), 'connected');
  assert.strictEqual((await store.loadPersistedTokens(e)).refresh_token, 'old-rt-R3');
  const c = { n: 0 };
  const healed = freshManager(rotatingIntuit(c), API_OK);
  assert.strictEqual((await healed.getValidTokens(e)).refresh_token, 'new-rt-1');
});

test('true revocation → credential REVOKED (row kept, not deleted) → reconnectRequired; an OAuth reconnect restores it', { skip }, async () => {
  const e = env();
  await store.savePersistedTokens(e, expiredTokens('R4'));
  const mgr = freshManager(async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }), API_OK);
  const v = await mgr.verifyConnection(e, 'https://quickbooks.api.intuit.com/v3/company');
  assert.deepStrictEqual([v.ok, v.reconnectRequired], [false, true]);
  assert.strictEqual(await store.credentialStatus(e), 'revoked');
  assert.strictEqual(await store.loadPersistedTokens(e), null);
  assert.deepStrictEqual((await rawRow(e)).map(r => r.status), ['revoked']);
  await assert.rejects(mgr.getValidTokens(e), (err) => err.reconnectRequired === true);
  // Admin re-consents via OAuth → saved under the refresh lock → connected again.
  await mgr.saveAuthorizedTokens(e, { ...expiredTokens('R4'), access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_at: new Date(Date.now() + 3600000).toISOString() });
  assert.strictEqual(await store.credentialStatus(e), 'connected');
  assert.strictEqual((await mgr.verifyConnection(e, 'https://quickbooks.api.intuit.com/v3/company')).ok, true);
});
