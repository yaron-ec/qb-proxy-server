/* eslint-disable no-undef */
'use strict';

/**
 * financialCalcCostModel.test.js — regression tests for the Deal Financials
 * profitability/cost-model additions to crm-frontend/src/lib/financialCalc.js
 * (Part B of the product-design + Financials pass):
 *
 *   - classifyVendorExpenses: buckets deal_expenses into Subcontractor /
 *     Material / Other, each tracking committed (full amount, recognized
 *     regardless of payment_status) vs. paid (amount_paid so far).
 *   - computeFinancials: now also returns invoiced/balance (customer
 *     collections, canonical INVOICED - PAID meaning) and
 *     totalCommittedCost/totalPaidCost, additive to the existing
 *     totalRevenue/totalCosts/netProfit/profitMargin fields.
 *
 * These tests bundle the ACTUAL crm-frontend/src/lib/financialCalc.js with
 * esbuild (it has zero external imports — pure functions) so the real
 * production code runs, not a reimplementation.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

function loadFinancialCalc() {
  let esbuild;
  try { esbuild = require('esbuild'); } catch { throw new Error('esbuild not available — npm install esbuild'); }
  const srcPath = path.resolve(__dirname, '..', 'crm-frontend', 'src', 'lib', 'financialCalc.js');
  const result = esbuild.buildSync({
    entryPoints: [srcPath],
    bundle: false,
    write: false,
    format: 'cjs',
    platform: 'node',
  });
  const code = result.outputFiles[0].text;
  const tmpFile = path.join(os.tmpdir(), `financialCalc.test.${process.pid}.${Date.now()}.cjs`);
  fs.writeFileSync(tmpFile, code);
  try {
    delete require.cache[require.resolve(tmpFile)];
    return require(tmpFile);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

const { classifyVendorExpenses, computeFinancials } = loadFinancialCalc();

// ── classifyVendorExpenses ───────────────────────────────────────────────────

function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    throw e;
  }
}

test('classifyVendorExpenses: no expenses returns all-zero buckets', () => {
  const b = classifyVendorExpenses([]);
  assert.deepStrictEqual(b, {
    subcontractor: { committed: 0, paid: 0 },
    material: { committed: 0, paid: 0 },
    other: { committed: 0, paid: 0 },
  });
});

test('classifyVendorExpenses: a Subcontractor expense buckets under subcontractor', () => {
  const b = classifyVendorExpenses([{ category: 'Subcontractor', amount: 10000, amount_paid: 5000, payment_status: 'Partially Paid' }]);
  assert.strictEqual(b.subcontractor.committed, 10000, 'full committed amount recognized regardless of paid status');
  assert.strictEqual(b.subcontractor.paid, 5000);
  assert.strictEqual(b.material.committed, 0);
  assert.strictEqual(b.other.committed, 0);
});

test('classifyVendorExpenses: a Materials expense buckets under material', () => {
  const b = classifyVendorExpenses([{ category: 'Materials', amount: 3200, amount_paid: 3200, payment_status: 'Paid' }]);
  assert.strictEqual(b.material.committed, 3200);
  assert.strictEqual(b.material.paid, 3200);
});

test('classifyVendorExpenses: mixed subcontractor + material + other expenses', () => {
  const b = classifyVendorExpenses([
    { category: 'Subcontractor', amount: 10000, amount_paid: 10000, payment_status: 'Paid' },
    { category: 'Materials', amount: 3200, amount_paid: 0, payment_status: 'Unpaid' },
    { category: 'Permit', amount: 500, amount_paid: 500, payment_status: 'Paid' },
  ]);
  assert.strictEqual(b.subcontractor.committed, 10000);
  assert.strictEqual(b.material.committed, 3200);
  assert.strictEqual(b.material.paid, 0);
  assert.strictEqual(b.other.committed, 500);
});

test('classifyVendorExpenses: an unpaid committed expense counts fully toward committed, not paid', () => {
  const b = classifyVendorExpenses([{ category: 'Subcontractor', amount: 10000, amount_paid: 0, payment_status: 'Unpaid' }]);
  assert.strictEqual(b.subcontractor.committed, 10000);
  assert.strictEqual(b.subcontractor.paid, 0);
});

test('classifyVendorExpenses: Cancelled expenses are excluded entirely', () => {
  const b = classifyVendorExpenses([{ category: 'Subcontractor', amount: 10000, amount_paid: 0, payment_status: 'Cancelled' }]);
  assert.strictEqual(b.subcontractor.committed, 0);
});

test('classifyVendorExpenses: include_in_profit_calculation=false is excluded', () => {
  const b = classifyVendorExpenses([{ category: 'Materials', amount: 999, include_in_profit_calculation: false }]);
  assert.strictEqual(b.material.committed, 0);
});

test('classifyVendorExpenses: Refunded expenses subtract from their category', () => {
  const b = classifyVendorExpenses([
    { category: 'Materials', amount: 1000, amount_paid: 1000, payment_status: 'Paid' },
    { category: 'Materials', amount: 200, amount_paid: 0, payment_status: 'Refunded' },
  ]);
  assert.strictEqual(b.material.committed, 800);
});

// ── computeFinancials — profitability + collections ──────────────────────────

function baseArgs(overrides = {}) {
  return {
    deal: { amount: 50000 },
    lead: {},
    invoices: [],
    saleInvoices: null,
    expenses: [],
    commissions: [],
    loanPayments: [],
    waterfall: null,
    ...overrides,
  };
}

test('computeFinancials: no expenses — profit equals full contract value', () => {
  const fin = computeFinancials(baseArgs());
  assert.strictEqual(fin.totalRevenue, 50000);
  assert.strictEqual(fin.totalCosts, 0);
  assert.strictEqual(fin.totalCommittedCost, 0);
  assert.strictEqual(fin.netProfit, 50000);
  assert.strictEqual(fin.profitMargin, 100);
});

test('computeFinancials: subcontractor expense reduces profit by the full committed amount even when unpaid', () => {
  const fin = computeFinancials(baseArgs({
    expenses: [{ category: 'Subcontractor', amount: 10000, amount_paid: 0, payment_status: 'Unpaid' }],
  }));
  assert.strictEqual(fin.vendorBreakdown.subcontractor.committed, 10000);
  assert.strictEqual(fin.totalVendorExpenses, 10000);
  assert.strictEqual(fin.totalCosts, 10000);
  assert.strictEqual(fin.netProfit, 40000, 'an approved-but-unpaid cost must still reduce projected profit today');
  assert.strictEqual(fin.totalPaidCost, 0, 'nothing has actually been paid out yet');
});

test('computeFinancials: material expense fully paid contributes to both committed and paid cost', () => {
  const fin = computeFinancials(baseArgs({
    expenses: [{ category: 'Materials', amount: 3200, amount_paid: 3200, payment_status: 'Paid' }],
  }));
  assert.strictEqual(fin.vendorBreakdown.material.committed, 3200);
  assert.strictEqual(fin.totalPaidCost, 3200);
  assert.strictEqual(fin.netProfit, 46800);
});

test('computeFinancials: mixed subcontractor + material expenses', () => {
  const fin = computeFinancials(baseArgs({
    expenses: [
      { category: 'Subcontractor', amount: 10000, amount_paid: 10000, payment_status: 'Paid' },
      { category: 'Materials', amount: 3200, amount_paid: 3200, payment_status: 'Paid' },
    ],
  }));
  assert.strictEqual(fin.totalVendorExpenses, 13200);
  assert.strictEqual(fin.netProfit, 36800);
  assert.strictEqual(fin.profitMargin, 73.6);
});

test('computeFinancials: unpaid committed expense — profit reflects the committed cost, paid cost stays 0', () => {
  const fin = computeFinancials(baseArgs({
    expenses: [{ category: 'Subcontractor', amount: 10000, amount_paid: 0, payment_status: 'Unpaid' }],
  }));
  assert.strictEqual(fin.totalCommittedCost, 10000);
  assert.strictEqual(fin.totalPaidCost, 0);
});

test('computeFinancials: lead cost (percentage of contract) reduces profit', () => {
  const fin = computeFinancials(baseArgs({
    deal: { amount: 50000, lead_cost_type: 'percentage', lead_cost_percentage: 10, lead_cost_calculation_base: 'total_contract' },
  }));
  assert.strictEqual(fin.leadCostAmount, 5000);
  assert.strictEqual(fin.totalCosts, 5000);
  assert.strictEqual(fin.netProfit, 45000);
});

test('computeFinancials: sales commission reduces profit', () => {
  const fin = computeFinancials(baseArgs({
    commissions: [{ commission_type: 'percentage', commission_percentage: 5, calculation_base: 'total_contract', status: 'Approved', paid_amount: 0 }],
  }));
  assert.strictEqual(fin.salesCommissionAmount, 2500);
  assert.strictEqual(fin.netProfit, 47500);
});

test('computeFinancials: financing/loan cost (interest + fees) reduces profit, principal does not', () => {
  const fin = computeFinancials(baseArgs({
    loanPayments: [{ principal_amount: 4000, interest_amount: 300, fee_amount: 50, other_cost_amount: 0 }],
  }));
  assert.strictEqual(fin.totalLoanInterest, 350, 'principal is not a project cost — only interest/fees/other');
  assert.strictEqual(fin.netProfit, 49650);
  assert.strictEqual(fin.totalPaidCost, 350, 'loan payments are historical records of cash already paid');
});

test('computeFinancials: approved customer change order increases contract value, not cost', () => {
  const fin = computeFinancials(baseArgs({
    deal: { amount: 50000, financial_change_orders_amount: 5000 },
  }));
  assert.strictEqual(fin.contractAmount, 50000);
  assert.strictEqual(fin.changeOrders, 5000);
  assert.strictEqual(fin.totalRevenue, 55000, 'change orders increase CURRENT CONTRACT VALUE');
});

test('computeFinancials: multiple change orders accumulate into total revenue', () => {
  const fin = computeFinancials(baseArgs({
    deal: { amount: 50000, financial_change_orders_amount: 5000, financial_manual_revenue_adjustment: 1000 },
  }));
  assert.strictEqual(fin.totalRevenue, 56000);
});

test('computeFinancials: customer collections — invoiced-to-date is less than full project value (invoiced != paid != project value)', () => {
  // Project value $50,000; only $30,000 invoiced so far; $10,000 collected.
  // BALANCE (invoiced-unpaid) and REMAINING (still owed on the whole job)
  // must be two visibly different numbers, not the same field under two names.
  const fin = computeFinancials(baseArgs({
    deal: { amount: 50000 },
    invoices: [{ amount: 30000, payment_received: 10000 }],
  }));
  assert.strictEqual(fin.totalRevenue, 50000);
  assert.strictEqual(fin.invoiced, 30000);
  assert.strictEqual(fin.paymentsReceived, 10000);
  assert.strictEqual(fin.balance, 20000, 'BALANCE = INVOICED - PAID');
  assert.strictEqual(fin.remainingCustomerBalance, 40000, 'REMAINING = PROJECT VALUE - PAID');
});

test('computeFinancials: fully paid and fully invoiced project — balance and remaining both reach zero', () => {
  const fin = computeFinancials(baseArgs({
    deal: { amount: 50000 },
    invoices: [{ amount: 50000, payment_received: 50000 }],
  }));
  assert.strictEqual(fin.balance, 0);
  assert.strictEqual(fin.remainingCustomerBalance, 0);
});

test('computeFinancials: editing an expense (amount change) is reflected by recomputation — no stale cache', () => {
  const before = computeFinancials(baseArgs({
    expenses: [{ category: 'Subcontractor', amount: 10000, amount_paid: 0, payment_status: 'Unpaid' }],
  }));
  const after = computeFinancials(baseArgs({
    expenses: [{ category: 'Subcontractor', amount: 12000, amount_paid: 0, payment_status: 'Unpaid' }],
  }));
  assert.strictEqual(before.netProfit, 40000);
  assert.strictEqual(after.netProfit, 38000, 'editing the expense amount must change projected profit automatically');
});

test('computeFinancials: deleting an expense (empty list) removes its cost impact automatically', () => {
  const withExpense = computeFinancials(baseArgs({
    expenses: [{ category: 'Materials', amount: 3200, amount_paid: 3200, payment_status: 'Paid' }],
  }));
  const deleted = computeFinancials(baseArgs({ expenses: [] }));
  assert.strictEqual(withExpense.netProfit, 46800);
  assert.strictEqual(deleted.netProfit, 50000);
});

console.log('\n✅ All financialCalc cost-model tests passed');
