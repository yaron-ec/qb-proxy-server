/* eslint-disable no-undef */
/**
 * Runtime validation harness — Phase 1 (run ON the Railway proxy-server).
 *
 * Two modes (auto-selected):
 *   EXISTING-SERVER  — VALIDATION_BASE_URL (or RAILWAY_PUBLIC_DOMAIN) is set:
 *                     validate the already-running deployed service. Does NOT
 *                     spawn server.js (no EADDRINUSE risk).
 *   ISOLATED         — no service URL supplied: spawn server.js on a free
 *                     temporary port (picked via an ephemeral listener) and run
 *                     all HTTP checks against it. Only the spawned child is killed.
 *
 * SAFETY:
 *   - Sends NO email. Gmail is only refreshed (access token), never sent.
 *     /api/v1/emails/test is validated via guard rails only (401 no-token,
 *     400 non-internal recipient); the actual-send case is deferred.
 *   - Never prints DATABASE_URL, Gmail/JWT secrets, or access/refresh tokens.
 *     All response bodies are redacted before logging; server stdout is scrubbed.
 *   - All temp DB rows are namespaced (runtime-validate-* / temp user) and
 *     deleted in a finally block. Safe to rerun.
 *
 * Invocation (two possible Railway root-directory layouts):
 *   service root = src/proxy-server :  node validateRuntime.js
 *   service root = repo root          :  node src/proxy-server/validateRuntime.js
 *   existing-server mode             :  VALIDATION_BASE_URL=https://<service>.up.railway.app node validateRuntime.js
 *                                       (or just set RAILWAY_PUBLIC_DOMAIN=<host>)
 *
 * Requires service env: DATABASE_URL, RAILWAY_JWT_SECRET, ENCRYPTION_KEY,
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, PROXY_SECRET.
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');

const db = require('./db/client');
const auth = require('./lib/authService');
const gmail = require('./lib/gmailSender');

// ── Mode + base URL ───────────────────────────────────────────────────────────
function deriveExistingBase() {
  const explicit = (process.env.VALIDATION_BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const dom = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return dom ? `https://${dom}` : '';
}
const EXISTING_BASE = deriveExistingBase();
const MODE = EXISTING_BASE ? 'existing-server' : 'isolated';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEMP_EMAIL = `runtime-validate+temp-${STAMP}@ecconstructiongroup.com`;
const TEMP_PASSWORD = `Temp-Validate-${Math.random().toString(36).slice(2)}!9`;
const TEMP_CLAIM_KEY = `runtime-validate-claim-${STAMP}`;

const checks = [];
let BASE = '';
let serverProc = null;
let serverStdio = '';
let tempUserId = null;

function ok(name, detail) { checks.push({ name, ok: true }); console.log(`  \u2714 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
function bad(name, err) { checks.push({ name, ok: false }); console.error(`  \u2717 ${name} \u2014 ${err}`); }

// ── Redaction (never leak secrets / tokens) ──────────────────────────────────
const REDACT_KEY = /token|secret|password|authorization|credential|apikey|api_key/i;
function redact(v) {
  if (typeof v === 'string') {
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v) && v.length > 30) return '[redacted-jwt]';
    if (v.length > 60 && /^[A-Za-z0-9+/=_-]+$/.test(v)) return '[redacted]';
    return v;
  }
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[REDACT_KEY.test(k) ? k : k] = REDACT_KEY.test(k) ? '[redacted]' : redact(v[k]);
    return o;
  }
  return v;
}
function safeStr(obj) { try { return JSON.stringify(redact(obj)).slice(0, 300); } catch { return '[unserializable]'; } }
function redactStdio(s) {
  return s
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[redacted-jwt]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted-db-url]')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, '[redacted-oauth]');
}

async function http(method, p, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(BASE + p, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { try { json = { text: await res.text() }; } catch { /* empty */ } }
  return { status: res.status, json };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function startServerIfNeeded() {
  if (MODE === 'existing-server') { BASE = EXISTING_BASE; return true; }
  const port = await getFreePort();
  BASE = `http://127.0.0.1:${port}`;
  serverProc = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stdout.on('data', (d) => { serverStdio += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverStdio += d.toString(); });
  let exitedEarly = false;
  serverProc.on('exit', (code) => { exitedEarly = !serverProc._kept; if (exitedEarly) serverStdio += `\n[server exited early code=${code}]`; });
  return waitForHealth();
}

