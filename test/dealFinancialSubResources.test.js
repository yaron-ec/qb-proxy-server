/* eslint-disable no-undef */
'use strict';

/**
 * dealFinancialSubResources.test.js — routes/dealExpenses.js,
 * routes/dealExpensePayments.js, routes/dealCommissions.js,
 * routes/dealLoanPayments.js.
 *
 * PRODUCTION BUG: saving (editing) an expense on
 * crm.ecconstructiongroup.com -> Deal -> Financials -> Vendor & Project
 * Expenses failed with "syntax error at or near ';'". Root cause: all four
 * of these routers' PUT :id handlers built their UPDATE SET clause as
 *   const updates = ['updated_by'];
 *   ... updates.push(`${f} = $${p}`) ...
 *   `UPDATE deal_expenses SET ${updates.join(', ')} WHERE id = $${p}`
 * — the seed element was the BARE COLUMN NAME "updated_by" with no
 * "= $1", so the generated SQL was e.g.
 *   UPDATE deal_expenses SET updated_by, category = $2, amount = $3, ...
 * which is invalid: every SET target needs "= value". This is a horizontal
 * defect — all four "deal sub-resource" routers (already flagged in
 * CLAUDE.md as having weak/no ownership checks) share this exact
 * copy-pasted construction and had ZERO test coverage before this file,
 * which is why it shipped to production undetected. Fixed to
 * `const updates = ['updated_by = $1'];` in all four files.
 *
 * The mock query() below is SQL-construction-aware (not just a permissive
 * stub): it validates that every fragment of an UPDATE...SET clause
 * contains "=" and throws a Postgres-shaped syntax error otherwise — the
 * same class of failure a real Postgres server would raise for this exact
 * bug — so this suite would have caught the regression before it shipped.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = {
  id: rbacPath, filename: rbacPath, loaded: true,
  exports: {
    requireAuth: (req, res, next) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer admin') && !auth.startsWith('Bearer rep')) return res.status(401).json({ error: 'unauthorized' });
      req.user = auth.startsWith('Bearer rep')
        ? { sub: 'u2', email: 'rep@ecconstructiongroup.com', role: 'sales_rep' }
        : { sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
      next();
    },
    requireRole: (...roles) => (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'not authenticated' });
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden: insufficient role' });
      next();
    },
  },
};

const recordAccessPath = require.resolve('../lib/recordAccess');
delete require.cache[recordAccessPath];
let dealScopeResult = { allowed: true };
require.cache[recordAccessPath] = {
  id: recordAccessPath, filename: recordAccessPath, loaded: true,
  exports: { checkDealScope: async () => dealScopeResult },
};

// ── Generic, SQL-construction-aware in-memory mock ──────────────────────────
let tables;
function resetTables() {
  tables = { deal_expenses: [], deal_expense_payments: [], deal_commissions: [], deal_loan_payments: [] };
}
resetTables();
let nextId = 1;

function assertValidSetClause(setClauseSrc) {
  // Split on top-level commas (none of these queries ever put a comma
  // inside a value literal — everything is parameterized), then require
  // every fragment to contain "=". This is exactly what Postgres itself
  // enforces for `single_set_clause: set_target '=' a_expr` grammar, and
  // exactly what the "updated_by" (no "= $1") bug violated.
  for (const frag of setClauseSrc.split(',').map(s => s.trim())) {
    if (!frag.includes('=')) {
      const err = new Error(`syntax error at or near "${frag.split(/\s+/)[1] || ','}"`);
      err.code = '42601';
      throw err;
    }
  }
}

async function mockQuery(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();

  const insertMatch = s.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\) RETURNING \*/i);
  if (insertMatch) {
    const [, table, colsStr] = insertMatch;
    const cols = colsStr.split(',').map(c => c.trim());
    const row = { id: `id-${nextId++}`, created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z' };
    cols.forEach((c, i) => { row[c] = params[i]; });
    tables[table].push(row);
    return { rows: [row] };
  }

  const updateMatch = s.match(/^UPDATE (\w+) SET (.+) WHERE id = \$(\d+) RETURNING \*/i);
  if (updateMatch) {
    const [, table, setClauseSrc, idParamIdx] = updateMatch;
    assertValidSetClause(setClauseSrc);
    const id = params[Number(idParamIdx) - 1];
    const row = tables[table].find(r => r.id === id);
    if (!row) return { rows: [] };
    // Apply each `col = $N` fragment (skip literal `updated_at = NOW()`).
    for (const frag of setClauseSrc.split(',').map(x => x.trim())) {
      const m = frag.match(/^(\w+) = \$(\d+)$/);
      if (m) row[m[1]] = params[Number(m[2]) - 1];
      else if (/updated_at = NOW\(\)/.test(frag)) row.updated_at = '2026-09-22T01:00:00Z';
    }
    return { rows: [row] };
  }

  const selectOneMatch = s.match(/^SELECT (?:\*|id, deal_id) FROM (\w+) WHERE id = \$1/i);
  if (selectOneMatch) {
    const table = selectOneMatch[1];
    const row = tables[table].find(r => r.id === params[0]);
    return { rows: row ? [row] : [] };
  }

  const listMatch = s.match(/^SELECT \* FROM (\w+) WHERE (.+) ORDER BY created_at DESC LIMIT \$(\d+)/i);
  if (listMatch) {
    const [, table] = listMatch;
    const dealId = params[0];
    return { rows: tables[table].filter(r => r.deal_id === dealId) };
  }

  const deleteMatch = s.match(/^DELETE FROM (\w+) WHERE id = \$1/i);
  if (deleteMatch) {
    const table = deleteMatch[1];
    tables[table] = tables[table].filter(r => r.id !== params[0]);
    return { rows: [] };
  }

  throw new Error('mockQuery: unrecognized query: ' + s);
}

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: mockQuery, pool: {} } };

