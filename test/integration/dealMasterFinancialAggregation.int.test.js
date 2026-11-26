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
  assert.strictEqual(m.projected_profit, round2(40934.35 - 2500), 'PROJECTED (contract-based, planning only)');
  assert.strictEqual(m.profit_margin_pct, round2((round2(40934.35 - 2500) / 40934.35) * 100));
  // ACTUAL PROFIT (November 2026 business rule, primary) — collected
  // revenue ($25,000, consolidated across both deals) minus total
  // recorded costs ($2,500), never the combined contract value.
  assert.strictEqual(m.actual_profit, round2(25000 - 2500), 'ACTUAL PROFIT = COLLECTED − TOTAL RECORDED COSTS');
  assert.strictEqual(m.actual_profit_margin_pct, round2((round2(25000 - 2500) / 25000) * 100));
  assert.notStrictEqual(m.actual_profit, m.projected_profit, 'actual and projected profit must be genuinely different figures here (collected < contract)');
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
  const collected = round2(50000 + 2000 + 1750);
  const totalCosts = round2(8000 + 300);
  assert.strictEqual(m.collected, collected);
  assert.strictEqual(m.total_costs, totalCosts, 'costs from all three deals summed exactly once each');
  assert.strictEqual(m.actual_profit, round2(collected - totalCosts), 'ACTUAL PROFIT generalizes correctly beyond the Lalani numbers too — collected minus costs from all three deals');
  assert.strictEqual(m.actual_profit_margin_pct, round2((round2(collected - totalCosts) / collected) * 100));
  assert.strictEqual(m.has_invoiced_vs_contract_discrepancy, false);
});

test('5. a ZERO-REVENUE addendum (no invoices mapped yet) — actual profit margin is exactly 0 for that deal, consolidated totals never NaN/Infinity', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('Zerorev');
  const parentId = await insertDeal({ leadId, name: 'Main Project', amount: 20000, daysAgo: 40 });
  const addendumId = await insertDeal({ leadId, name: 'New Addendum, Not Yet Invoiced', amount: 4000, parentDealId: parentId, daysAgo: 1 });

  // Parent is fully invoiced/collected with a real cost; the brand-new
  // addendum has ZERO invoices and ZERO recorded costs yet — a genuine
  // zero-revenue-for-this-deal case within a consolidated project.
  await mapDirectInvoice({ qbCustomerId, dealId: parentId, leadId, stamp, suffix: 'p', totalAmt: 20000, paid: 20000 });
  await insertExpense(parentId, { amount: 3000, amountPaid: 3000 });

  const res = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const m = res.body.master;

  const addendumRow = m.per_deal.find((d) => d.deal_id === addendumId);
  assert.strictEqual(addendumRow.collected, 0, 'the new addendum has not been invoiced/collected at all yet');

  // Consolidated: collected ($20,000, parent only) minus costs ($3,000,
  // parent only) — the zero-revenue addendum contributes $0 to both sides
  // and must never produce NaN/Infinity in the combined figure.
  assert.strictEqual(m.collected, 20000);
  assert.strictEqual(m.total_costs, 3000);
  assert.strictEqual(m.actual_profit, 17000);
  assert.strictEqual(m.actual_profit_margin_pct, 85);
  assert.ok(Number.isFinite(m.actual_profit_margin_pct));

  // And the fully-zero-revenue case: strip the parent's own collected
  // amount down to zero too (unpaid invoice) to exercise the whole
  // consolidated project at zero collected revenue, not just one deal.
  await db.query(`UPDATE qb_invoices_cache SET paid = 0, balance = total_amt WHERE qb_customer_id = $1`, [qbCustomerId]);
  const res2 = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  const m2 = res2.body.master;
  assert.strictEqual(m2.collected, 0, 'nothing has been collected across the whole consolidated project');
  assert.strictEqual(m2.actual_profit, round2(0 - 3000), 'ACTUAL PROFIT = 0 collected − 3000 recorded costs');
  assert.strictEqual(m2.actual_profit_margin_pct, 0, 'division-by-zero guard: must be exactly 0, never NaN or -Infinity, even with a negative actual profit');
  assert.ok(Number.isFinite(m2.actual_profit_margin_pct));
});

/**
 * Tests 6-7 — November 2026 production correction: the Ali & Mohemmed
 * Lalani "$49,965 Collected" double-counting incident. Every test above
 * (1-5) gives EVERY deal its own direct, qb_invoice_sale_map-attributed
 * invoice — the exact shape that never exercises the bug at all. The real
 * incident shape is specifically: a root deal's own direct invoice total
 * already reflects MORE than its own contract value (because the same
 * customer's whole QuickBooks invoice history lives under that one deal's
 * mapping), while a SIBLING addendum has NO invoice of its own at all and
 * therefore falls back to `lib/customerPaymentWaterfall.js`'s customer-
 * level allocation — which, before this fix, independently re-drew from
 * the SAME pool of money the root's direct figure already claimed.
 */
