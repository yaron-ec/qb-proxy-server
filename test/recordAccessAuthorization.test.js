/* eslint-disable no-undef */
/**
 * recordAccessAuthorization.test.js — regression tests for the canonical
 * row-level ownership/access-control layer (lib/recordAccess.js) and its
 * wiring into routes/tasks.js.
 *
 * Original finding (architecture review, Phase 4): tasks.js, activities.js,
 * invoices.js, and all deal sub-resource routers had NO ownership check
 * beyond requireAuth — a sales_rep could read/write/delete another rep's
 * task merely by knowing its id, or attach a task to a lead/deal they don't
 * own. lib/recordAccess.js consolidates lead-scope and deal-scope checks
 * (reusing routes/leads.js#resolveOwnerScope and lib/dealModel's existing
 * scope rules verbatim — no new permission model). This file tests both
 * the library directly and its effect on routes/tasks.js's handlers.
 *
 * DB access is mocked (require.cache substitution for db/client) — no live
 * database is used or required.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dbPath = require.resolve('../db/client');

// Mutable fixtures the mock query() reads from — set per-test.
let owners = []; // [{id, email, is_active}]
let leads = []; // [{id, owner_id}]
let deals = []; // [{id, assigned_rep, created_by, lead_id}]

async function mockQuery(sql, params) {
  const s = String(sql);
  if (/FROM\s+owners/i.test(s)) {
    const email = String(params[0] || '').toLowerCase();
    const row = owners.find(o => o.email.toLowerCase() === email && o.is_active !== false);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (/FROM\s+leads/i.test(s)) {
    const id = params[0];
    const row = leads.find(l => l.id === id);
    return { rows: row ? [{ owner_id: row.owner_id }] : [] };
  }
  if (/FROM\s+deals/i.test(s)) {
    const id = params[0];
    const row = deals.find(d => d.id === id);
    return { rows: row ? [row] : [] };
  }
  throw new Error('mockQuery: unrecognized query: ' + s);
}

delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { query: mockQuery, pool: {} },
};

const recordAccessPath = require.resolve('../lib/recordAccess');
delete require.cache[recordAccessPath];
const {
  resolveOwnerScope,
  checkLeadScope,
  checkDealScope,
  NO_MATCH_SENTINEL,
} = require('../lib/recordAccess');

function reset() {
  owners = [];
  leads = [];
  deals = [];
}

// ── resolveOwnerScope ────────────────────────────────────────────────────────

test('recordAccess: admin/manager get an unrestricted (null) owner filter', async () => {
  reset();
  assert.deepStrictEqual(await resolveOwnerScope({ role: 'admin' }), { ownerFilter: null });
  assert.deepStrictEqual(await resolveOwnerScope({ role: 'manager' }), { ownerFilter: null });
});

test('recordAccess: office gets a read-only unrestricted filter', async () => {
  reset();
  const scope = await resolveOwnerScope({ role: 'office' });
  assert.strictEqual(scope.ownerFilter, null);
  assert.strictEqual(scope.readOnly, true);
});

test('recordAccess: sales_rep with a matching active owners row resolves to that owner id', async () => {
  reset();
  owners = [{ id: 'owner-1', email: 'rep@ecconstructiongroup.com', is_active: true }];
  const scope = await resolveOwnerScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' });
  assert.strictEqual(scope.ownerFilter, 'owner-1');
});

test('recordAccess: sales_rep with NO matching owners row fails closed (sentinel, never null)', async () => {
  reset();
  const scope = await resolveOwnerScope({ role: 'sales_rep', email: 'ghost@ecconstructiongroup.com' });
  assert.strictEqual(scope.ownerFilter, NO_MATCH_SENTINEL, 'must fail closed, never fall back to unrestricted access');
});

test('recordAccess: unknown/missing role is denied', async () => {
  reset();
  assert.deepStrictEqual(await resolveOwnerScope({ role: 'bogus' }), { denied: true });
  assert.deepStrictEqual(await resolveOwnerScope({}), { denied: true });
});

// ── checkLeadScope ───────────────────────────────────────────────────────────

test('checkLeadScope: admin can access any lead', async () => {
  reset();
  leads = [{ id: 'lead-1', owner_id: 'owner-99' }];
  const result = await checkLeadScope({ role: 'admin' }, 'lead-1');
  assert.strictEqual(result.allowed, true);
});

test('checkLeadScope: sales_rep who owns the lead is allowed', async () => {
  reset();
  owners = [{ id: 'owner-1', email: 'rep@ecconstructiongroup.com', is_active: true }];
  leads = [{ id: 'lead-1', owner_id: 'owner-1' }];
  const result = await checkLeadScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, 'lead-1');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.readOnly, false);
});

test('checkLeadScope: sales_rep who does NOT own the lead is denied (negative case)', async () => {
  reset();
  owners = [{ id: 'owner-1', email: 'rep-a@ecconstructiongroup.com', is_active: true }];
  leads = [{ id: 'lead-1', owner_id: 'owner-2' }]; // owned by a different rep
  const result = await checkLeadScope({ role: 'sales_rep', email: 'rep-a@ecconstructiongroup.com' }, 'lead-1');
  assert.strictEqual(result.allowed, false, 'a rep must not access a lead owned by another rep merely by knowing its id');
  assert.strictEqual(result.reason, 'not_owner');
});

test('checkLeadScope: sales_rep with no owners row is denied for every lead (fail closed)', async () => {
  reset();
  leads = [{ id: 'lead-1', owner_id: 'owner-1' }];
  const result = await checkLeadScope({ role: 'sales_rep', email: 'ghost@ecconstructiongroup.com' }, 'lead-1');
  assert.strictEqual(result.allowed, false);
});

test('checkLeadScope: nonexistent lead is reported distinctly (lead_not_found, not not_owner)', async () => {
  reset();
  owners = [{ id: 'owner-1', email: 'rep@ecconstructiongroup.com', is_active: true }];
  const result = await checkLeadScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, 'nonexistent-lead');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'lead_not_found');
});

test('checkLeadScope: missing lead_id is denied', async () => {
  reset();
  const result = await checkLeadScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, undefined);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'missing_lead_id');
});

test('checkLeadScope: office is allowed but marked read-only', async () => {
  reset();
  leads = [{ id: 'lead-1', owner_id: 'owner-1' }];
  const result = await checkLeadScope({ role: 'office' }, 'lead-1');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.readOnly, true);
});

// ── checkDealScope ───────────────────────────────────────────────────────────

test('checkDealScope: admin can access any deal', async () => {
  reset();
  const result = await checkDealScope({ role: 'admin' }, 'deal-1');
  assert.strictEqual(result.allowed, true);
});

test('checkDealScope: sales_rep assigned to the deal is allowed', async () => {
  reset();
  deals = [{ id: 'deal-1', assigned_rep: 'rep@ecconstructiongroup.com', created_by: null, lead_id: null }];
  const result = await checkDealScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, 'deal-1');
  assert.strictEqual(result.allowed, true);
});

test('checkDealScope: sales_rep NOT assigned to the deal is denied (negative case)', async () => {
  reset();
  deals = [{ id: 'deal-1', assigned_rep: 'other-rep@ecconstructiongroup.com', created_by: null, lead_id: null }];
  const result = await checkDealScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, 'deal-1');
  assert.strictEqual(result.allowed, false, 'a rep must not access a deal assigned to another rep merely by knowing its id');
  assert.strictEqual(result.reason, 'not_owner');
});

test('checkDealScope: office is denied outright (deals carry financial data)', async () => {
  reset();
  deals = [{ id: 'deal-1', assigned_rep: null, created_by: null, lead_id: null }];
  const result = await checkDealScope({ role: 'office' }, 'deal-1');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'role_denied');
});

test('checkDealScope: nonexistent deal is reported distinctly (deal_not_found)', async () => {
  reset();
  const result = await checkDealScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, 'nonexistent-deal');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'deal_not_found');
});

test('checkDealScope: missing deal_id is denied', async () => {
  reset();
  const result = await checkDealScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, undefined);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'missing_deal_id');
});

// ── routes/tasks.js source wiring ────────────────────────────────────────────
// Static checks that the route file actually calls into the canonical
// module at every mutation/read point, rather than re-testing recordAccess
// itself through an HTTP layer this suite doesn't stand up.

const fs = require('fs');
const path = require('path');
const tasksSource = fs.readFileSync(path.resolve(__dirname, '../routes/tasks.js'), 'utf8');

test('TASKS: routes/tasks.js imports the canonical recordAccess module (not a local reimplementation)', () => {
  assert.ok(tasksSource.includes("require('../lib/recordAccess')"), 'must import lib/recordAccess');
});

test('TASKS: GET / list requires a lead_id or deal_id scope AND checks ownership of it', () => {
  assert.ok(tasksSource.includes('if (!lead_id && !deal_id) return res.json({ items: [], total: 0 })'), 'must require a scope (P0 isolation)');
  assert.ok(tasksSource.includes('checkLeadScope(req.user, lead_id)'), 'list must verify ownership of the supplied lead_id');
  assert.ok(tasksSource.includes('checkDealScope(req.user, deal_id)'), 'list must verify ownership of the supplied deal_id');
});

test('TASKS: POST / create verifies ownership of lead_id/deal_id before insert', () => {
  const createSection = tasksSource.slice(tasksSource.indexOf("router.post('/'"), tasksSource.indexOf("router.get('/:id'"));
  assert.ok(createSection.includes('checkLeadScope'), 'create must verify lead ownership');
  assert.ok(createSection.includes('checkDealScope'), 'create must verify deal ownership');
  assert.ok(createSection.includes("res.status(403)"), 'create must reject unauthorized scope with 403');
});

test('TASKS: GET/PUT/DELETE :id all call checkTaskAccess before acting on the row', () => {
  const idSection = tasksSource.slice(tasksSource.indexOf("router.get('/:id'"));
  const occurrences = (idSection.match(/checkTaskAccess\(/g) || []).length;
  assert.strictEqual(occurrences, 3, 'expected checkTaskAccess to be called once each for GET/PUT/DELETE :id');
});

test('TASKS: PUT/DELETE deny read-only roles (office) via allowReadOnly:false', () => {
  const writeSection = tasksSource.slice(tasksSource.indexOf("router.put('/:id'"));
  const occurrences = (writeSection.match(/allowReadOnly:\s*false/g) || []).length;
  assert.ok(occurrences >= 2, 'PUT and DELETE must both pass allowReadOnly:false to deny office (read-only) writes');
});

test('TASKS: an unscoped task (no lead_id or deal_id) is denied for non-admin roles (fail closed)', async () => {
  // checkTaskAccess isn't exported (it's route-local); exercise the same
  // fail-closed contract directly against the exported primitives it's built
  // from — an unscoped record has no ownership signal to check a sales_rep
  // against, so it must never fall through to "allowed".
  reset();
  const result = await checkLeadScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, null);
  assert.strictEqual(result.allowed, false);
  const dealResult = await checkDealScope({ role: 'sales_rep', email: 'rep@ecconstructiongroup.com' }, null);
  assert.strictEqual(dealResult.allowed, false);
});

// ── routes/activities.js, routes/invoices.js, and the deal sub-resource
// routers — same canonical-layer wiring, checked at the source level. ───────

function readRoute(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

test('ACTIVITIES: routes/activities.js checks lead ownership on list/create/get/put/delete', () => {
  const src = readRoute('routes/activities.js');
  assert.ok(src.includes("require('../lib/recordAccess')"), 'must import lib/recordAccess');
  const occurrences = (src.match(/checkLeadScope\(/g) || []).length;
  assert.strictEqual(occurrences, 5, 'expected checkLeadScope on list, create, GET/PUT/DELETE :id (5 call sites)');
});

test('INVOICES: routes/invoices.js checks lead/deal ownership on every handler', () => {
  const src = readRoute('routes/invoices.js');
  assert.ok(src.includes("require('../lib/recordAccess')"), 'must import lib/recordAccess');
  assert.ok(src.includes('function checkInvoiceAccess'), 'must define a checkInvoiceAccess helper (lead_id-or-deal_id fallback)');
  const idSection = src.slice(src.indexOf("router.get('/:id'"));
  const occurrences = (idSection.match(/checkInvoiceAccess\(/g) || []).length;
  assert.strictEqual(occurrences, 3, 'expected checkInvoiceAccess on GET/PUT/DELETE :id');
});

test('DEAL SUB-RESOURCES: dealExpenses/dealCommissions/dealLoanPayments/dealExpensePayments all check deal ownership', () => {
  for (const file of ['routes/dealExpenses.js', 'routes/dealCommissions.js', 'routes/dealLoanPayments.js', 'routes/dealExpensePayments.js']) {
    const src = readRoute(file);
    assert.ok(src.includes("require('../lib/recordAccess')"), file + ': must import lib/recordAccess');
    const occurrences = (src.match(/checkDealScope\(/g) || []).length;
    assert.ok(occurrences >= 4, file + ': expected checkDealScope on list, create, GET/PUT :id (delete is already admin-gated) — found ' + occurrences);
  }
});

test('DEAL FINANCIALS: routes/dealFinancials.js checks deal ownership before returning financial data', () => {
  const src = readRoute('routes/dealFinancials.js');
  assert.ok(src.includes("require('../lib/recordAccess')"), 'must import lib/recordAccess');
  assert.ok(src.includes('checkDealScope(req.user, saleId)'), 'must verify ownership of the requested deal before computing financials');
});
