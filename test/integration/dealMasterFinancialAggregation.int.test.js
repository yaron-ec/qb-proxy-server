/* eslint-disable no-undef */
'use strict';

/**
 * dealMasterFinancialAggregation.int.test.js — REAL-Postgres proof of the
 * "Master Project" consolidated financial view (November 2026 production
 * correction): GET /api/v1/deals/:id/addendums now returns a `master`
 * block (lib/dealFinancialAggregation.js#computeMasterFinancials) summing
 * Invoiced/Collected/Outstanding/Total Costs/Projected Profit/Profit
 * Margin across a parent deal and all of its approved addendums, with no
 * double-counting, reusing the SAME direct-invoice-vs-waterfall precedence
 * rule (routes/dealFinancials.js#getSaleFinancialSummary) and the SAME
 * canonical crm-frontend/src/lib/financialCalc.js#computeFinancials engine
 * the single-deal Financials tab already uses.
 *
 * Covers the exact Ali & Mohemmed Lalani shape (scenario 1), proves the
 * SAME master totals are returned whether the route is called on the
 * parent's or the addendum's own id (scenario 2), proves the invoiced-vs-
 * contract discrepancy signal (scenario 3), and proves the whole mechanism
 * generalizes to a DIFFERENT customer shape with TWO addendums, never
 * hardcoded to Lalani's own numbers (scenario 4).
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

let base, server, db, adminToken, round2;

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
  round2 = require(path.join(ROOT, 'lib/qbInvoiceSaleMap')).round2;

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/deals', require(path.join(ROOT, 'routes/deals')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ee02', email: `admin-master-fin-${Date.now()}@test.example`, role: 'admin' });
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

async function seedCustomer(label) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const qbCustomerId = `qbcust-master-${stamp}`;
  const { rows: ownerRows } = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Master Fin Owner') RETURNING id`,
    [`owner-master-${stamp}@test.example`]
  );
  const { rows: leadRows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, qb_customer_id, owner_id)
     VALUES ($1, $2, $3, '5558889999', 'Referral', 'Sold', $4, $5) RETURNING id`,
    [label, 'Customer', `master-${stamp}@test.example`, qbCustomerId, ownerRows[0].id]
  );
  return { leadId: leadRows[0].id, qbCustomerId, stamp };
}

async function insertDeal({ leadId, name, amount, parentDealId = null, daysAgo }) {
  const { rows } = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage, sold_date, created_at, parent_deal_id)
     VALUES ($1, $2, $3, 'Sold / Estimate Approved', NOW() - ($4 || ' days')::interval, NOW() - ($4 || ' days')::interval, $5)
     RETURNING id`,
    [leadId, name, amount, String(daysAgo), parentDealId]
  );
  return rows[0].id;
}

async function mapDirectInvoice({ qbCustomerId, dealId, leadId, stamp, suffix, totalAmt, paid }) {
  const { upsertMapping } = require(path.join(ROOT, 'lib/qbInvoiceSaleMap'));
  const qbInvoiceId = `master-inv-${suffix}-${stamp}`;
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_customer_id, total_amt, balance, paid, voided, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, false, NOW())`,
    [qbInvoiceId, qbCustomerId, totalAmt, round2(totalAmt - paid), paid]
  );
  await upsertMapping({ query: db.query }, {
    qb_invoice_id: qbInvoiceId, qb_doc_number: `DOC-${suffix}`, crm_sale_id: dealId,
    crm_lead_id: leadId, qb_customer_id: qbCustomerId, mapping_method: 'crm_created',
  });
}

async function insertExpense(dealId, { amount, amountPaid }) {
  await db.query(
    `INSERT INTO deal_expenses (deal_id, vendor_name, category, amount, amount_paid, payment_status)
     VALUES ($1, 'Test Vendor', 'Subcontractor', $2, $3, 'Paid')`,
    [dealId, amount, amountPaid]
  );
}

async function insertFixedCommission(dealId, { amount }) {
  await db.query(
    `INSERT INTO deal_commissions (deal_id, recipient_name, commission_type, commission_fixed_amount, status)
     VALUES ($1, 'Test Rep', 'fixed', $2, 'Estimated')`,
    [dealId, amount]
  );
}

test('1. the exact Ali & Mohemmed Lalani shape: $33,000 + $7,934.35 addendum = $40,934.35, consolidated invoiced/collected/costs/profit, no double-counting', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('Ali');
  const parentId = await insertDeal({ leadId, name: 'Roof Replacement', amount: 33000, daysAgo: 30 });
  const addendumId = await insertDeal({ leadId, name: 'Bathroom Repair', amount: 7934.35, parentDealId: parentId, daysAgo: 5 });

  // Direct, per-deal invoice attribution — fully invoiced, partially paid,
  // on BOTH deals (never the waterfall's own estimate, per the root-cause
  // fix this view builds on).
  await mapDirectInvoice({ qbCustomerId, dealId: parentId, leadId, stamp, suffix: 'parent', totalAmt: 33000, paid: 20000 });
  await mapDirectInvoice({ qbCustomerId, dealId: addendumId, leadId, stamp, suffix: 'addendum', totalAmt: 7934.35, paid: 5000 });

  await insertExpense(parentId, { amount: 2000, amountPaid: 2000 });
  await insertFixedCommission(addendumId, { amount: 500 });

  const res = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const m = res.body.master;
  assert.ok(m, 'master block must be present');

  assert.strictEqual(res.body.original_contract_amount, 33000);
  assert.strictEqual(res.body.approved_addendums_amount, 7934.35);
  assert.strictEqual(res.body.total_approved_contract, 40934.35);

  assert.strictEqual(m.invoiced, 40934.35, 'invoiced must sum both deals\' own direct invoice totals exactly once each');
  assert.strictEqual(m.collected, 25000, '20,000 (parent) + 5,000 (addendum), never a waterfall estimate');
  assert.strictEqual(m.outstanding, round2(40934.35 - 25000));
  assert.strictEqual(m.total_costs, 2500, '2,000 expense (parent) + 500 fixed commission (addendum), each counted exactly once');
  assert.strictEqual(m.projected_profit, round2(40934.35 - 2500));
  assert.strictEqual(m.profit_margin_pct, round2((round2(40934.35 - 2500) / 40934.35) * 100));
  assert.strictEqual(m.has_invoiced_vs_contract_discrepancy, false, 'invoiced ($40,934.35) exactly matches the combined contract here — no discrepancy to flag');

  assert.strictEqual(m.per_deal.length, 2);
  const parentRow = m.per_deal.find((d) => d.deal_id === parentId);
  const addendumRow = m.per_deal.find((d) => d.deal_id === addendumId);
  assert.strictEqual(parentRow.collected, 20000);
  assert.strictEqual(addendumRow.collected, 5000);
  assert.strictEqual(parentRow.used_waterfall_fallback, false);
  assert.strictEqual(addendumRow.used_waterfall_fallback, false);
});

test('2. viewing the ADDENDUM\'s own page returns the SAME master totals as viewing the parent', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('Rootcheck');
  const parentId = await insertDeal({ leadId, name: 'Main Contract', amount: 10000, daysAgo: 20 });
  const addendumId = await insertDeal({ leadId, name: 'Change Order', amount: 2000, parentDealId: parentId, daysAgo: 3 });
  await mapDirectInvoice({ qbCustomerId, dealId: parentId, leadId, stamp, suffix: 'p', totalAmt: 10000, paid: 10000 });
  await mapDirectInvoice({ qbCustomerId, dealId: addendumId, leadId, stamp, suffix: 'a', totalAmt: 2000, paid: 1000 });

  const fromParent = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  const fromAddendum = await api('GET', `/api/v1/deals/${addendumId}/addendums`, undefined, adminToken);

  assert.strictEqual(fromAddendum.body.is_addendum, true);
  assert.strictEqual(fromAddendum.body.root_deal_id, parentId);
  assert.deepStrictEqual(fromAddendum.body.master, fromParent.body.master, 'the consolidated Master Project totals must be identical regardless of which deal in the project the request was made against');
});

test('3. an invoiced-vs-contract gap is flagged, never force-reconciled', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('Gapcheck');
  const parentId = await insertDeal({ leadId, name: 'Main Contract', amount: 10000, daysAgo: 15 });
  const addendumId = await insertDeal({ leadId, name: 'Addendum', amount: 2000, parentDealId: parentId, daysAgo: 2 });
  // Deliberately invoice MORE than the approved contract total (e.g. a
  // sales-tax or permit-fee line item billed separately) — combined
  // contract = $12,000; invoiced = $12,500.
  await mapDirectInvoice({ qbCustomerId, dealId: parentId, leadId, stamp, suffix: 'p', totalAmt: 10500, paid: 10500 });
  await mapDirectInvoice({ qbCustomerId, dealId: addendumId, leadId, stamp, suffix: 'a', totalAmt: 2000, paid: 2000 });

  const res = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  const m = res.body.master;
  assert.strictEqual(m.invoiced, 12500);
  assert.strictEqual(res.body.total_approved_contract, 12000);
  assert.strictEqual(m.invoiced_vs_contract_discrepancy, 500);
  assert.strictEqual(m.has_invoiced_vs_contract_discrepancy, true);
  // The discrepancy is surfaced, never silently absorbed into collected/
  // outstanding/profit by adjusting the contract value to match invoiced.
  assert.strictEqual(res.body.total_approved_contract, 12000, 'the contract value itself is never force-adjusted to match what was invoiced');
});

test('4. generalizes to a different customer with TWO addendums — never hardcoded to the Lalani numbers', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('Generic');
  const parentId = await insertDeal({ leadId, name: 'Main Project', amount: 50000, daysAgo: 60 });
  const addendum1Id = await insertDeal({ leadId, name: 'Addendum One', amount: 2000, parentDealId: parentId, daysAgo: 30 });
  const addendum2Id = await insertDeal({ leadId, name: 'Addendum Two', amount: 3500, parentDealId: parentId, daysAgo: 10 });

  await mapDirectInvoice({ qbCustomerId, dealId: parentId, leadId, stamp, suffix: 'p', totalAmt: 50000, paid: 50000 });
  await mapDirectInvoice({ qbCustomerId, dealId: addendum1Id, leadId, stamp, suffix: 'a1', totalAmt: 2000, paid: 2000 });
  await mapDirectInvoice({ qbCustomerId, dealId: addendum2Id, leadId, stamp, suffix: 'a2', totalAmt: 3500, paid: 1750 });
  await insertExpense(parentId, { amount: 8000, amountPaid: 8000 });
  await insertExpense(addendum1Id, { amount: 300, amountPaid: 300 });

  const res = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  assert.strictEqual(res.body.addendums.length, 2);
  assert.strictEqual(res.body.original_contract_amount, 50000);
  assert.strictEqual(res.body.approved_addendums_amount, 5500);
  assert.strictEqual(res.body.total_approved_contract, 55500);

  const m = res.body.master;
  assert.strictEqual(m.per_deal.length, 3);
  assert.strictEqual(m.invoiced, 55500);
  assert.strictEqual(m.collected, round2(50000 + 2000 + 1750));
  assert.strictEqual(m.total_costs, round2(8000 + 300), 'costs from all three deals summed exactly once each');
  assert.strictEqual(m.has_invoiced_vs_contract_discrepancy, false);
});