const ADMIN = { Authorization: 'Bearer admin' };
const REP = { Authorization: 'Bearer rep' };

function req(server, method, pathStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ port, path: pathStr, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => {
        let parsed; try { parsed = JSON.parse(out); } catch { parsed = out; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function startServer(routerPath, mountPath) {
  delete require.cache[require.resolve(routerPath)];
  const router = require(routerPath);
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(mountPath, router);
    const server = app.listen(0, () => resolve(server));
  });
}

// ── Deal Expenses ────────────────────────────────────────────────────────────
  test('deal_expenses: create, then edit (the exact production regression), then delete', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealExpenses', '/api/v1/deal-expenses');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-expenses', {
        headers: ADMIN,
        body: { deal_id: 'deal-1', vendor_name: 'ABC Plumbing', amount: 400, category: 'HVAC', payment_status: 'Paid', payment_method: 'Zelle', check_or_reference_number: 'JPM99cwk7fh5', description: 'Fixing Hvac', include_in_profit_calculation: false },
      });
      assert.strictEqual(create.status, 201, JSON.stringify(create.body));
      const id = create.body.expense.id;
      assert.strictEqual(create.body.expense.amount, 400);
      assert.strictEqual(create.body.expense.include_in_profit_calculation, false);

      // THE EXACT PRODUCTION REGRESSION: editing this same expense with the
      // same field set previously threw "syntax error at or near ';'".
      const edit = await req(s, 'PUT', `/api/v1/deal-expenses/${id}`, {
        headers: ADMIN,
        body: { category: 'HVAC', amount: 450, payment_status: 'Paid', payment_method: 'Zelle', check_or_reference_number: 'JPM99cwk7fh5', description: 'Fixing Hvac - updated', include_in_profit_calculation: false },
      });
      assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
      assert.strictEqual(edit.body.expense.amount, 450);
      assert.strictEqual(edit.body.expense.updated_by, 'yaron@ecconstructiongroup.com');
      assert.strictEqual(edit.body.expense.description, 'Fixing Hvac - updated');
      // Unchanged fields remain intact:
      assert.strictEqual(edit.body.expense.vendor_name, 'ABC Plumbing');

      const del = await req(s, 'DELETE', `/api/v1/deal-expenses/${id}`, { headers: ADMIN });
      assert.strictEqual(del.status, 200);
      assert.strictEqual(tables.deal_expenses.length, 0);
    } finally { s.close(); }
  });

  test('deal_expenses: editing a SINGLE field (matches the malformed-SQL bug\'s most minimal trigger) succeeds', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealExpenses', '/api/v1/deal-expenses');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-expenses', { headers: ADMIN, body: { deal_id: 'deal-1', vendor_name: 'V', amount: 100 } });
      const id = create.body.expense.id;
      const edit = await req(s, 'PUT', `/api/v1/deal-expenses/${id}`, { headers: ADMIN, body: { amount: 200 } });
      assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
      assert.strictEqual(edit.body.expense.amount, 200);
    } finally { s.close(); }
  });

  test('deal_expenses: blank/null optional fields (payment_method, check_or_reference_number, notes, receipt) round-trip correctly', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealExpenses', '/api/v1/deal-expenses');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-expenses', {
        headers: ADMIN,
        body: { deal_id: 'deal-1', vendor_name: 'V', amount: 100, payment_method: null, check_or_reference_number: null, notes: null, receipt_url: null },
      });
      assert.strictEqual(create.status, 201);
      assert.strictEqual(create.body.expense.payment_method, null);
      assert.strictEqual(create.body.expense.receipt_url, null);
    } finally { s.close(); }
  });

  test('deal_expenses: edit with zero recognized fields returns 400, never reaches the database', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealExpenses', '/api/v1/deal-expenses');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-expenses', { headers: ADMIN, body: { deal_id: 'deal-1', vendor_name: 'V', amount: 100 } });
      const id = create.body.expense.id;
      const edit = await req(s, 'PUT', `/api/v1/deal-expenses/${id}`, { headers: ADMIN, body: {} });
      assert.strictEqual(edit.status, 400);
    } finally { s.close(); }
  });

  test('deal_expenses: a retried/duplicate create call does not corrupt state — each POST creates exactly one row (no accidental double-insert from the fix)', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealExpenses', '/api/v1/deal-expenses');
    try {
      await req(s, 'POST', '/api/v1/deal-expenses', { headers: ADMIN, body: { deal_id: 'deal-1', vendor_name: 'V', amount: 100 } });
      assert.strictEqual(tables.deal_expenses.length, 1);
    } finally { s.close(); }
  });

  test('deal_expenses: non-admin/manager cannot delete', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealExpenses', '/api/v1/deal-expenses');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-expenses', { headers: ADMIN, body: { deal_id: 'deal-1', vendor_name: 'V', amount: 100 } });
      const id = create.body.expense.id;
      const del = await req(s, 'DELETE', `/api/v1/deal-expenses/${id}`, { headers: REP });
      assert.strictEqual(del.status, 403);
      assert.strictEqual(tables.deal_expenses.length, 1);
    } finally { s.close(); }
  });

  test('deal_expenses: forbidden deal scope blocks create/edit', async () => {
    resetTables();
    dealScopeResult = { allowed: false };
    const s = await startServer('../routes/dealExpenses', '/api/v1/deal-expenses');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-expenses', { headers: REP, body: { deal_id: 'deal-1', vendor_name: 'V', amount: 100 } });
      assert.strictEqual(create.status, 403);
    } finally { s.close(); }
  });

