/* eslint-disable no-undef */
'use strict';

/**
 * dealAddendumConversion.int.test.js — real-Postgres, real-HTTP proof of
 * CRM repair item 1 (November 2026): the Parent Project / Addendum
 * relationship (routes/deals.js's new GET /:id/addendums and
 * POST /:id/convert-to-addendum, lib/dealModel.js#canConvertToAddendum).
 *
 * Models the EXACT Ali & Mohemmed Lalani shape (item 5): a $33,000.00
 * original roof deal and a $7,934.35 "Bathroom repair" deal on the SAME
 * lead, created as two independent, disconnected deals — proves the admin
 * action correctly links them and the combined total comes out to
 * $40,934.35, the figure confirmed against his real signed contract +
 * accepted QuickBooks estimate.
 *
 * Also proves: admin-only (manager/sales_rep forbidden), a reason is
 * required, cross-lead conversion is blocked, double-conversion is
 * blocked, nested addendums (parent-of-a-parent) are blocked, and the
 * conversion preserves the addendum deal's own id/every FK pointing at it
 * (deal_expenses) — "without losing IDs/invoices/payments/expenses/
 * documents/activity history" is structural (nothing is deleted or
 * recreated), proven directly here rather than assumed.
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

let base, server, db, adminToken, managerToken, repToken;
let leadId, otherLeadId, roofDealId, bathroomDealId, otherLeadDealId, grandchildDealId, expenseId;

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
  app.use('/api/v1/deals', require(path.join(ROOT, 'routes/deals')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ff01', email: `admin-addendum-${stamp}@test.example`, role: 'admin' });
  managerToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ff02', email: `manager-addendum-${stamp}@test.example`, role: 'manager' });
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000ff03', email: `rep-addendum-${stamp}@test.example`, role: 'sales_rep' });

  const ownerRes = await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'Addendum Test Owner') RETURNING id`, [`owner-addendum-${stamp}@test.example`]);
  const ownerId = ownerRes.rows[0].id;

  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Ali', 'TestLalani', $1, '5559990011', 'Referral', 'Sold', $2) RETURNING id`,
    [`addendum-lead-${stamp}@test.example`, ownerId]
  );
  leadId = leadRes.rows[0].id;

  const otherLeadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Other', 'Customer', $1, '5559990022', 'Referral', 'Sold', $2) RETURNING id`,
    [`addendum-other-${stamp}@test.example`, ownerId]
  );
  otherLeadId = otherLeadRes.rows[0].id;

  const roofDeal = await db.query(`INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Roof Job', 33000.00, 'Job Completed') RETURNING id`, [leadId]);
  roofDealId = roofDeal.rows[0].id;
  const bathroomDeal = await db.query(`INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Bathroom repair', 7934.35, 'Sold / Estimate Approved') RETURNING id`, [leadId]);
  bathroomDealId = bathroomDeal.rows[0].id;
  const otherLeadDeal = await db.query(`INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Unrelated Project', 5000, 'Sold / Estimate Approved') RETURNING id`, [otherLeadId]);
  otherLeadDealId = otherLeadDeal.rows[0].id;
  const grandchildDeal = await db.query(`INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Yet Another Addendum', 1000, 'Sold / Estimate Approved') RETURNING id`, [leadId]);
  grandchildDealId = grandchildDeal.rows[0].id;

  const expenseRes = await db.query(
    `INSERT INTO deal_expenses (deal_id, lead_id, vendor_name, category, amount) VALUES ($1, $2, 'Bathroom Vendor', 'Materials', 200) RETURNING id`,
    [bathroomDealId, leadId]
  );
  expenseId = expenseRes.rows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.query('DELETE FROM activities WHERE lead_id IN ($1, $2)', [leadId, otherLeadId]);
  await db.query('DELETE FROM deal_expenses WHERE id = $1', [expenseId]);
  await db.query('DELETE FROM deals WHERE id IN ($1, $2, $3, $4)', [roofDealId, bathroomDealId, otherLeadDealId, grandchildDealId]);
  await db.query('DELETE FROM leads WHERE id IN ($1, $2)', [leadId, otherLeadId]);
  await db.pool.end();
});

test('1. GET /:id/addendums on a deal with no addendums yet: empty list, combined total = own amount only', { skip }, async () => {
  const r = await api('GET', `/api/v1/deals/${roofDealId}/addendums`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.addendums.length, 0);
  assert.strictEqual(r.body.original_contract_amount, 33000);
  assert.strictEqual(r.body.total_approved_contract, 33000);
});

test('2. non-admin (manager, sales_rep) is forbidden from converting a deal into an addendum', { skip }, async () => {
  const asManager = await api('POST', `/api/v1/deals/${bathroomDealId}/convert-to-addendum`, { parent_deal_id: roofDealId, reason: 'test' }, managerToken);
  assert.strictEqual(asManager.status, 403);
  const asRep = await api('POST', `/api/v1/deals/${bathroomDealId}/convert-to-addendum`, { parent_deal_id: roofDealId, reason: 'test' }, repToken);
  assert.strictEqual(asRep.status, 403);
});

test('3. a reason is required', { skip }, async () => {
  const r = await api('POST', `/api/v1/deals/${bathroomDealId}/convert-to-addendum`, { parent_deal_id: roofDealId }, adminToken);
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'reason required');
});

test('4. converting a deal to a parent on a DIFFERENT lead is blocked', { skip }, async () => {
  const r = await api('POST', `/api/v1/deals/${bathroomDealId}/convert-to-addendum`, { parent_deal_id: otherLeadDealId, reason: 'cross-lead test' }, adminToken);
  assert.strictEqual(r.status, 422, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'cross_lead');
});

test('5. admin successfully converts the Bathroom Repair deal into an addendum of the Roof Job — the EXACT Lalani shape, combined total = $40,934.35', { skip }, async (t) => {
  const r = await api('POST', `/api/v1/deals/${bathroomDealId}/convert-to-addendum`, { parent_deal_id: roofDealId, reason: 'Accepted bathroom-repair addendum (HNDF-EST-10351, $7,934.35) for the same project.' }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.deal.parent_deal_id, roofDealId);
  assert.strictEqual(r.body.parent_deal_name, 'Roof Job');

  const addendums = await api('GET', `/api/v1/deals/${roofDealId}/addendums`, undefined, adminToken);
  assert.strictEqual(addendums.body.addendums.length, 1);
  assert.strictEqual(addendums.body.addendums[0].id, bathroomDealId);
  assert.strictEqual(addendums.body.original_contract_amount, 33000);
  assert.strictEqual(addendums.body.approved_addendums_amount, 7934.35);
  assert.strictEqual(addendums.body.total_approved_contract, 40934.35);

  // "without losing IDs/invoices/payments/expenses/documents/activity
  // history" — the expense row attached to the addendum deal is completely
  // untouched: same id, same deal_id, same amount.
  const expenseCheck = await db.query('SELECT id, deal_id, amount FROM deal_expenses WHERE id = $1', [expenseId]);
  assert.strictEqual(expenseCheck.rows[0].deal_id, bathroomDealId);
  assert.strictEqual(Number(expenseCheck.rows[0].amount), 200);

  const activity = await db.query(`SELECT content FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [leadId]);
  assert.match(activity.rows[0].content, /converted into an addendum of "Roof Job"/);
  assert.match(activity.rows[0].content, /Accepted bathroom-repair addendum/);
});

test('6. a deal already converted cannot be converted a second time (already_an_addendum)', { skip }, async () => {
  const r = await api('POST', `/api/v1/deals/${bathroomDealId}/convert-to-addendum`, { parent_deal_id: otherLeadDealId, reason: 'second attempt' }, adminToken);
  // Hits cross_lead first in this case since otherLeadDealId is also a
  // different lead — verify the already-an-addendum case with a same-lead target instead.
  assert.strictEqual(r.status, 422);

  const sameLeadAttempt = await api('POST', `/api/v1/deals/${bathroomDealId}/convert-to-addendum`, { parent_deal_id: grandchildDealId, reason: 'second attempt same lead' }, adminToken);
  assert.strictEqual(sameLeadAttempt.status, 422, JSON.stringify(sameLeadAttempt.body));
  assert.strictEqual(sameLeadAttempt.body.error, 'already_an_addendum');
});

test('7. a deal cannot be converted to a parent that is ITSELF an addendum (no nested addendums)', { skip }, async () => {
  const r = await api('POST', `/api/v1/deals/${grandchildDealId}/convert-to-addendum`, { parent_deal_id: bathroomDealId, reason: 'nested attempt' }, adminToken);
  assert.strictEqual(r.status, 422, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'parent_is_itself_an_addendum');
});

test('8. a deal cannot be converted into its own addendum (self-reference)', { skip }, async () => {
  const r = await api('POST', `/api/v1/deals/${grandchildDealId}/convert-to-addendum`, { parent_deal_id: grandchildDealId, reason: 'self test' }, adminToken);
  assert.strictEqual(r.status, 422, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'self_reference');
});
