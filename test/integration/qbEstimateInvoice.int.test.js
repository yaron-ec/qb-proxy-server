/* eslint-disable no-undef */
'use strict';

/**
 * qbEstimateInvoice.int.test.js — REAL-Postgres proof of real QuickBooks
 * Estimate/Invoice CREATION from a Deal (CRM STABILITY PHASE, completion
 * pass, Section B). The QuickBooks API itself is faked via
 * lib/qbTokenManager's injectable deps (same technique as
 * test/integration/qbTokenLifecycle.int.test.js) — never a real Intuit
 * call — but the Postgres credential store, advisory lock,
 * qb_invoice_sale_map, qb_invoices_cache and deals table are all real.
 *
 * Proves:
 *   1. No default Item configured -> 422 BEFORE any QB call is made (never
 *      an invented ItemRef, never a malformed transaction).
 *   2. Configuring the item (via the admin GET/PUT /api/v1/qb/invoice-config
 *      + GET /api/v1/qb/items read-only discovery) then creating an Estimate
 *      -> correct CustomerRef, correct Line/ItemRef/Amount, external id
 *      (deals.qb_estimate_id) persisted.
 *   3. Re-calling create-estimate for the SAME deal is idempotent — returns
 *      the existing estimate, makes ZERO additional QB calls.
 *   4. Creating an Invoice for a Deal persists into qb_invoice_sale_map
 *      (crm_sale_id = the Deal, never reassignable) AND qb_invoices_cache,
 *      so GET /api/v1/deals/:id/financials immediately reflects it.
 *   5. Re-calling create-invoice for the SAME deal is idempotent — zero
 *      additional QB calls, and a DIFFERENT deal for the SAME QB customer
 *      gets its OWN invoice (multi-project attribution never conflated).
 *   6. Concurrent double-click (two simultaneous requests) on the same deal
 *      never creates two QB invoices — the advisory lock serializes them.
 *
 * Skipped without TEST_DATABASE_URL.
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
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

let base, server, db, tokenStore, qbTokenManager, companyConfig, adminToken, leadId, qbCustomerId, dealAId, dealBId;
let qbCalls, insertedCompanySettingsId;

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

async function setQuickbooksEnabled() {
  const existing = (await db.query('SELECT id, enabled_modules FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  const modules = { ...(existing ? existing.enabled_modules : {}), quickbooks: true };
  if (existing) {
    await db.query('UPDATE company_settings SET enabled_modules = $1 WHERE id = $2', [JSON.stringify(modules), existing.id]);
  } else {
    const ins = await db.query(`INSERT INTO company_settings (company_name, enabled_modules) VALUES ('QB Invoicing Test Co', $1) RETURNING id`, [JSON.stringify(modules)]);
    insertedCompanySettingsId = ins.rows[0].id;
  }
  companyConfig.invalidate();
}

// Fake QuickBooks API — never a real Intuit call. Handles the exact
// endpoints lib/qbEstimateInvoice.js uses: customer GET/search/create,
// Item query, Estimate create, Invoice create.
// Stamped per run — this shared qbproxy_test database persists across
// repeated test runs and this test never deletes the leads/deals it
// inserts, so a fixed starting id would collide with a PREVIOUS run's
// deals.qb_estimate_id (which has a real UNIQUE index) on a re-run.
const RUN_STAMP = Date.now();
let nextEstimateId = RUN_STAMP;
let nextInvoiceId = RUN_STAMP + 1;
function fakeQbApi() {
  return async (url, init) => {
    qbCalls.push({ url: String(url), method: init?.method || 'GET' });
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj });

    if (u.includes(`/customer/${qbCustomerId}`)) {
      return json({ Customer: { Id: qbCustomerId, DisplayName: 'Mapped Customer' } });
    }
    if (u.includes('/query?query=') && decodeURIComponent(u).includes('FROM Item')) {
      return json({ QueryResponse: { Item: [{ Id: '55', Name: 'Construction Services', Type: 'Service', IncomeAccountRef: { value: '77', name: 'Construction Income' } }] } });
    }
    if (u.includes('/query?query=') && decodeURIComponent(u).includes('FROM Customer')) {
      return json({ QueryResponse: { Customer: [] } }); // force create path when no qb_customer_id stored
    }
    if (u.endsWith('/customer?minorversion=65') && init.method === 'POST') {
      return json({ Customer: { Id: qbCustomerId, DisplayName: body.DisplayName } });
    }
    if (u.endsWith('/estimate?minorversion=65') && init.method === 'POST') {
      const id = String(++nextEstimateId);
      return json({ Estimate: { Id: id, DocNumber: `EST-${id}`, CustomerRef: body.CustomerRef, Line: body.Line } });
    }
    if (u.endsWith('/invoice?minorversion=65') && init.method === 'POST') {
      const id = String(++nextInvoiceId);
      const total = (body.Line || []).reduce((s, l) => s + (Number(l.Amount) || 0), 0);
      return json({ Invoice: { Id: id, DocNumber: `INV-${id}`, CustomerRef: body.CustomerRef, Line: body.Line, TotalAmt: total, Balance: total } });
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

test.before(async () => {
  if (skip) return;
  qbCalls = [];
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));
  tokenStore = require(path.join(ROOT, 'lib/qbTokenStore'));
  qbTokenManager = require(path.join(ROOT, 'lib/qbTokenManager'));
  companyConfig = require(path.join(ROOT, 'lib/companyConfig'));

  await setQuickbooksEnabled();

  // qb_invoice_item_config is a genuine installation-wide singleton (real
  // usage: exactly one QB account per installation) — but this shared
  // qbproxy_test database persists across repeated test runs, so a
  // leftover row from an earlier run would make test 1's "not configured"
  // proof false. Reset it so this file's ordering is deterministic.
  await db.query(`DELETE FROM app_settings WHERE key = 'qb_invoice_item_config'`);

  qbTokenManager._setDeps({
    clientId: () => 'test-client', clientSecret: () => 'test-secret',
    sleep: async () => {}, notifyReconnectRequired: async () => {},
    fetch: fakeQbApi(),
  });
  await tokenStore.savePersistedTokens('production', {
    realm_id: 'test-realm', access_token: 'at-1', refresh_token: 'rt-1',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
  });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/deals', require(path.join(ROOT, 'routes/dealQbSync')));
  app.use('/api/v1/qb', require(path.join(ROOT, 'routes/qbInvoicing')));
  app.use('/api/v1/deals', require(path.join(ROOT, 'routes/dealFinancials')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ff01', email: `admin-qbinvoice-${stamp}@test.example`, role: 'admin' });
  qbCustomerId = `qbcust-${stamp}`;

  const { rows: ownerRows } = await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'QB Invoicing Test Owner') RETURNING id`, [`owner-qbinvoice-${stamp}@test.example`]);
  const { rows: leadRows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, qb_customer_id, owner_id)
     VALUES ('QB', 'Customer', $1, '5553334444', 'Referral', 'Sold', $2, $3) RETURNING id`,
    [`qbinvoice-${stamp}@test.example`, qbCustomerId, ownerRows[0].id]
  );
  leadId = leadRows[0].id;

  const { rows: dealARows } = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Deal A', 12000, 'Sold / Estimate Approved') RETURNING id`, [leadId]
  );
  dealAId = dealARows[0].id;
  const { rows: dealBRows } = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Deal B', 4000, 'Sold / Estimate Approved') RETURNING id`, [leadId]
  );
  dealBId = dealBRows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.query(`DELETE FROM integration_credentials WHERE provider = 'intuit' AND environment = 'production'`);
  await db.query(`DELETE FROM app_settings WHERE key = 'qb_invoice_item_config'`);
  if (insertedCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedCompanySettingsId]);
  await db.pool.end();
});

test('1. no default Item configured -> 422 before any QB write call is made', { skip }, async () => {
  const before = qbCalls.length;
  const r = await api('POST', `/api/v1/deals/${dealAId}/qb-estimate`, undefined, adminToken);
  assert.strictEqual(r.status, 422, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'qb_item_not_configured');
  assert.strictEqual(qbCalls.length, before, 'no QuickBooks call of any kind may happen before the item is configured');
});

test('2. GET /api/v1/qb/items lists the real (faked) account items read-only; PUT /invoice-config saves the choice', { skip }, async () => {
  const items = await api('GET', '/api/v1/qb/items', undefined, adminToken);
  assert.strictEqual(items.status, 200, JSON.stringify(items.body));
  assert.ok(items.body.items.some((i) => i.id === '55' && i.name === 'Construction Services'));

  const put = await api('PUT', '/api/v1/qb/invoice-config', { item_ref: '55', item_name: 'Construction Services' }, adminToken);
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  const get = await api('GET', '/api/v1/qb/invoice-config', undefined, adminToken);
  assert.strictEqual(get.body.config.item_ref, '55');
});

test('3. creating a QB Estimate for Deal A: correct CustomerRef/Line/Amount, external id persisted', { skip }, async () => {
  const r = await api('POST', `/api/v1/deals/${dealAId}/qb-estimate`, undefined, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.created);
  assert.ok(r.body.qb_estimate_id);
  assert.strictEqual(r.body.raw.CustomerRef.value, qbCustomerId);
  assert.strictEqual(Number(r.body.raw.Line[0].Amount), 12000);
  assert.strictEqual(r.body.raw.Line[0].SalesItemLineDetail.ItemRef.value, '55');

  const { rows } = await db.query('SELECT qb_estimate_id, qb_estimate_number FROM deals WHERE id = $1', [dealAId]);
  assert.strictEqual(rows[0].qb_estimate_id, r.body.qb_estimate_id);
});

test('4. re-calling create-estimate for the SAME deal is idempotent — zero additional QB calls', { skip }, async () => {
  const before = qbCalls.length;
  const r = await api('POST', `/api/v1/deals/${dealAId}/qb-estimate`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.created, false);
  assert.strictEqual(qbCalls.length, before, 'an already-estimated deal must never trigger a second QuickBooks Estimate call');
});

test('5. creating a QB Invoice for Deal A persists into qb_invoice_sale_map + qb_invoices_cache, visible on /financials', { skip }, async () => {
  const r = await api('POST', `/api/v1/deals/${dealAId}/qb-invoice`, undefined, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.qb_invoice_id);

  const map = await db.query('SELECT * FROM qb_invoice_sale_map WHERE crm_sale_id = $1', [dealAId]);
  assert.strictEqual(map.rows.length, 1);
  assert.strictEqual(map.rows[0].qb_invoice_id, r.body.qb_invoice_id);
  assert.strictEqual(map.rows[0].qb_customer_id, qbCustomerId);

  const fin = await api('GET', `/api/v1/deals/${dealAId}/financials?sale_total=12000`, undefined, adminToken);
  assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));
  assert.strictEqual(fin.body.invoiced, 12000);
});

test('6. re-calling create-invoice for the SAME deal is idempotent; a DIFFERENT deal gets its OWN invoice', { skip }, async () => {
  const before = qbCalls.length;
  const again = await api('POST', `/api/v1/deals/${dealAId}/qb-invoice`, undefined, adminToken);
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.strictEqual(again.body.created, false);
  assert.strictEqual(qbCalls.length, before, 'an already-invoiced deal must never trigger a second QuickBooks Invoice call');

  const dealB = await api('POST', `/api/v1/deals/${dealBId}/qb-invoice`, undefined, adminToken);
  assert.strictEqual(dealB.status, 201, JSON.stringify(dealB.body));
  assert.notStrictEqual(dealB.body.qb_invoice_id, again.body?.qb_invoice_id);

  const mapB = await db.query('SELECT crm_sale_id FROM qb_invoice_sale_map WHERE qb_invoice_id = $1', [dealB.body.qb_invoice_id]);
  assert.strictEqual(mapB.rows[0].crm_sale_id, dealBId, 'Deal B\'s own invoice must map to Deal B, never Deal A, despite sharing the same QB customer');
});

test('7. a concurrent double-click on the same (new) deal never creates two QB invoices', { skip }, async () => {
  const { rows: dealCRows } = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Deal C (race test)', 7000, 'Sold / Estimate Approved') RETURNING id`, [leadId]
  );
  const dealCId = dealCRows[0].id;

  const [r1, r2] = await Promise.all([
    api('POST', `/api/v1/deals/${dealCId}/qb-invoice`, undefined, adminToken),
    api('POST', `/api/v1/deals/${dealCId}/qb-invoice`, undefined, adminToken),
  ]);
  const ids = [r1, r2].map((r) => r.body?.qb_invoice_id).filter(Boolean);
  assert.strictEqual(new Set(ids).size, 1, 'both concurrent requests must resolve to the SAME single invoice, never two');

  const map = await db.query('SELECT * FROM qb_invoice_sale_map WHERE crm_sale_id = $1', [dealCId]);
  assert.strictEqual(map.rows.length, 1, 'exactly one invoice mapping must exist for this deal after a concurrent double-click');
});