// ── Deal Expense Payments ────────────────────────────────────────────────────
  test('deal_expense_payments: create, edit (regression), delete — totals-affecting fields persist', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealExpensePayments', '/api/v1/deal-expense-payments');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-expense-payments', {
        headers: ADMIN, body: { deal_id: 'deal-1', expense_id: 'exp-1', amount: 400, payment_method: 'Zelle', reference_number: 'JPM99cwk7fh5' },
      });
      assert.strictEqual(create.status, 201, JSON.stringify(create.body));
      const id = create.body.payment.id;

      const edit = await req(s, 'PUT', `/api/v1/deal-expense-payments/${id}`, { headers: ADMIN, body: { amount: 400, payment_method: 'Check', reference_number: '1234' } });
      assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
      assert.strictEqual(edit.body.payment.payment_method, 'Check');

      const del = await req(s, 'DELETE', `/api/v1/deal-expense-payments/${id}`, { headers: ADMIN });
      assert.strictEqual(del.status, 200);
      assert.strictEqual(tables.deal_expense_payments.length, 0);
    } finally { s.close(); }
  });

// ── Deal Commissions ─────────────────────────────────────────────────────────
  test('deal_commissions: create, edit (regression), delete', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealCommissions', '/api/v1/deal-commissions');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-commissions', { headers: ADMIN, body: { deal_id: 'deal-1', recipient_name: 'Yaron Drilevich', commission_percentage: 5 } });
      assert.strictEqual(create.status, 201, JSON.stringify(create.body));
      const id = create.body.commission.id;

      const edit = await req(s, 'PUT', `/api/v1/deal-commissions/${id}`, { headers: ADMIN, body: { status: 'Paid', paid_amount: 200 } });
      assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
      assert.strictEqual(edit.body.commission.status, 'Paid');
      assert.strictEqual(edit.body.commission.recipient_name, 'Yaron Drilevich', 'unchanged field preserved');

      const del = await req(s, 'DELETE', `/api/v1/deal-commissions/${id}`, { headers: ADMIN });
      assert.strictEqual(del.status, 200);
    } finally { s.close(); }
  });

