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
  saves: 0, revoked: 0, errors: 0, used: 0,
  loadPersistedTokens: async () => (persisted ? { ...persisted } : null),
  savePersistedTokens: async (_env, t) => { store.saves++; persisted = { ...t }; return 'postgres'; },
  markRevoked: async () => { store.revoked++; },
  markError: async () => { store.errors++; },
  markUsed: async () => { store.used++; },
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
let apiCalls = [];
let apiResponse = () => ({ status: 200, body: { CompanyInfo: { CompanyName: 'X' } } });
let notified = [];
let sleeps = [];
let intuitResponse = () => ({ ok: true, body: { access_token: `at-${intuitCalls}`, refresh_token: `rt-${intuitCalls}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 } });
const depsInit = {
  pool: () => pool, clientId: () => 'id', clientSecret: () => 'secret',
  sleep: async (ms) => { sleeps.push(ms); },
  notifyReconnectRequired: async (env, realm, reason) => { notified.push({ env, realm, reason }); },
  fetch: async (url, init) => {
    if (!String(url).startsWith('https://oauth.platform.intuit.com/')) {
      // QuickBooks API call: record which access token was presented (never printed).
      apiCalls.push({ url: String(url), bearer: init.headers.Authorization.replace(/^Bearer /, '') });
      const r = apiResponse(apiCalls[apiCalls.length - 1]);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
    }
    intuitCalls++;
    assert.match(String(init.body), /grant_type=refresh_token/);
    await new Promise(r => setTimeout(r, 10));
    const r = intuitResponse();
    return { ok: r.ok, status: r.status || (r.ok ? 200 : 400), json: async () => r.body };
  },
};
mgr._setDeps(depsInit);
const realFetch = depsInit.fetch;

const expired = () => ({ access_token: 'old', refresh_token: 'rt-old', realm_id: 'R1',
  expires_at: new Date(Date.now() - 60000).toISOString(), refresh_expires_at: new Date(Date.now() + 86400000).toISOString() });

const OK_INTUIT = () => ({ ok: true, body: { access_token: `at-${intuitCalls}`, refresh_token: `rt-${intuitCalls}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 } });
test.beforeEach(() => {
  intuitCalls = 0; lockCalls = []; apiCalls = []; notified = []; sleeps = [];
  store.saves = 0; store.revoked = 0; store.errors = 0; store.used = 0;
  intuitResponse = OK_INTUIT;
  apiResponse = () => ({ status: 200, body: { CompanyInfo: { CompanyName: 'X' } } });
});
const API = (t) => `https://quickbooks.api.intuit.com/v3/company/${t.realm_id}/companyinfo/${t.realm_id}`;

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

// ── Self-healing lifecycle (A–I) ─────────────────────────────────────────────

test('expired access token → auto-refresh → the API request succeeds with the NEW token', async () => {
  persisted = expired();
  const r = await mgr.qbApiRequest('production', API);
  assert.strictEqual(r.res.status, 200);
  assert.strictEqual(intuitCalls, 1);
  assert.strictEqual(apiCalls.length, 1);
  assert.strictEqual(apiCalls[0].bearer, 'at-1', 'the refreshed token is used, never the expired one');
  assert.strictEqual(persisted.refresh_token, 'rt-1', 'rotated refresh token persisted');
  assert.strictEqual(store.used, 1, 'last_used_at recorded on success');
});

