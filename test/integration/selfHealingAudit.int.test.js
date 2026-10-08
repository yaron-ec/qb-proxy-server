/* eslint-disable no-undef */
'use strict';

/**
 * selfHealingAudit.int.test.js — CRM PRODUCTION final reliability audit.
 * Real-Postgres proof for:
 *   1. The three newly-gated routes (routes/gmail.js, routes/leadEmails.js,
 *      routes/websiteLeads.js) actually 404 module_disabled when their
 *      module flag is off, and are reachable when it's on — same pattern as
 *      test/integration/moduleGateWiring.int.test.js's existing QB/Meta
 *      proof, extended to the gaps this audit closed.
 *   2. The new google_contacts_outbox backlog probe and website-intake
 *      silence probe against REAL rows (not stubs).
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
  process.env.WEBSITE_LEAD_WEBHOOK_SECRET = process.env.WEBSITE_LEAD_WEBHOOK_SECRET || 'int-test-website-secret';
}

let base, server, db, companyConfig, adminToken;
const RUN = 'selfheal-' + Date.now();
let insertedCompanySettingsId = null;
const outboxIds = [];
// File-wide floor rather than per-test tracking: routes/websiteLeads.js's
// POST route rejects several OTHER tests in this same file too (e.g. "gate
// passes (falls through to the real secret check)" posts with no secret at
// all), each now also recording a row via recordRejection(). A floor
// captured once before any test runs, cleaned up once after all of them,
// correctly sweeps every row this file's tests create regardless of which
// one created it.
let rejectionsFloorId = 0;
let receiptRef = null;

async function api(method, url, token, headers) {
  const res = await fetch(base + url, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers || {}) } });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

async function setModule(key, enabled) {
  const existing = (await db.query('SELECT id, enabled_modules FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  const modules = { ...(existing ? existing.enabled_modules : {}), [key]: enabled };
  if (existing) {
    await db.query('UPDATE company_settings SET enabled_modules = $1 WHERE id = $2', [JSON.stringify(modules), existing.id]);
  } else {
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, enabled_modules) VALUES ('Self-Healing Audit Co', $1) RETURNING id`,
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
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000c1', email: 'admin@test.example', role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/gmail', require(path.join(ROOT, 'routes/gmail')));
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leadEmails')));
  app.use('/api/v1/website-leads', require(path.join(ROOT, 'routes/websiteLeads')).defaultRouter());

  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  rejectionsFloorId = (await db.query(`SELECT COALESCE(MAX(id), 0)::bigint AS n FROM website_lead_intake_rejections`)).rows[0].n;
});

test.after(async () => {
  if (skip) return;
  if (outboxIds.length) await db.query('DELETE FROM google_contacts_outbox WHERE id = ANY($1::uuid[])', [outboxIds]);
  await db.query('DELETE FROM website_lead_intake_rejections WHERE id > $1', [rejectionsFloorId]);
  if (receiptRef) await db.query('DELETE FROM website_lead_receipts WHERE external_ref = $1', [receiptRef]);
  if (insertedCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedCompanySettingsId]);
  companyConfig.invalidate();
  server.close();
  await db.pool.end();
});

test('routes/gmail.js: gmail disabled -> 404 module_disabled', { skip }, async () => {
  await setModule('gmail', false);
  const r = await api('GET', '/api/v1/gmail/profile', adminToken);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'module_disabled');
  assert.strictEqual(r.body.module, 'gmail');
});

test('routes/gmail.js: gmail enabled -> gate passes (reaches the real handler, a different failure)', { skip }, async () => {
  await setModule('gmail', true);
  const r = await api('GET', '/api/v1/gmail/profile', adminToken);
  assert.notStrictEqual(r.body?.error, 'module_disabled');
});

test('routes/leadEmails.js: gmail disabled -> 404 module_disabled', { skip }, async () => {
  await setModule('gmail', false);
  const r = await api('GET', '/api/v1/leads/00000000-0000-0000-0000-000000000001/emails', adminToken);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'module_disabled');
  assert.strictEqual(r.body.module, 'gmail');
});

test('routes/websiteLeads.js: GET status is reachable regardless of website_intake module state', { skip }, async () => {
  await setModule('website_intake', false);
  const r = await api('GET', '/api/v1/website-leads', null);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.service, 'website-leads');
});

test('routes/websiteLeads.js: website_intake disabled -> POST 404 module_disabled (never reaches the secret check)', { skip }, async () => {
  await setModule('website_intake', false);
  const r = await api('POST', '/api/v1/website-leads', null, { 'content-type': 'application/json' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'module_disabled');
  assert.strictEqual(r.body.module, 'website_intake');
});

test('routes/websiteLeads.js: website_intake enabled -> gate passes (falls through to the real secret check)', { skip }, async () => {
  await setModule('website_intake', true);
  const r = await api('POST', '/api/v1/website-leads', null, { 'content-type': 'application/json' });
  assert.notStrictEqual(r.body?.error, 'module_disabled');
});

test('lib/monitoring/healthProbes.js#checkGoogleContactsOutboxHealth: a real dead-lettered row is detected', { skip }, async () => {
  const { checkGoogleContactsOutboxHealth } = require(path.join(ROOT, 'lib/monitoring/healthProbes'));
  const ins = await db.query(
    `INSERT INTO google_contacts_outbox (lead_id, status, attempts, max_attempts, last_error) VALUES (gen_random_uuid(), 'dead', 5, 5, $1) RETURNING id`,
    [RUN + '-dead']
  );
  outboxIds.push(ins.rows[0].id);
  const result = await checkGoogleContactsOutboxHealth({ id: 'google-contacts-outbox', maxBacklogAge: 1800000 });
  assert.strictEqual(result.healthy, false);
  assert.ok(result.details.deadCount >= 1);
});

test('lib/monitoring/healthProbes.js#checkWebsiteIntakeSilence: runs against the real table and returns a coherent shape', { skip }, async () => {
  // This is a global, unscoped aggregate query by design (it answers "has
  // ANYTHING been received recently system-wide," matching the real
  // production question) — qbproxy_test is a shared, non-reset database
  // with real leftover website_lead_receipts rows from other test files, so
  // asserting a SPECIFIC healthy/unhealthy outcome here would be
  // order-dependent and flaky. The staleness-detection LOGIC itself is
  // already proven deterministically in test/monitoringHealthProbes.test.js
  // with a controlled query stub; this test only proves the real SQL is
  // valid against the real schema and the function never throws.
  await setModule('website_intake', true);
  receiptRef = RUN + '-receipt';
  await db.query(`INSERT INTO website_lead_receipts (external_ref, is_test) VALUES ($1, FALSE)`, [receiptRef]);
  const { checkWebsiteIntakeSilence } = require(path.join(ROOT, 'lib/monitoring/healthProbes'));
  const result = await checkWebsiteIntakeSilence({ id: 'website-intake', maxSilenceMs: 24 * 60 * 60 * 1000 });
  assert.strictEqual(typeof result.healthy, 'boolean');
  assert.ok(result.details.total >= 1, 'counts at least the row this test just inserted');
});

test('website lead intake: a real rejected delivery (wrong secret) is recorded and surfaced via delivery_failures', { skip }, async () => {
  // CRM PRODUCTION reliability audit (website lead intake investigation):
  // the real root-cause gap this closes — a rejected attempt (rotated/
  // mismatched secret) previously left NO trace anywhere, making it
  // indistinguishable from "the website never attempted a delivery."
  await setModule('website_intake', true);
  const maxIdBefore = (await db.query(`SELECT COALESCE(MAX(id), 0)::bigint AS n FROM website_lead_intake_rejections`)).rows[0].n;
  const r = await api('POST', '/api/v1/website-leads', null, { 'x-webhook-secret': 'definitely-the-wrong-secret' });
  assert.strictEqual(r.status, 401);
  // recordRejection() is fire-and-forget — give its INSERT a tick to land.
  await new Promise((resolve) => setImmediate(resolve));
  const newRows = await db.query(`SELECT id, reason FROM website_lead_intake_rejections WHERE id > $1`, [maxIdBefore]);
  assert.strictEqual(newRows.rows.length, 1, 'exactly one rejection row recorded for the one rejected request');
  assert.strictEqual(newRows.rows[0].reason, 'unauthorized');

  const { checkWebsiteIntake } = require(path.join(ROOT, 'lib/systemHealthChecks'));
  const health = await checkWebsiteIntake({ verify: false });
  assert.ok(health.delivery_failures.total >= 1);
});
