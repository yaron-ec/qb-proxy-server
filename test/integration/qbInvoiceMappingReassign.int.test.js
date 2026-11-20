/* eslint-disable no-undef */
'use strict';

/**
 * qbInvoiceMappingReassign.int.test.js — real-Postgres proof of
 * routes/qbInvoiceMapping.js (CRM repair item 4/5: the Ali & Mohemmed
 * Lalani case, where a backfill mapped invoices that most plausibly belong
 * to his bathroom-repair addendum onto his original roof deal instead, and
 * nothing in this codebase could correct that — lib/qbInvoiceSaleMap.js's
 * own upsertMapping() deliberately never reassigns an existing mapping).
 *
 * Proves: GET /by-lead/:leadId returns the full deal + invoice picture;
 * reassignment requires a non-empty reason; reassignment is blocked across
 * two DIFFERENT leads' deals (never crosses the real ownership boundary);
 * a valid same-lead reassignment updates crm_sale_id, sets
 * mapping_method='manual', and writes exactly one audit activity note
 * naming both deal names and the reason; reassigning to the
 * already-current deal is a no-op 409, never a duplicate audit note;
 * admin/manager-only (sales_rep forbidden).
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

let base, server, db, adminToken, repToken, leadId, otherLeadId, dealAId, dealBId, otherLeadDealId, invoiceId;

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
  app.use('/api/v1/qb-invoice-mapping', require(path.join(ROOT, 'routes/qbInvoiceMapping')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ee01', email: `admin-invmap-${stamp}@test.example`, role: 'admin' });
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ee02', email: `rep-invmap-${stamp}@test.example`, role: 'sales_rep' });

  const ownerRes = await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'Invoice Mapping Test Owner') RETURNING id`, [`owner-invmap-${stamp}@test.example`]);
  const ownerId = ownerRes.rows[0].id;

  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id, qb_customer_id)
     VALUES ('Ali', 'TestLalani', $1, '5551230000', 'Referral', 'Sold', $2, '999') RETURNING id`,
    [`invmap-lead-${stamp}@test.example`, ownerId]
  );
  leadId = leadRes.rows[0].id;

  const otherLeadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id, qb_customer_id)
     VALUES ('Other', 'Customer', $1, '5559990000', 'Referral', 'Sold', $2, '888') RETURNING id`,
    [`invmap-other-${stamp}@test.example`, ownerId]
  );
  otherLeadId = otherLeadRes.rows[0].id;

  const dealA = await db.query(`INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Roof Job', 33000, 'Sold / Estimate Approved') RETURNING id`, [leadId]);
  dealAId = dealA.rows[0].id;
  const dealB = await db.query(`INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Bathroom Repair', 7934.35, 'Sold / Estimate Approved') RETURNING id`, [leadId]);
  dealBId = dealB.rows[0].id;
  const otherDeal = await db.query(`INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Unrelated Project', 5000, 'Sold / Estimate Approved') RETURNING id`, [otherLeadId]);
  otherLeadDealId = otherDeal.rows[0].id;

  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_doc_number, qb_customer_id, total_amt, balance, paid, txn_date)
     VALUES ($1, 'HNDF-TEST-9', '999', 9994, 0, 9994, '2026-09-01')`,
    [`invmap-inv-${stamp}`]
  );
  await db.query(
    `INSERT INTO qb_invoice_sale_map (qb_invoice_id, qb_doc_number, crm_sale_id, crm_lead_id, qb_customer_id, mapping_method)
     VALUES ($1, 'HNDF-TEST-9', $2, $3, '999', 'backfill')`,
    [`invmap-inv-${stamp}`, dealAId, leadId]
  );
  invoiceId = `invmap-inv-${stamp}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.query('DELETE FROM activities WHERE lead_id IN ($1, $2)', [leadId, otherLeadId]);
  await db.query('DELETE FROM qb_invoice_sale_map WHERE qb_invoice_id = $1', [invoiceId]);
  await db.query('DELETE FROM qb_invoices_cache WHERE qb_invoice_id = $1', [invoiceId]);
  await db.query('DELETE FROM deals WHERE id IN ($1, $2, $3)', [dealAId, dealBId, otherLeadDealId]);
  await db.query('DELETE FROM leads WHERE id IN ($1, $2)', [leadId, otherLeadId]);
  await db.pool.end();
});

test('1. GET /by-lead/:leadId returns the full deal + invoice picture, admin/manager only', { skip }, async () => {
  const r = await api('GET', `/api/v1/qb-invoice-mapping/by-lead/${leadId}`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.deals.length, 2);
  assert.strictEqual(r.body.invoices.length, 1);
  assert.strictEqual(r.body.invoices[0].crm_sale_id, dealAId);

  const forbidden = await api('GET', `/api/v1/qb-invoice-mapping/by-lead/${leadId}`, undefined, repToken);
  assert.strictEqual(forbidden.status, 403);
});

test('2. reassignment requires a non-empty reason', { skip }, async () => {
  const r = await api('POST', `/api/v1/qb-invoice-mapping/${invoiceId}/reassign`, { crm_sale_id: dealBId }, adminToken);
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'reason required');
});

test('3. reassignment to a deal on a DIFFERENT lead is blocked — never crosses the real ownership boundary', { skip }, async () => {
  const r = await api('POST', `/api/v1/qb-invoice-mapping/${invoiceId}/reassign`, { crm_sale_id: otherLeadDealId, reason: 'test cross-lead' }, adminToken);
  assert.strictEqual(r.status, 422, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'cross_lead_reassignment_blocked');

  const check = await db.query('SELECT crm_sale_id FROM qb_invoice_sale_map WHERE qb_invoice_id = $1', [invoiceId]);
  assert.strictEqual(check.rows[0].crm_sale_id, dealAId, 'a blocked reassignment attempt must never change the mapping');
});

test('4. a valid same-lead reassignment updates crm_sale_id, sets mapping_method=manual, and writes one audit note naming both deals and the reason', { skip }, async () => {
  const r = await api('POST', `/api/v1/qb-invoice-mapping/${invoiceId}/reassign`,
    { crm_sale_id: dealBId, reason: 'Invoiced Sept 1, after the bathroom addendum was accepted Aug 28 — belongs to the addendum, not the roof job.' }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mapping.crm_sale_id, dealBId);
  assert.strictEqual(r.body.mapping.mapping_method, 'manual');
  assert.strictEqual(r.body.old_deal_name, 'Roof Job');
  assert.strictEqual(r.body.new_deal_name, 'Bathroom Repair');

  const activity = await db.query(`SELECT content FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [leadId]);
  assert.match(activity.rows[0].content, /Roof Job/);
  assert.match(activity.rows[0].content, /Bathroom Repair/);
  assert.match(activity.rows[0].content, /belongs to the addendum/);
});

test('5. reassigning to the already-current deal is a no-op 409, never a duplicate audit note', { skip }, async () => {
  const before = await db.query(`SELECT COUNT(*) FROM activities WHERE lead_id = $1`, [leadId]);
  const r = await api('POST', `/api/v1/qb-invoice-mapping/${invoiceId}/reassign`, { crm_sale_id: dealBId, reason: 'no-op check' }, adminToken);
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'already_assigned');
  const after = await db.query(`SELECT COUNT(*) FROM activities WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(after.rows[0].count, before.rows[0].count);
});
