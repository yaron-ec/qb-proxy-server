/* eslint-disable no-undef */
'use strict';

/**
 * moduleGateWiring.int.test.js — REAL-Postgres proof that
 * lib/moduleGate.js#requireModuleEnabled is actually WIRED into the
 * QuickBooks and Meta routers (PRODUCTIZATION PHASE 2), not just correct in
 * isolation (test/moduleGate.test.js covers the middleware itself with a
 * mocked companyConfig). A disabled module must 404 at the real route, and
 * the QB cron reconciliation endpoint (routes/cronJobs.js#/qb-inbound-reconcile,
 * which calls lib/qbInboundSync.js directly — never through
 * routes/qbInboundSync.js's own gated router) must also respect the gate, or
 * a company with QuickBooks disabled would still have its cron fire real QB
 * API calls on a schedule.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  process.env.WORKER_SECRET = process.env.WORKER_SECRET || 'int-test-worker-secret';
}

let base, server, db, token, companyConfig;

async function api(method, url, body, headers) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

let insertedCompanySettingsId = null;

async function setModule(key, enabled) {
  const existing = (await db.query('SELECT id, enabled_modules FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  const modules = { ...(existing ? existing.enabled_modules : {}), [key]: enabled };
  if (existing) {
    await db.query('UPDATE company_settings SET enabled_modules = $1 WHERE id = $2', [JSON.stringify(modules), existing.id]);
  } else {
    // company_settings is a singleton (ORDER BY created_at ASC LIMIT 1) —
    // track that THIS file created the very first row so test.after() can
    // remove it, never leaving it behind for other files in an aggregate
    // `npm run test:integration` run (e.g. productization.int.test.js's own
    // "zero existing rows" fixture).
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, enabled_modules) VALUES ('Module Gate Test Co', $1) RETURNING id`,
      [JSON.stringify(modules)]
    );
    insertedCompanySettingsId = ins.rows[0].id;
  }
  companyConfig.invalidate();
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  companyConfig = require(path.join(ROOT, 'lib/companyConfig'));
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  token = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'admin@test.example', role: 'admin' });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/lead-qb', require(path.join(ROOT, 'routes/leadQB')));
  app.use('/api/v1/qb-inbound', require(path.join(ROOT, 'routes/qbInboundSync')));
  app.use('/api/v1/meta-webhook', require(path.join(ROOT, 'routes/metaWebhook')));
  app.use('/api/v1/cron', require(path.join(ROOT, 'routes/cronJobs')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  if (insertedCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedCompanySettingsId]);
  companyConfig.invalidate();
  server.close();
  await db.pool.end();
});

test('routes/leadQB.js: quickbooks disabled -> 404 module_disabled (never a missing-credential 500)', { skip }, async () => {
  await setModule('quickbooks', false);
  const r = await api('GET', '/api/v1/lead-qb/by-external/does-not-exist');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'module_disabled');
  assert.strictEqual(r.body.module, 'quickbooks');
});

test('routes/leadQB.js: quickbooks enabled -> gate passes (reaches the real handler, a 404 for a different reason)', { skip }, async () => {
  await setModule('quickbooks', true);
  const r = await api('GET', '/api/v1/lead-qb/by-external/does-not-exist');
  assert.notStrictEqual(r.body?.error, 'module_disabled');
});

test('routes/qbInboundSync.js: quickbooks disabled -> 404 module_disabled on every route, including the worker-secret ones', { skip }, async () => {
  await setModule('quickbooks', false);
  const r = await api('POST', '/api/v1/qb-inbound/sync-all', {}, { 'x-worker-secret': process.env.WORKER_SECRET });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'module_disabled');
});

test('routes/cronJobs.js#/qb-inbound-reconcile: quickbooks disabled -> 404, never calls syncAllMappedCustomers', { skip }, async () => {
  await setModule('quickbooks', false);
  const r = await api('POST', '/api/v1/cron/qb-inbound-reconcile', {}, { 'x-worker-secret': process.env.WORKER_SECRET });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'module_disabled');
  assert.strictEqual(r.body.module, 'quickbooks');
});

test('routes/metaWebhook.js: GET verification handshake always responds, regardless of module state', { skip }, async () => {
  await setModule('meta', false);
  const res = await fetch(`${base}/api/v1/meta-webhook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=wrong`);
  // Wrong verify token -> 403 verification_failed, NOT 404 module_disabled —
  // proves the GET handshake is never gated.
  assert.strictEqual(res.status, 403);
});

test('routes/metaWebhook.js: POST (lead processing) is gated — meta disabled -> 404 module_disabled', { skip }, async () => {
  await setModule('meta', false);
  const res = await fetch(`${base}/api/v1/meta-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error, 'module_disabled');
  assert.strictEqual(body.module, 'meta');
});

test('routes/metaWebhook.js: POST reaches the real handler (a different failure) when meta is enabled', { skip }, async () => {
  await setModule('meta', true);
  const res = await fetch(`${base}/api/v1/meta-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await res.json().catch(() => null);
  assert.notStrictEqual(body?.error, 'module_disabled');
});
