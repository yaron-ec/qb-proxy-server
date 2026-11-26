/* eslint-disable no-undef */
'use strict';

/**
 * masterProjectInvoiceReconciliation.int.test.js — REAL-Postgres proof of
 * the itemized, read-only Master Project invoice reconciliation diagnostic
 * (November 2026, built for the Lalani $42,031-vs-$40,934 investigation).
 *
 * Proves: (1) the exact Lalani double-counting shape is reproduced with
 * full itemized detail and the correct computed totals; (2) a voided
 * invoice is reported but correctly excluded from the computed totals;
 * (3) an invoice mapped to a DIFFERENT, unrelated deal for the same
 * customer is reported distinctly, never silently folded into this
 * project's totals; (4) a duplicate document number is flagged; (5) the
 * HTTP route is admin-only and genuinely read-only (no mutation of any
 * kind, confirmed by re-querying the underlying tables unchanged).
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

let base, server, db, adminToken, repToken, round2;

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
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));
  round2 = require(path.join(ROOT, 'lib/qbInvoiceSaleMap')).round2;

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/deals', require(path.join(ROOT, 'routes/masterProjectInvoiceReconciliation')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ee03', email: `admin-invrecon-${Date.now()}@test.example`, role: 'admin' });
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ee04', email: `rep-invrecon-${Date.now()}@test.example`, role: 'sales_rep' });
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

async function seedCustomer(label) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const qbCustomerId = `qbcust-invrecon-${stamp}`;
  const { rows: ownerRows } = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Inv Recon Owner') RETURNING id`,
    [`owner-invrecon-${stamp}@test.example`]
  );
  const { rows: leadRows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, qb_customer_id, owner_id)
     VALUES ($1, $2, $3, '5557778888', 'Referral', 'Sold', $4, $5) RETURNING id`,
    [label, 'Customer', `invrecon-${stamp}@test.example`, qbCustomerId, ownerRows[0].id]
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

async function insertCachedInvoice({ qbInvoiceId, qbCustomerId, docNumber, totalAmt, paid, voided = false, txnDate = null }) {
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_doc_number, qb_customer_id, total_amt, balance, paid, voided, txn_date, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [qbInvoiceId, docNumber, qbCustomerId, totalAmt, round2(totalAmt - paid), paid, voided, txnDate]
  );
}

async function mapInvoice({ qbInvoiceId, dealId, leadId, qbCustomerId, voided = false }) {
  await db.query(
    `INSERT INTO qb_invoice_sale_map (qb_invoice_id, qb_doc_number, crm_sale_id, crm_lead_id, qb_customer_id, mapping_method, voided)
     VALUES ($1, NULL, $2, $3, $4, 'crm_created', $5)`,
    [qbInvoiceId, dealId, leadId, qbCustomerId, voided]
  );
}

test('1. the exact Lalani shape: root has 6 direct invoices totaling $42,031 paid in full; addendum has none — itemized reconciliation shows every row and the correct computed totals', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('LalaniRecon');
  const parentId = await insertDeal({ leadId, name: 'Roof Replacement', amount: 33000, daysAgo: 30 });
  const addendumId = await insertDeal({ leadId, name: 'Bathroom Repair', amount: 7934, parentDealId: parentId, daysAgo: 5 });

  const amounts = [10000, 8000, 7000, 7031, 5000, 5000]; // sums to 42031
  for (let i = 0; i < amounts.length; i++) {
    const qbInvoiceId = `inv-recon-${stamp}-${i}`;
    await insertCachedInvoice({ qbInvoiceId, qbCustomerId, docNumber: `DOC-${stamp}-${i}`, totalAmt: amounts[i], paid: amounts[i] });
    await mapInvoice({ qbInvoiceId, dealId: parentId, leadId, qbCustomerId });
  }

  const res = await api('GET', `/api/v1/deals/${parentId}/invoice-reconciliation`, adminToken);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.found, true);
  assert.strictEqual(res.body.invoices.length, 6);
  assert.strictEqual(res.body.summary.computed_invoiced_total, 42031);
  assert.strictEqual(res.body.summary.computed_collected_total, 42031);
  assert.strictEqual(res.body.summary.customer_total_received_all_cached_invoices, 42031);
  assert.strictEqual(res.body.summary.unclaimed_remainder_for_fallback_or_excess, 0);
  assert.strictEqual(res.body.summary.duplicate_document_numbers_found.length, 0);
  assert.strictEqual(res.body.summary.invoices_mapped_to_a_different_deal, 0);
  assert.strictEqual(res.body.summary.invoices_not_mapped_to_any_deal, 0);
  for (const inv of res.body.invoices) {
    assert.strictEqual(inv.included_in_collected_calculation, true);
    assert.ok(inv.associated_project.startsWith('Roof Replacement'));
  }

  // Viewing from the addendum's own id must show the SAME reconciliation.
  const res2 = await api('GET', `/api/v1/deals/${addendumId}/invoice-reconciliation`, adminToken);
  assert.strictEqual(res2.body.summary.computed_collected_total, 42031);
});

test('2. a voided invoice is reported but correctly excluded from every computed total', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('VoidedRecon');
  const parentId = await insertDeal({ leadId, name: 'Main Project', amount: 10000, daysAgo: 20 });
  await insertCachedInvoice({ qbInvoiceId: `inv-void-${stamp}-1`, qbCustomerId, docNumber: `D1-${stamp}`, totalAmt: 10000, paid: 10000 });
  await mapInvoice({ qbInvoiceId: `inv-void-${stamp}-1`, dealId: parentId, leadId, qbCustomerId });
  // A second invoice, later voided in QuickBooks — a duplicate/erroneous
  // transaction (the exact class of record the Lalani $1,097 gap may be).
  await insertCachedInvoice({ qbInvoiceId: `inv-void-${stamp}-2`, qbCustomerId, docNumber: `D2-${stamp}`, totalAmt: 1097, paid: 1097, voided: true });
  await mapInvoice({ qbInvoiceId: `inv-void-${stamp}-2`, dealId: parentId, leadId, qbCustomerId });

  const res = await api('GET', `/api/v1/deals/${parentId}/invoice-reconciliation`, adminToken);
  assert.strictEqual(res.body.invoices.length, 2);
  const voidedRow = res.body.invoices.find((i) => i.qb_invoice_id === `inv-void-${stamp}-2`);
  assert.strictEqual(voidedRow.cache_voided, true);
  assert.strictEqual(voidedRow.included_in_collected_calculation, false);
  assert.strictEqual(voidedRow.amount_included_in_collected, 0);
  assert.strictEqual(res.body.summary.computed_collected_total, 10000, 'the voided $1,097 invoice must never be counted');
  assert.strictEqual(res.body.summary.voided_invoices_excluded_from_totals, 1);
});

test('3. an invoice mapped to a DIFFERENT, unrelated deal for the same customer is reported distinctly, never folded into this project', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('OtherDealRecon');
  const parentId = await insertDeal({ leadId, name: 'Project A', amount: 10000, daysAgo: 20 });
  const unrelatedDealId = await insertDeal({ leadId, name: 'Unrelated Project B', amount: 5000, daysAgo: 60 });
  await insertCachedInvoice({ qbInvoiceId: `inv-other-${stamp}-1`, qbCustomerId, docNumber: `D1-${stamp}`, totalAmt: 10000, paid: 10000 });
  await mapInvoice({ qbInvoiceId: `inv-other-${stamp}-1`, dealId: parentId, leadId, qbCustomerId });
  await insertCachedInvoice({ qbInvoiceId: `inv-other-${stamp}-2`, qbCustomerId, docNumber: `D2-${stamp}`, totalAmt: 5000, paid: 5000 });
  await mapInvoice({ qbInvoiceId: `inv-other-${stamp}-2`, dealId: unrelatedDealId, leadId, qbCustomerId });

  const res = await api('GET', `/api/v1/deals/${parentId}/invoice-reconciliation`, adminToken);
  assert.strictEqual(res.body.summary.computed_collected_total, 10000, 'the unrelated deal\'s own invoice must never be counted toward THIS project');
  assert.strictEqual(res.body.summary.invoices_mapped_to_a_different_deal, 1);
  const otherRow = res.body.invoices.find((i) => i.qb_invoice_id === `inv-other-${stamp}-2`);
  assert.match(otherRow.associated_project, /A DIFFERENT, unrelated deal: Unrelated Project B/);
  assert.strictEqual(otherRow.included_in_collected_calculation, false);
});

test('4. a duplicate document number across two different qb_invoice_id values is flagged', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('DupDocRecon');
  const parentId = await insertDeal({ leadId, name: 'Main Project', amount: 10000, daysAgo: 20 });
  const sharedDoc = `SHARED-${stamp}`;
  await insertCachedInvoice({ qbInvoiceId: `inv-dup-${stamp}-1`, qbCustomerId, docNumber: sharedDoc, totalAmt: 5000, paid: 5000 });
  await mapInvoice({ qbInvoiceId: `inv-dup-${stamp}-1`, dealId: parentId, leadId, qbCustomerId });
  await insertCachedInvoice({ qbInvoiceId: `inv-dup-${stamp}-2`, qbCustomerId, docNumber: sharedDoc, totalAmt: 5000, paid: 5000 });
  await mapInvoice({ qbInvoiceId: `inv-dup-${stamp}-2`, dealId: parentId, leadId, qbCustomerId });

  const res = await api('GET', `/api/v1/deals/${parentId}/invoice-reconciliation`, adminToken);
  assert.deepStrictEqual(res.body.summary.duplicate_document_numbers_found, [sharedDoc]);
  assert.ok(res.body.invoices.every((i) => i.duplicate_document_number === true));
  assert.strictEqual(res.body.summary.computed_collected_total, 10000, 'both rows are still real cached invoices and both still count — this test only proves the FLAG, never auto-removes anything');
});

test('5. the route is admin-only and strictly read-only — no row in either table is ever changed by calling it', { skip }, async () => {
  const { leadId, qbCustomerId, stamp } = await seedCustomer('ReadOnlyRecon');
  const parentId = await insertDeal({ leadId, name: 'Main Project', amount: 10000, daysAgo: 20 });
  await insertCachedInvoice({ qbInvoiceId: `inv-ro-${stamp}-1`, qbCustomerId, docNumber: `D1-${stamp}`, totalAmt: 10000, paid: 10000 });
  await mapInvoice({ qbInvoiceId: `inv-ro-${stamp}-1`, dealId: parentId, leadId, qbCustomerId });

  const before = await db.query(`SELECT * FROM qb_invoices_cache WHERE qb_invoice_id = $1`, [`inv-ro-${stamp}-1`]);
  const beforeMap = await db.query(`SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = $1`, [`inv-ro-${stamp}-1`]);

  const resNoAuth = await api('GET', `/api/v1/deals/${parentId}/invoice-reconciliation`, undefined);
  assert.strictEqual(resNoAuth.status, 401);
  const resRep = await api('GET', `/api/v1/deals/${parentId}/invoice-reconciliation`, repToken);
  assert.strictEqual(resRep.status, 403, 'a sales_rep must never see this cross-deal diagnostic');
  const resAdmin = await api('GET', `/api/v1/deals/${parentId}/invoice-reconciliation`, adminToken);
  assert.strictEqual(resAdmin.status, 200);

  const after = await db.query(`SELECT * FROM qb_invoices_cache WHERE qb_invoice_id = $1`, [`inv-ro-${stamp}-1`]);
  const afterMap = await db.query(`SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = $1`, [`inv-ro-${stamp}-1`]);
  assert.deepStrictEqual(after.rows, before.rows, 'qb_invoices_cache must be byte-for-byte unchanged');
  assert.deepStrictEqual(afterMap.rows, beforeMap.rows, 'qb_invoice_sale_map must be byte-for-byte unchanged');
});