async function main() {
  // 1. Server reachable / started
  console.log('\n[1] Service reachable');
  try {
    const up = await startServerIfNeeded();
    if (up) ok(`1. Service starts/reachable (${MODE})`, MODE === 'isolated' ? `child on ${BASE}` : BASE);
    else { bad('1. Service starts/reachable', `not healthy within 15s. tail:\n${redactStdio(serverStdio).slice(-1200)}`); return; }
  } catch (e) { bad('1. Service starts/reachable', e.message); return; }

  // 2. /health 200
  console.log('\n[2] /health returns HTTP 200');
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.status === 200) ok('2. /health returns HTTP 200', `status ${r.status}`);
    else bad('2. /health returns HTTP 200', `status ${r.status}`);
  } catch (e) { bad('2. /health returns HTTP 200', e.message); }

  // 3. Phase 1 DB migration executes
  console.log('\n[3] Phase 1 DB migration executes');
  try {
    await db.ensureSchema();
    ok('3. Phase 1 DB migration executes successfully', 'ensureSchema() ok');
  } catch (e) { bad('3. Phase 1 DB migration executes successfully', e.message); }

  // 4. Required tables exist
  console.log('\n[4] Railway Postgres contains required tables');
  try {
    const want = ['email_send_claims', 'email_send_logs', 'users', 'refresh_tokens'];
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [want]
    );
    const have = rows.map((r) => r.table_name);
    const missing = want.filter((t) => !have.includes(t));
    if (!missing.length) ok('4. Required tables present', have.join(', '));
    else bad('4. Required tables present', 'missing: ' + missing.join(', '));
  } catch (e) { bad('4. Required tables present', e.message); }

  // 5. API endpoints respond correctly
  console.log('\n[5] API endpoints respond correctly');
  let accessToken = null;
  try {
    const u = await auth.createUser({ email: TEMP_EMAIL, full_name: 'Runtime Validate', role: 'admin', password: TEMP_PASSWORD });
    tempUserId = u.id;
  } catch (e) { bad('5. Provision temp user', e.message); }

  try {
    const login = await http('POST', '/api/v1/auth/login', { body: { email: TEMP_EMAIL, password: TEMP_PASSWORD } });
    if (login.status === 200 && login.json && login.json.access) { accessToken = login.json.access; ok('5a. /api/v1/auth/login', `200, token issued`); }
    else bad('5a. /api/v1/auth/login', `status ${login.status} body=${safeStr(login.json)}`);
  } catch (e) { bad('5a. /api/v1/auth/login', e.message); }

  try {
    const meNoTok = await http('GET', '/api/v1/auth/me');
    if (meNoTok.status === 401) ok('5b. /api/v1/auth/me rejects missing token', `401`);
    else bad('5b. /api/v1/auth/me rejects missing token', `expected 401 got ${meNoTok.status}`);
  } catch (e) { bad('5b. /api/v1/auth/me rejects missing token', e.message); }

  try {
    if (!accessToken) throw new Error('no access token');
    const me = await http('GET', '/api/v1/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (me.status === 200 && me.json && me.json.user && me.json.user.email === TEMP_EMAIL) ok('5c. /api/v1/auth/me with valid JWT', `200, email matches`);
    else bad('5c. /api/v1/auth/me with valid JWT', `status ${me.status} body=${safeStr(me.json)}`);
  } catch (e) { bad('5c. /api/v1/auth/me with valid JWT', e.message); }

  try {
    const meBad = await http('GET', '/api/v1/auth/me', { headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
    if (meBad.status === 401 || meBad.status === 403) ok('5d. /api/v1/auth/me rejects tampered token', `${meBad.status}`);
    else bad('5d. /api/v1/auth/me rejects tampered token', `expected 401/403 got ${meBad.status}`);
  } catch (e) { bad('5d. /api/v1/auth/me rejects tampered token', e.message); }

  // /emails/test guard rails only — NO send
  try {
    const tNoTok = await http('POST', '/api/v1/emails/test', { body: { to: 'yaron@ecconstructiongroup.com' } });
    if (tNoTok.status === 401) ok('5e. /api/v1/emails/test rejects missing token', `401 (no email sent)`);
    else bad('5e. /api/v1/emails/test rejects missing token', `expected 401 got ${tNoTok.status}`);
  } catch (e) { bad('5e. /api/v1/emails/test rejects missing token', e.message); }

  try {
    if (!accessToken) throw new Error('no access token');
    const tBad = await http('POST', '/api/v1/emails/test', { headers: { Authorization: `Bearer ${accessToken}` }, body: { to: 'external@example.com' } });
    if (tBad.status === 400 && tBad.json && /internal/i.test(tBad.json.error || '')) ok('5f. /api/v1/emails/test validates recipient', `400 \u2014 ${tBad.json.error} (no email sent)`);
    else bad('5f. /api/v1/emails/test validates recipient', `expected 400 internal-only got ${tBad.status} ${safeStr(tBad.json)}`);
  } catch (e) { bad('5f. /api/v1/emails/test validates recipient', e.message); }

  // 6. JWT end-to-end
  console.log('\n[6] JWT authentication end-to-end');
  const jwtCore = checks.filter((c) => c.name.startsWith('5a') || c.name.startsWith('5c')).every((c) => c.ok) && !!accessToken;
  if (jwtCore) ok('6. JWT authentication works end-to-end', 'login \u2192 token \u2192 /me verified');
  else bad('6. JWT authentication works end-to-end', 'login or /me failed (see 5a/5c)');

  // 7. EmailService idempotency claim (real DB, NO send)
  console.log('\n[7] EmailService idempotency claim (real DB)');
  try {
    const c1 = await db.query(
      `INSERT INTO email_send_claims (idempotency_key, status, recipient, subject) VALUES ($1, 'processing', $2, $3) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [TEMP_CLAIM_KEY, 'runtime@validate.local', 'Runtime validate']
    );
    const c2 = await db.query(
      `INSERT INTO email_send_claims (idempotency_key, status, recipient, subject) VALUES ($1, 'processing', $2, $3) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [TEMP_CLAIM_KEY, 'runtime@validate.local', 'Runtime validate']
    );
    await db.query(`UPDATE email_send_claims SET status='failed', last_error='simulated' WHERE idempotency_key=$1`, [TEMP_CLAIM_KEY]);
    const steal = await db.query(
      `UPDATE email_send_claims SET status='processing', updated_at=NOW(), attempts=attempts+1 WHERE id=$1 AND status='failed' RETURNING id`,
      [c1.rows[0].id]
    );
    if (c1.rows.length === 1 && c2.rows.length === 0 && steal.rows.length === 1) ok('7. Idempotency claim works', `claim ${c1.rows[0].id}, duplicate blocked, re-claim ok`);
    else bad('7. Idempotency claim works', `first=${c1.rows.length} dup=${c2.rows.length} reclaim=${steal.rows.length}`);
  } catch (e) { bad('7. Idempotency claim works', e.message); }

  // 8. Gmail credentials initialize (refresh only, NO send)
  console.log('\n[8] Gmail credentials initialize');
  try {
    const tok = await gmail.refreshAccessToken();
    if (tok && typeof tok === 'string' && tok.length > 20) ok('8. Gmail credentials initialize successfully', `access token length ${tok.length} (no email sent)`);
    else bad('8. Gmail credentials initialize successfully', 'empty/invalid access token');
  } catch (e) { bad('8. Gmail credentials initialize successfully', e.message); }
}

async function cleanup() {
  try {
    if (tempUserId) {
      await db.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [tempUserId]);
      await db.query(`DELETE FROM users WHERE id=$1`, [tempUserId]);
    }
    await db.query(`DELETE FROM email_send_logs WHERE claim_id IN (SELECT id FROM email_send_claims WHERE idempotency_key=$1)`, [TEMP_CLAIM_KEY]);
    await db.query(`DELETE FROM email_send_claims WHERE idempotency_key=$1`, [TEMP_CLAIM_KEY]);
  } catch (e) { console.error('[cleanup] failed:', e.message); }
  try { if (serverProc) { serverProc._kept = true; serverProc.kill('SIGTERM'); } } catch { /* ignore */ }
  try { await db.pool.end(); } catch { /* ignore */ }
}

(async () => {
  console.log('=== RAILWAY RUNTIME VALIDATION (no email sent) ===');
  console.log(`mode=${MODE}`);
  if (MODE === 'isolated') {
    console.log('  (no VALIDATION_BASE_URL/RAILWAY_PUBLIC_DOMAIN \u2014 spawning server.js on a free port)');
    console.log('  commands:');
    console.log('    service root = src/proxy-server :  node validateRuntime.js');
    console.log('    service root = repo root          :  node src/proxy-server/validateRuntime.js');
    console.log('  existing-server mode               :  VALIDATION_BASE_URL=https://<service>.up.railway.app node validateRuntime.js');
  }
  console.log(`stamp=${STAMP}`);
  try { await main(); } catch (e) { bad('unhandled exception', e.message); }
  await cleanup();
  console.log('\n=== SUMMARY ===');
  checks.forEach((c) => console.log(`${c.ok ? '\u2714' : '\u2717'} ${c.name}`));
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${passed}/${checks.length} checks passed.`);
  if (failed.length) { console.log('FAILURES:'); failed.forEach((c) => console.log(`  \u2717 ${c.name}`)); }
  process.exit(failed.length ? 1 : 0);
})();