test('6. the exact Lalani double-counting bug: a sibling addendum with no invoice of its own must NOT re-claim money the root deal\'s own direct invoice already accounts for', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('Lalani');
  const parentId = await insertDeal({ leadId, name: 'Roof Replacement', amount: 33000, daysAgo: 30 });
  const addendumId = await insertDeal({ leadId, name: 'Bathroom Repair', amount: 7934, parentDealId: parentId, daysAgo: 5 });

  // ONLY the parent has a direct, mapped invoice — and it already totals
  // MORE than the parent's own $33,000 contract (the real incident shape:
  // $42,031, i.e. the parent's own invoices already reflect money for
  // BOTH the roof work and the bathroom addendum, plus $1,097 beyond
  // even that combined total). The addendum has ZERO invoices of its own.
  await mapDirectInvoice({ qbCustomerId, dealId: parentId, leadId, stamp, suffix: 'parent', totalAmt: 42031, paid: 42031 });

  const res = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const m = res.body.master;

  assert.strictEqual(res.body.total_approved_contract, 40934);
  assert.strictEqual(m.invoiced, 42031, 'invoiced is still the root\'s own real invoice total — unaffected by this fix');

  // THE FIX: collected must be the real $42,031 the customer's QuickBooks
  // data actually shows as received — NEVER $49,965 (42,031 root direct +
  // 7,934 addendum waterfall fallback, double-counting the same money).
  assert.strictEqual(m.collected, 42031, 'collected must equal the customer\'s real total received money exactly once — never double-counted with a sibling addendum\'s independent waterfall share');
  assert.notStrictEqual(m.collected, 49965, 'must never reproduce the exact reported $49,965 double-counting bug');

  const addendumRow = m.per_deal.find((d) => d.deal_id === addendumId);
  assert.strictEqual(addendumRow.collected, 0, 'the addendum has no invoice of its own and the customer\'s whole payment pool is already claimed by the parent — it must not independently claim a $7,934 waterfall share on top of that');
  assert.strictEqual(addendumRow.used_waterfall_fallback, true, 'the addendum genuinely has no direct invoice, so it is still correctly flagged as waterfall-fallback-eligible — only the AMOUNT it draws from that fallback is corrected');

  const parentRow = m.per_deal.find((d) => d.deal_id === parentId);
  assert.strictEqual(parentRow.collected, 42031, 'the parent\'s own direct invoice claim is completely unaffected by this fix');

  // Outstanding/actual-profit must be derived from the CORRECTED collected
  // figure, never the old double-counted one.
  assert.strictEqual(m.outstanding, 0, 'invoiced/collected already exceeds the combined contract — no balance due, not negative');
  assert.strictEqual(m.actual_profit, 42031, 'ACTUAL PROFIT = corrected COLLECTED (42,031) − TOTAL RECORDED COSTS (0 here)');
  assert.strictEqual(m.unattributed_customer_excess, 0, 'the full pool is already claimed directly by the parent — there is no leftover to report as unattributed');
});

test('7. a genuine customer overpayment beyond what any single fallback deal can absorb remains visible, never silently capped or dropped', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('Overpay');
  const parentId = await insertDeal({ leadId, name: 'Main Project', amount: 10000, daysAgo: 25 });
  const addendumId = await insertDeal({ leadId, name: 'Small Addendum', amount: 2000, parentDealId: parentId, daysAgo: 4 });

  // Parent has its own direct, fully-paid invoice.
  await mapDirectInvoice({ qbCustomerId, dealId: parentId, leadId, stamp, suffix: 'p', totalAmt: 10000, paid: 10000 });
  // The addendum has NO invoice of its own — eligible for the waterfall
  // fallback, capped at its own $2,000 contract.
  //
  // A THIRD, UNMAPPED invoice exists for this same QuickBooks customer
  // (never attributed to either deal) — real money this customer paid
  // that exceeds what either deal in this Master Project can absorb.
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_customer_id, total_amt, balance, paid, voided, last_synced_at)
     VALUES ($1, $2, 5000, 0, 5000, false, NOW())`,
    [`master-inv-unmapped-${stamp}`, qbCustomerId]
  );

  const res = await api('GET', `/api/v1/deals/${parentId}/addendums`, undefined, adminToken);
  const m = res.body.master;

  assert.strictEqual(res.body.total_approved_contract, 12000);
  // Customer's real total received is 10,000 (parent) + 5,000 (unmapped) =
  // 15,000. Parent claims 10,000 directly; the addendum's waterfall
  // fallback can absorb at most its own 2,000 contract from the remaining
  // 5,000 pool, leaving 3,000 genuinely unattributed to any specific deal
  // — which must still be VISIBLE in the combined total, never dropped
  // and never silently capped at the 12,000 combined contract value.
  const addendumRow = m.per_deal.find((d) => d.deal_id === addendumId);
  assert.strictEqual(addendumRow.collected, 2000, 'the addendum\'s fallback share is capped at its own contract, exactly as the waterfall already does for any single-deal lookup');
  assert.strictEqual(m.unattributed_customer_excess, 3000, 'the genuine leftover overpayment is reported explicitly, never silently dropped');
  assert.strictEqual(m.collected, 15000, 'collected must reflect the full real amount received (10,000 + 2,000 + 3,000 unattributed excess) — never capped at the 12,000 combined contract value');
  assert.ok(m.collected > res.body.total_approved_contract, 'a genuine overpayment must remain visible as collected > contract, never force-capped');
});
