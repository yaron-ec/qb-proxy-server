/* eslint-disable no-undef */
'use strict';

/**
 * dealFinancialsConsolidation.test.js — regression guard for the Deal Detail
 * "Financial" vs "Financials" tab consolidation (product-design pass).
 *
 * ORIGINAL DEFECT: crm-frontend/src/pages/DealDetail.jsx rendered TWO
 * separate, independently-built financial tabs with near-identical names —
 * "Financial" (customer collections KPIs, payment schedule, QuickBooks
 * panel) and "Financials" (cost/profitability breakdown) — with no way for
 * a user to know which one answered which question. Neither tab was
 * role-gated at the TabBar level; "Financial" showed collections data to
 * every role, "Financials" restricted cost/profit data to admin/manager.
 *
 * FIX: one "Financials" tab (components/financials/FinancialsTab.jsx) that
 * contains both concepts — profitability (admin/manager only) and customer
 * collections (every role, including sales_rep) — preserving the same
 * visibility boundary the two separate tabs used to enforce independently.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function readFile(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', 'crm-frontend', 'src', rel), 'utf8');
}

test('DealDetail.jsx defines exactly one Financials tab (no duplicate "Financial"/"Financials" pair)', () => {
  const src = readFile('pages/DealDetail.jsx');
  const idMatches = src.match(/id:\s*"financials?"/g) || [];
  assert.strictEqual(idMatches.length, 1, 'expected exactly one financial* tab id in TABS, found: ' + JSON.stringify(idMatches));
  assert.ok(!fs.existsSync(path.resolve(__dirname, '..', 'crm-frontend', 'src', 'components', 'dealdetail', 'FinancialTab.jsx')), 'the old duplicate dealdetail/FinancialTab.jsx must be removed, not left orphaned');
});

test('DealDetail.jsx passes setLead/refreshLead to the consolidated FinancialsTab (needed for the merged QuickBooks/collections panel)', () => {
  const src = readFile('pages/DealDetail.jsx');
  const renderLine = src.slice(src.indexOf('activeTab === "financials"'), src.indexOf('activeTab === "financials"') + 300);
  assert.ok(renderLine.includes('setLead={setLead}'), 'FinancialsTab must receive setLead');
  assert.ok(renderLine.includes('refreshLead={refreshLead}'), 'FinancialsTab must receive refreshLead');
});

test('FinancialsTab.jsx shows CustomerCollections to sales_rep but withholds ProfitabilitySummary/CostBreakdown', () => {
  const src = readFile('components/financials/FinancialsTab.jsx');
  const salesRepBranch = src.slice(src.indexOf('if (isSalesRep)'), src.indexOf('return (\n    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">\n      {/*'));
  assert.ok(salesRepBranch.includes('<CustomerCollections'), 'sales_rep must still see customer collections (previously the "Financial" tab, visible to every role)');
  assert.ok(!salesRepBranch.includes('<ProfitabilitySummary'), 'sales_rep must not see job profitability/margin');
  assert.ok(!salesRepBranch.includes('<CostBreakdown'), 'sales_rep must not see the cost breakdown');
  assert.ok(salesRepBranch.includes('<CommissionSection'), 'sales_rep must still see their own commission');
});

test('FinancialsTab.jsx shows the full profitability picture to admin/manager', () => {
  const src = readFile('components/financials/FinancialsTab.jsx');
  const fullBranch = src.slice(src.indexOf('return (\n    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">\n      {/*'));
  for (const comp of ['ProfitabilitySummary', 'CustomerCollections', 'CostBreakdown', 'ExpensesSection', 'RevenueSection', 'LeadCostSection', 'CommissionSection', 'LoanPaymentsSection']) {
    assert.ok(fullBranch.includes(`<${comp}`), `admin/manager view must render ${comp}`);
  }
});

test('computeFinancials results feed CustomerCollections with canonical field names (invoiced/balance/remaining, never re-derived ad hoc in JSX)', () => {
  const src = readFile('components/financials/CustomerCollections.jsx');
  assert.ok(src.includes('fin.invoiced'));
  assert.ok(src.includes('fin.balance'));
  assert.ok(src.includes('fin.remainingCustomerBalance'));
  assert.ok(!/fin\.invoiced\s*-\s*fin\.paymentsReceived/.test(src), 'balance must come from computeFinancials, not be recomputed inline in the component');
});
