/* eslint-disable no-undef */
'use strict';

/**
 * dealFinancialsMultiProjectWaterfall.int.test.js — REAL-Postgres composite
 * proof of Section K flow 5 ("QuickBooks Payment → deterministic Deal
 * attribution → partial/full payment → CRM totals") and the multi-project
 * attribution requirement audited in Section B: one QB customer with TWO
 * CRM Deals must never have money paid toward Deal A silently counted as
 * Deal B's progress.
 *
 * GET /api/v1/deals/:id/financials (routes/dealFinancials.js) layers two
 * independent, deterministic mechanisms, neither of which guesses:
 *   1. qb_invoice_sale_map — explicit per-invoice crm_sale_id ownership
 *      (lib/qbInvoiceSaleMap.js), used when the sale-scoped summary has a
 *      real mapped invoice.
 *   2. lib/customerPaymentWaterfall.js — when no mapped invoice exists for
 *      a Deal (ownership is genuinely ambiguous at the invoice level), QB
 *      money actually received for the customer is allocated sequentially
 *      across that customer's eligible Deals in chronological
 *      (sold_date/created_at) order, each Deal capped at its own contract
 *      amount — a principled, auditable rule, never a guess, and it
 *      overrides the summary's paid/balance when applied.
 *
 * This test proves the end-to-end chain against real Postgres: two Deals
 * for the same qb_customer_id, a cached QB invoice showing partial payment
 * received, and confirms the OLDER deal is funded first and the newer
 * deal shows zero progress until the older one is fully paid — then fully
 * paid on the older deal, confirms the next payment flows to the newer
 * deal, and confirms Deal A's own invoiced total (via qb_invoice_sale_map)
 * is never attributed to Deal B.
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
}

let base, server, db, adminToken, leadId, qbCustomerId, dealOldId, dealNewId;

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

test.before(async () => {
  if (skip) return;
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/deals', require(path.join(ROOT, 'routes/dealFinancials')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ee01', email: `admin-waterfall-${stamp}@test.example`, role: 'admin' });
  qbCustomerId = `qbcust-${stamp}`;

  const { rows: ownerRows } = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Waterfall Test Owner') RETURNING id`,
    [`owner-waterfall-${stamp}@test.example`]
  );
  const { rows: leadRows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, qb_customer_id, owner_id)
     VALUES ('Waterfall', 'Customer', $1, '5551239876', 'Referral', 'Sold', $2, $3) RETURNING id`,
    [`waterfall-${stamp}@test.example`, qbCustomerId, ownerRows[0].id]
  );
  leadId = leadRows[0].id;

  // Deal A: the OLDER deal (sold first) — $10,000 contract.
  const { rows: oldRows } = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage, sold_date, created_at)
     VALUES ($1, 'Older Project', 10000, 'Sold / Estimate Approved', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')
     RETURNING id`,
    [leadId]
  );
  dealOldId = oldRows[0].id;

  // Deal B: the NEWER deal (sold later) — $5,000 contract. Same customer.
  const { rows: newRows } = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage, sold_date, created_at)
     VALUES ($1, 'Newer Project', 5000, 'Sold / Estimate Approved', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')
     RETURNING id`,
    [leadId]
  );
  dealNewId = newRows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

async function setCachedInvoicePaid(qbInvoiceIdSuffix, totalAmt, paid) {
  // qb_invoice_id is globally unique (PK), stamp it per test run — this
  // shared qbproxy_test database persists across runs, and a bare literal
  // would silently keep a PREVIOUS run's qb_customer_id on ON CONFLICT
  // (only amounts were updated), making this test read a stale customer.
  const qbInvoiceId = `${qbInvoiceIdSuffix}-${qbCustomerId}`;
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_customer_id, total_amt, balance, paid, voided, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, false, NOW())
     ON CONFLICT (qb_invoice_id) DO UPDATE SET qb_customer_id = $2, total_amt = $3, balance = $4, paid = $5, last_synced_at = NOW()`,
    [qbInvoiceId, qbCustomerId, totalAmt, totalAmt - paid, paid]
  );
}

test('1. a partial payment ($4,000) is fully allocated to the OLDER deal; the newer deal shows zero progress', { skip }, async () => {
  await setCachedInvoicePaid('wf-inv-1', 10000, 4000);

  const oldFin = await api('GET', `/api/v1/deals/${dealOldId}/financials?sale_total=10000`, undefined, adminToken);
  assert.strictEqual(oldFin.status, 200, JSON.stringify(oldFin.body));
  assert.ok(oldFin.body.waterfall.applied);
  assert.strictEqual(oldFin.body.waterfall.this_deal_allocation.allocated_paid, 4000);
  assert.strictEqual(oldFin.body.paid, 4000);

  const newFin = await api('GET', `/api/v1/deals/${dealNewId}/financials?sale_total=5000`, undefined, adminToken);
  assert.strictEqual(newFin.status, 200, JSON.stringify(newFin.body));
  assert.strictEqual(newFin.body.waterfall.this_deal_allocation.allocated_paid, 0, 'the newer deal must show ZERO progress until the older deal is fully funded — money must never bleed into the wrong project');
});

test('2. fully paying the older deal ($10,000) then flows the EXCESS to the newer deal, never exceeding either contract amount', { skip }, async () => {
  // Customer has now paid $13,000 total: $10,000 fully covers the older
  // deal, the remaining $3,000 flows to the newer ($5,000) deal.
  await setCachedInvoicePaid('wf-inv-1', 10000, 10000);
  await setCachedInvoicePaid('wf-inv-2', 3000, 3000);

  const oldFin = await api('GET', `/api/v1/deals/${dealOldId}/financials?sale_total=10000`, undefined, adminToken);
  assert.strictEqual(oldFin.body.waterfall.this_deal_allocation.allocated_paid, 10000);
  assert.strictEqual(oldFin.body.waterfall.this_deal_allocation.allocated_remaining, 0);
  assert.strictEqual(oldFin.body.payment_status, 'paid');

  const newFin = await api('GET', `/api/v1/deals/${dealNewId}/financials?sale_total=5000`, undefined, adminToken);
  assert.strictEqual(newFin.body.waterfall.this_deal_allocation.allocated_paid, 3000);
  assert.strictEqual(newFin.body.waterfall.this_deal_allocation.allocated_remaining, 2000);
  assert.strictEqual(newFin.body.payment_status, 'partial');

  // Neither deal's allocation can ever exceed its own contract amount —
  // the money is capped and ordered, never duplicated or lost.
  assert.ok(oldFin.body.waterfall.this_deal_allocation.allocated_paid <= 10000);
  assert.ok(newFin.body.waterfall.this_deal_allocation.allocated_paid <= 5000);
});

test('3. explicit per-invoice ownership (qb_invoice_sale_map) is never reassigned between the two deals', { skip }, async () => {
  // qb_invoice_id is this table's PK too — stamp it per run (see setCachedInvoicePaid's comment above).
  const mapInvoiceId = `wf-map-inv-${qbCustomerId}`;
  const { upsertMapping } = require(path.join(ROOT, 'lib/qbInvoiceSaleMap'));
  await upsertMapping({ query: db.query }, {
    qb_invoice_id: mapInvoiceId, qb_doc_number: 'DOC-1', crm_sale_id: dealOldId,
    crm_lead_id: leadId, qb_customer_id: qbCustomerId, mapping_method: 'crm_created',
  });
  // Attempt to reassign the SAME invoice to the other deal — must be a no-op.
  await upsertMapping({ query: db.query }, {
    qb_invoice_id: mapInvoiceId, qb_doc_number: 'DOC-1', crm_sale_id: dealNewId,
    crm_lead_id: leadId, qb_customer_id: qbCustomerId, mapping_method: 'crm_created',
  });
  const { rows } = await db.query('SELECT crm_sale_id FROM qb_invoice_sale_map WHERE qb_invoice_id = $1', [mapInvoiceId]);
  assert.strictEqual(rows[0].crm_sale_id, dealOldId, 'an invoice mapping must NEVER be reassigned to a different deal once set');
});