test('recoverable 401 → one canonical refresh → the request is retried exactly once', async () => {
  persisted = { ...expired(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  apiResponse = (c) => (c.bearer === 'old' ? { status: 401, body: { fault: 'AuthenticationFailed' } } : { status: 200, body: { CompanyInfo: { CompanyName: 'X' } } });
  const r = await mgr.qbApiRequest('production', API);
  assert.strictEqual(r.res.status, 200);
  assert.deepStrictEqual(apiCalls.map(c => c.bearer), ['old', 'at-1']);
  assert.strictEqual(intuitCalls, 1);
});

test('a persistent 401 is NOT retried forever: two API attempts, one refresh, then the 401 is returned', async () => {
  persisted = { ...expired(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  apiResponse = () => ({ status: 401, body: { fault: 'AuthenticationFailed' } });
  const r = await mgr.qbApiRequest('production', API);
  assert.strictEqual(r.res.status, 401);
  assert.strictEqual(apiCalls.length, 2);
  assert.strictEqual(intuitCalls, 1);
  assert.strictEqual(store.revoked, 0, 'an API 401 alone never marks the credential revoked');
});

test('simultaneous 401s from many callers → ONE refresh (single-flight + lock), all retried with the new token', async () => {
  persisted = { ...expired(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  apiResponse = (c) => (c.bearer === 'old' ? { status: 401, body: {} } : { status: 200, body: {} });
  const rs = await Promise.all(Array.from({ length: 5 }, () => mgr.qbApiRequest('production', API)));
  assert.ok(rs.every(r => r.res.status === 200));
  assert.strictEqual(intuitCalls, 1);
});

test('transient Intuit 5xx/429 → bounded retry with backoff; success on a later attempt; never revoked', async () => {
  persisted = expired();
  let n = 0;
  intuitResponse = () => (++n < 3 ? { ok: false, status: n === 1 ? 503 : 429, body: {} } : OK_INTUIT());
  const t = await mgr.getValidTokens('production');
  assert.strictEqual(intuitCalls, 3);
  assert.deepStrictEqual(sleeps, [500, 1500]);
  assert.ok(t.access_token.startsWith('at-'));
  assert.strictEqual(store.revoked, 0);
  assert.deepStrictEqual(notified, []);
});

test('transient failure that persists → bounded (3 attempts), a transient error, NOT reconnectRequired, credential kept', async () => {
  persisted = expired();
  intuitResponse = () => ({ ok: false, status: 502, body: { error: 'invalid_grant' } }); // 5xx is never read as revocation
  await assert.rejects(mgr.getValidTokens('production'), (e) => e.transient === true && !e.reconnectRequired);
  assert.strictEqual(intuitCalls, 3);
  assert.strictEqual(store.revoked, 0);
  assert.deepStrictEqual(notified, []);
  assert.strictEqual(persisted.refresh_token, 'rt-old', 'the refresh token is kept for the next attempt');
  // The next call recovers on its own once Intuit is healthy again.
  intuitResponse = OK_INTUIT;
  assert.ok((await mgr.getValidTokens('production')).access_token.startsWith('at-'));
});

test('a network error during refresh is transient — never marks revoked', async () => {
  persisted = expired();
  mgr._setDeps({ fetch: async () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); } });
  try {
    await assert.rejects(mgr.getValidTokens('production'), (e) => !e.reconnectRequired);
    assert.strictEqual(store.revoked, 0);
    assert.deepStrictEqual(notified, []);
  } finally { mgr._setDeps({ fetch: realFetch }); }
});

test('true revocation (invalid_grant) → reconnectRequired, revoked, Admin alert sent once, no token in the diagnostic', async () => {
  persisted = expired();
  intuitResponse = () => ({ ok: false, status: 400, body: { error: 'invalid_grant', error_description: 'Incorrect Token type or clientID' } });
  await assert.rejects(mgr.qbApiRequest('production', API), (e) => e.reconnectRequired === true);
  assert.strictEqual(store.revoked, 1);
  assert.deepStrictEqual(notified, [{ env: 'production', realm: 'R1', reason: 'invalid_grant' }]);
  assert.strictEqual(apiCalls.length, 0, 'no API request is attempted with a dead credential');
  assert.strictEqual(intuitCalls, 1, 'a revocation is never retried');
});

test('rotation CAS: a reconnect that lands during a refresh is never overwritten by the older refresh result', async () => {
  persisted = expired();
  const realLoad = store.loadPersistedTokens;
  let n = 0;
  store.loadPersistedTokens = async () => {
    n++;
    // 1: fast-path read, 2: under-lock read, 3: CAS re-read after Intuit — a new authorization landed.
    if (n === 3) persisted = { ...persisted, access_token: 'reconnected', refresh_token: 'rt-reconnected', expires_at: new Date(Date.now() + 3600000).toISOString() };
    return { ...persisted };
  };
  try {
    const t = await mgr.getValidTokens('production');
    assert.strictEqual(intuitCalls, 1);
    assert.strictEqual(t.refresh_token, 'rt-reconnected');
    assert.strictEqual(persisted.refresh_token, 'rt-reconnected', 'the newer credential survives');
    assert.strictEqual(store.saves, 0, 'the older refresh result is discarded, not saved');
  } finally { store.loadPersistedTokens = realLoad; }
});

test('saveAuthorizedTokens (OAuth callback) persists under the SAME advisory lock as refresh', async () => {
  persisted = null;
  await mgr.saveAuthorizedTokens('production', { access_token: 'a', refresh_token: 'r', realm_id: 'R1' });
  assert.deepStrictEqual(lockCalls, ['lock', 'unlock']);
  assert.strictEqual(persisted.refresh_token, 'r');
});

test('verifyConnection proves real API access (companyinfo) and reports revocation / transient distinctly', async () => {
  persisted = { ...expired(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  const ok = await mgr.verifyConnection('production', 'https://quickbooks.api.intuit.com/v3/company');
  assert.deepStrictEqual([ok.ok, ok.status, ok.reconnectRequired, ok.companyNamePresent], [true, 200, false, true]);
  assert.match(apiCalls[0].url, /\/companyinfo\/R1/);
  assert.ok(!JSON.stringify(ok).includes('old'), 'no token value in the verification result');

  apiResponse = () => ({ status: 503, body: {} });
  const down = await mgr.verifyConnection('production', 'https://quickbooks.api.intuit.com/v3/company');
  assert.deepStrictEqual([down.ok, down.status, down.reconnectRequired], [false, 503, false]);

  persisted = expired();
  intuitResponse = () => ({ ok: false, status: 400, body: { error: 'invalid_grant' } });
  const revoked = await mgr.verifyConnection('production', 'https://quickbooks.api.intuit.com/v3/company');
  assert.deepStrictEqual([revoked.ok, revoked.reconnectRequired], [false, true]);
});

test('no second QuickBooks auth path: no raw Bearer QuickBooks fetch and no refresh_token grant outside qbTokenManager', () => {
  const root = path.join(__dirname, '..');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const f = path.join(d, e.name);
    // .claude/worktrees holds full repo copies for isolated subagent runs
    // (Agent tool isolation: "worktree") — without this exclusion, a
    // background agent running concurrently with this test suite makes this
    // scan see duplicate (and possibly stale, since a worktree can lag HEAD)
    // copies of every backend file, causing spurious failures unrelated to
    // the actual working tree's code.
    if (e.isDirectory()) return ['node_modules', 'test', 'crm-frontend', 'migration-baseline', '.git', '.claude'].includes(e.name) ? [] : walk(f);
    return f.endsWith('.js') ? [f] : [];
  });
  const offenders = [];
  for (const f of walk(root)) {
    const rel = path.relative(root, f);
    if (rel === path.join('lib', 'qbTokenManager.js')) continue;
    const src = fs.readFileSync(f, 'utf8');
    const qbRelated = /quickbooks|QB_API_BASE|realm_id/i.test(src);
    if (qbRelated && /Bearer \$\{[^}]*access_token\}/.test(src)) offenders.push(`${rel}: raw Bearer QuickBooks request`);
    if (qbRelated && /grant_type:\s*'refresh_token'|grant_type=refresh_token/.test(src) && /intuit/i.test(src)) offenders.push(`${rel}: second Intuit refresh`);
  }
  assert.deepStrictEqual(offenders, []);
  const mgrSrc = fs.readFileSync(path.join(root, 'lib/qbTokenManager.js'), 'utf8');
  assert.strictEqual((mgrSrc.match(/grant_type: 'refresh_token'/g) || []).length, 1, 'exactly one refresh request');
  assert.doesNotMatch(mgrSrc, /password|username|puppeteer|playwright/i, 'OAuth only — no credential login or browser automation');
});

test('/qb/health reflects real connectivity: credentialStatus, last successful API call, authenticated-only live verify', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const health = server.slice(server.indexOf('async function buildHealthPayload'), server.indexOf('// General health'));
  assert.match(health, /credentialStatus/);
  assert.match(health, /lastSuccessfulApiCallAt/);
  assert.match(health, /qbTokens\.verifyConnection\(QB_ENVIRONMENT, QB_API_BASE\)/);
  assert.match(health, /reconnectRequired = [^;]*apiVerification\?\.reconnectRequired/, 'a live revocation is reported as reconnectRequired');
  assert.match(server, /app\.get\('\/qb\/health'[\s\S]{0,200}verify: req\.query\.verify === '1' && isAuthenticatedRequest\(req\)/);
  assert.match(server, /app\.get\('\/health', async \(req, res\) => \{\s*res\.json\(await buildHealthPayload\(\)\)/, 'public /health never calls Intuit');
  assert.doesNotMatch(health, /access_token:|refresh_token:/, 'no token value in the health payload');
});
