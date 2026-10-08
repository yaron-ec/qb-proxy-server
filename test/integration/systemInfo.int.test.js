/* eslint-disable no-undef */
'use strict';

/**
 * systemInfo.int.test.js — REAL-Postgres proof for the rewritten
 * GET /api/v1/system/info (CRM STABILITY PHASE, System Health
 * UI-consistency + real-integration-audit pass). Proves:
 *   - admin-only auth is enforced (401 no token, 403 non-admin, 200 admin);
 *   - installation/schema/version info is preserved unchanged;
 *   - the default (no ?verify=1) response is fast/local: every integration's
 *     live_check is null, and the top-level `verified` flag is false;
 *   - ?verify=1 flips `verified` to true and actually runs the checks —
 *     proven end-to-end via the two inbound-webhook-only integrations
 *     (Meta, Website Lead Intake), whose "live check" is a genuine read-only
 *     DB recency query against real rows this test inserts;
 *   - the ?verify=1 path is rate-limited, the plain path is not.
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
  // Gives checkMeta/checkWebsiteIntake real credential_present:true evidence
  // without needing any actual third-party credential — both integrations
  // are inbound-webhook-only, so their "connectivity" evidence is DB recency.
  process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'int-test-meta-secret';
  process.env.WEBSITE_LEAD_WEBHOOK_SECRET = process.env.WEBSITE_LEAD_WEBHOOK_SECRET || 'int-test-website-secret';
}

let base, server, db, companyConfig, adminToken, repToken;
const RUN = 'sysinfo-' + Date.now();
let ownerId = null;
let leadId = null;
let insertedCompanySettingsId = null;

async function api(method, url, token) {
  const res = await fetch(base + url, {
    method,
    headers: token ? { authorization: 'Bearer ' + token } : {},
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  companyConfig = require(path.join(ROOT, 'lib/companyConfig'));
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000b1', email: 'admin@test.example', role: 'admin' });
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000b2', email: 'rep@test.example', role: 'sales_rep' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/system', require(path.join(ROOT, 'routes/systemInfo')));

  const owner = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'SysInfo Test Owner') ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [`${RUN}-owner@test.example`]
  );
  ownerId = owner.rows[0].id;
  const lead = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, source) VALUES ($1, 'Lead', $2, 'New', 'Instagram / Facebook') RETURNING id`,
    [RUN, ownerId]
  );
  leadId = lead.rows[0].id;
  await db.query(
    `INSERT INTO website_lead_receipts (external_ref, is_test) VALUES ($1, FALSE)`,
    [RUN + '-receipt']
  );

  // Enable meta's module flag so its state isn't short-circuited to DISABLED
  // (meta's flag IS really enforced — see MODULE_FLAG_ENFORCED) — this test
  // cares about the real credential/recency evidence underneath that flag.
  const existing = (await db.query('SELECT id, enabled_modules FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  const modules = { ...(existing ? existing.enabled_modules : {}), meta: true, website_intake: true };
  if (existing) {
    await db.query('UPDATE company_settings SET enabled_modules = $1 WHERE id = $2', [JSON.stringify(modules), existing.id]);
  } else {
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, enabled_modules) VALUES ('SysInfo Test Co', $1) RETURNING id`,
      [JSON.stringify(modules)]
    );
    insertedCompanySettingsId = ins.rows[0].id;
  }
  companyConfig.invalidate();

  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  if (insertedCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedCompanySettingsId]);
  companyConfig.invalidate();
  await db.query('DELETE FROM website_lead_receipts WHERE external_ref = $1', [RUN + '-receipt']);
  await db.query('DELETE FROM leads WHERE id = $1', [leadId]);
  await db.query('DELETE FROM owners WHERE id = $1', [ownerId]);
  server.close();
  await db.pool.end();
});

test('GET /api/v1/system/info: no bearer token -> 401', { skip }, async () => {
  const r = await api('GET', '/api/v1/system/info', null);
  assert.strictEqual(r.status, 401);
});

test('GET /api/v1/system/info: non-admin token -> 403', { skip }, async () => {
  const r = await api('GET', '/api/v1/system/info', repToken);
  assert.strictEqual(r.status, 403);
});

test('GET /api/v1/system/info: admin token -> 200, preserves installation/schema/version info', { skip }, async () => {
  const r = await api('GET', '/api/v1/system/info', adminToken);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.product_version, 'product_version present');
  assert.ok('build_commit' in r.body, 'build_commit key present (may be null outside a git checkout)');
  assert.ok(r.body.installation, 'installation identity present');
  assert.ok(typeof r.body.schema?.migrations_applied === 'number', 'schema.migrations_applied present');
  assert.ok(r.body.integrations && typeof r.body.integrations === 'object', 'integrations object present');
});

test('GET /api/v1/system/info (default, no verify): fast path never runs a live check', { skip }, async () => {
  const r = await api('GET', '/api/v1/system/info', adminToken);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.verified, false);
  for (const [key, val] of Object.entries(r.body.integrations)) {
    assert.strictEqual(val.live_check, null, `${key} must not have a live_check without ?verify=1`);
  }
});

test('GET /api/v1/system/info?verify=1: verified=true and genuinely queries DB recency for Meta/Website Intake', { skip }, async () => {
  const r = await api('GET', '/api/v1/system/info?verify=1', adminToken);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.verified, true);

  const meta = r.body.integrations.meta;
  assert.strictEqual(meta.state, 'CONFIGURED', 'webhook secret present, no outbound live check possible -> CONFIGURED, never a fabricated CONNECTED');
  assert.strictEqual(meta.supports_live_check, false, 'Meta has no outbound API token to call — DB recency only');
  assert.strictEqual(meta.live_check, null);
  assert.ok(meta.recency, 'meta.recency present');
  assert.ok(meta.recency.total_leads_received >= 1, 'the Instagram/Facebook lead inserted by this test is counted');

  const site = r.body.integrations.website_intake;
  assert.strictEqual(site.supports_live_check, false);
  assert.ok(site.recency, 'website_intake.recency present');
  assert.ok(site.recency.total_leads_received >= 1, 'the website_lead_receipts row inserted by this test is counted');
});

test('GET /api/v1/system/info never includes a secret value', { skip }, async () => {
  const r = await api('GET', '/api/v1/system/info?verify=1', adminToken);
  const text = JSON.stringify(r.body);
  assert.doesNotMatch(text, /encrypted_payload|refresh_token|client_secret|access_token/i);
});

test('?verify=1 is rate-limited (10/min); the plain path is not subject to the same limiter', { skip }, async () => {
  let saw429 = false;
  for (let i = 0; i < 15; i++) {
    const r = await api('GET', '/api/v1/system/info?verify=1', adminToken);
    if (r.status === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, 'expected a 429 within 15 rapid ?verify=1 requests from the same IP');

  // The plain (non-verify) path must still succeed even while the verify
  // limiter for this IP is exhausted — they are two independent gates.
  const plain = await api('GET', '/api/v1/system/info', adminToken);
  assert.strictEqual(plain.status, 200);
});