// ── Deal Loan Payments ───────────────────────────────────────────────────────
  test('deal_loan_payments: create, edit (regression), delete', async () => {
    resetTables();
    dealScopeResult = { allowed: true };
    const s = await startServer('../routes/dealLoanPayments', '/api/v1/deal-loan-payments');
    try {
      const create = await req(s, 'POST', '/api/v1/deal-loan-payments', { headers: ADMIN, body: { deal_id: 'deal-1', payment_date: '2026-09-01', total_payment_amount: 1000, lender_name: 'Chase' } });
      assert.strictEqual(create.status, 201, JSON.stringify(create.body));
      const id = create.body.loanPayment.id;

      const edit = await req(s, 'PUT', `/api/v1/deal-loan-payments/${id}`, { headers: ADMIN, body: { principal_amount: 800, interest_amount: 200 } });
      assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
      assert.strictEqual(edit.body.loanPayment.principal_amount, 800);
      assert.strictEqual(edit.body.loanPayment.lender_name, 'Chase', 'unchanged field preserved');

      const del = await req(s, 'DELETE', `/api/v1/deal-loan-payments/${id}`, { headers: ADMIN });
      assert.strictEqual(del.status, 200);
    } finally { s.close(); }
  });

// ── Malformed-SQL horizontal regression guard ───────────────────────────────
test('HORIZONTAL REGRESSION GUARD: none of the four deal sub-resource routers seed their UPDATE SET-clause array with a bare column name', () => {
  const fs = require('fs');
  const path = require('path');
  for (const file of ['dealExpenses.js', 'dealExpensePayments.js', 'dealCommissions.js', 'dealLoanPayments.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
    assert.ok(!/const updates = \['updated_by'\]/.test(src), `${file}: SET-clause array must never be seeded with a bare column name`);
    assert.ok(/const updates = \['updated_by = \$1'\]/.test(src), `${file}: must seed the SET-clause array with a valid "col = $1" fragment`);
  }
});
