'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/**
 * Regression test: Deal Detail envelope contract.
 *
 * The backend returns { deal: serializeDeal(row) } from GET /api/v1/deals/:id
 * and PUT /api/v1/deals/:id. The frontend MUST unwrap the envelope — using the
 * raw response as the deal object causes d.lead_id to be undefined, lead stays
 * null, and the page shows "Deal not found" even though the deal exists.
 *
 * This test verifies:
 * 1. The backend route wraps the response in { deal: ... }
 * 2. The frontend DealDetail.jsx unwraps the envelope
 * 3. The same contract holds for leads ({ lead: ... }) and sub-entities
 */

const ROOT = path.resolve(__dirname, '..');

test('BACKEND: deals route GET /:id returns { deal: ... } envelope', () => {
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/deals.js'), 'utf8');
  // The GET /:id handler must res.json({ deal: serializeDeal(deal) })
  assert.ok(routeSrc.includes("res.json({ deal: serializeDeal(deal) })"),
    'GET /:id must return { deal: serializeDeal(deal) }');
});

test('BACKEND: deals route PUT /:id returns { deal: ... } envelope', () => {
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/deals.js'), 'utf8');
  // The PUT /:id handler must res.json({ deal: serializeDeal(updated[0]) })
  assert.ok(routeSrc.includes("res.json({ deal: serializeDeal(updated[0]) })"),
    'PUT /:id must return { deal: serializeDeal(updated[0]) }');
});

test('BACKEND: leads route GET /:id returns { lead: ... } envelope', () => {
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/leads.js'), 'utf8');
  assert.ok(routeSrc.includes('res.json({ lead: serializeLead('),
    'GET /:id must return { lead: serializeLead(...) }');
});

test('FRONTEND: DealDetail.jsx unwraps { deal: ... } envelope from railwayDeals.get()', () => {
  const srcPath = path.join(ROOT, 'crm-frontend/src/pages/DealDetail.jsx');
  const src = fs.readFileSync(srcPath, 'utf8');
  // Must unwrap the deal envelope: const d = dealRes?.deal || dealRes
  assert.ok(src.includes('dealRes?.deal'), 'DealDetail must unwrap { deal: ... } from railwayDeals.get()');
  assert.ok(src.includes('leadRes?.lead'), 'DealDetail must unwrap { lead: ... } from railwayLeads.get()');
  assert.ok(src.includes('dealUpdateRes?.deal'), 'DealDetail must unwrap { deal: ... } from railwayDeals.update()');
  assert.ok(src.includes('leadUpdateRes?.lead'), 'DealDetail must unwrap { lead: ... } from railwayLeads.update()');
});

test('FRONTEND: FinancialsTab unwraps { deal: ... } envelope from railwayDeals.update()', () => {
  const srcPath = path.join(ROOT, 'crm-frontend/src/components/financials/FinancialsTab.jsx');
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.ok(src.includes('updateRes?.deal'), 'FinancialsTab must unwrap { deal: ... } from railwayDeals.update()');
});

test('FRONTEND: ExpensesSection unwraps { expense: ... } envelope from create()', () => {
  const srcPath = path.join(ROOT, 'crm-frontend/src/components/financials/ExpensesSection.jsx');
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.ok(src.includes('createRes?.expense'), 'ExpensesSection must unwrap { expense: ... } from create()');
});

test('FRONTEND: LoanPaymentsSection unwraps { loanPayment: ... } envelope from create()', () => {
  const srcPath = path.join(ROOT, 'crm-frontend/src/components/financials/LoanPaymentsSection.jsx');
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.ok(src.includes('createRes?.loanPayment'), 'LoanPaymentsSection must unwrap { loanPayment: ... } from create()');
});

test('BACKEND: deal sub-entity routes return correct envelopes', () => {
  const expenseRoute = fs.readFileSync(path.join(ROOT, 'routes/dealExpenses.js'), 'utf8');
  assert.ok(expenseRoute.includes('res.json({ expense:'), 'dealExpenses must return { expense: ... }');
  
  const commissionRoute = fs.readFileSync(path.join(ROOT, 'routes/dealCommissions.js'), 'utf8');
  assert.ok(commissionRoute.includes('res.json({ commission:'), 'dealCommissions must return { commission: ... }');
  
  const loanRoute = fs.readFileSync(path.join(ROOT, 'routes/dealLoanPayments.js'), 'utf8');
  assert.ok(loanRoute.includes('res.json({ loanPayment:'), 'dealLoanPayments must return { loanPayment: ... }');
  
  const invoiceRoute = fs.readFileSync(path.join(ROOT, 'routes/invoices.js'), 'utf8');
  assert.ok(invoiceRoute.includes('res.json({ invoice:'), 'invoices must return { invoice: ... }');
});

test('BACKEND: all list endpoints return { items: [...], total: N }', () => {
  const dealsRoute = fs.readFileSync(path.join(ROOT, 'routes/deals.js'), 'utf8');
  assert.ok(dealsRoute.includes('res.json({ items: rows.map(serializeDeal), total:'), 'deals list must return { items, total }');
  
  const expensesRoute = fs.readFileSync(path.join(ROOT, 'routes/dealExpenses.js'), 'utf8');
  assert.ok(expensesRoute.includes('res.json({ items: rows.map(serializeExpense), total:'), 'dealExpenses list must return { items, total }');
  
  const invoicesRoute = fs.readFileSync(path.join(ROOT, 'routes/invoices.js'), 'utf8');
  assert.ok(invoicesRoute.includes('res.json({ items: rows.map(serializeInvoice), total:'), 'invoices list must return { items, total }');
});
