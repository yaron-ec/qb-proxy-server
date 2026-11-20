/* eslint-disable no-undef */
'use strict';

/**
 * financialCalcWaterfallPrecedence.test.js
 *
 * Regression tests for the waterfall precedence rule in
 * crm-frontend/src/lib/financialCalc.js#getDealPaymentSummary and
 * lib/customerPaymentWaterfall.js#allocateWaterfall — imported directly
 * (ESM dynamic import for the frontend module, plain require for the
 * backend one), never a hand-copied reimplementation. An earlier version
 * of this file duplicated both functions' logic inline, which let them
 * silently drift from the real implementation — exactly what happened:
 * the real file's sale-scoped branch was fixed differently (see below)
 * without this file's own copy ever reflecting it.
 *
 * ORIGINAL ROOT CAUSE (the "Rita Wing" bug, first fixed here): the
 * sale-scoped path returned early with sale-scoped paid whenever
 * saleInvoices existed, NEVER checking the waterfall — showing $0 paid
 * for a multi-deal customer whose invoice cache hadn't yet reflected a
 * received payment.
 *
 * SECOND ROOT CAUSE (the "Lalani" bug, fixed November 2026): the first
 * fix over-corrected — it let the waterfall ALWAYS win whenever applied,
 * even over a deal's own real, nonzero, directly-attributed paid amount.
 * A smaller addendum's own real paid figure was silently replaced by a
 * customer-level estimate (contract-size-capped) once the customer's
 * total received money exceeded that addendum's own contract amount.
 *
 * CURRENT, CORRECT RULE (satisfies both): in the sale-scoped path, the
 * deal's own direct paid sum wins whenever it is genuinely nonzero; the
 * waterfall is a fallback ONLY when that direct sum is still $0. The
 * legacy path (no sale-scoped invoices mapped at all) is unchanged —
 * waterfall wins there whenever applied, exactly as the original fix
 * established.
 *
 * Required cases:
 *   A. saleInvoices exist with $0 direct paid + waterfall exists → waterfall Paid wins
 *   B. no mapped saleInvoices + waterfall exists → waterfall Paid works
 *   C. waterfall error → UI does NOT falsely present authoritative Paid $0
 *   D. Dean: total 3058, allocated paid 3000, remaining 58, status NOT Unpaid
 *   E. Rita: customer total received 7500, allocation per deterministic Deal order
 *   F. multi-Deal rollover
 *   G. 3+ Deal rollover
 *   H. customer excess
 *   I. conservation: SUM allocated + excess = authoritative customer received
 *   J. Lalani-class: saleInvoices with a REAL nonzero direct paid amount
 *      must win over a conflicting waterfall estimate
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { allocateWaterfall } = require(path.join(__dirname, '..', 'lib', 'customerPaymentWaterfall'));

let getDealPaymentSummary;

test.before(async () => {
  const financialCalcPath = path.join(__dirname, '..', 'crm-frontend', 'src', 'lib', 'financialCalc.js');
  const mod = await import(`file://${financialCalcPath}`);
  getDealPaymentSummary = mod.getDealPaymentSummary;
});

test('A: saleInvoices exist with $0 direct paid + waterfall exists → waterfall paid wins', () => {
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const saleInvoices = [{ total_amt: 15000, paid: 0 }];
  const waterfall = { applied: true, this_deal_allocation: { deal_id: 'd1', project_total: 15000, allocated_paid: 7500, allocated_remaining: 7500, allocated_progress: 50 } };
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, waterfall);
  assert.strictEqual(fin.paid, 7500, 'waterfall paid takes precedence over sale-scoped paid=0');
  assert.strictEqual(fin.remaining, 7500, 'remaining uses waterfall allocated_remaining');
  assert.strictEqual(fin.pctPaid, 50, 'progress uses waterfall allocated_paid');
});

test('B: no mapped saleInvoices + waterfall exists → waterfall paid works', () => {
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const waterfall = { applied: true, this_deal_allocation: { deal_id: 'd1', project_total: 15000, allocated_paid: 7500, allocated_remaining: 7500, allocated_progress: 50 } };
  const fin = getDealPaymentSummary(deal, lead, [], null, waterfall);
  assert.strictEqual(fin.paid, 7500, 'waterfall paid takes precedence over lead.qb_payment_received=0');
  assert.strictEqual(fin.remaining, 7500, 'remaining uses waterfall allocated_remaining');
});

test('C: waterfall null → falls back to sale-scoped paid (not falsely presented as authoritative $0)', () => {
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const saleInvoices = [{ total_amt: 15000, paid: 0 }];
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, null);
  assert.strictEqual(fin.paid, 0, 'expected 0 (fallback) with no waterfall and $0 direct paid');
});

test('D: Dean — total 3058, allocated paid 3000, remaining 58, status not Unpaid', () => {
  const deal = { id: 'f9d092c4-f634-4290-85c4-05ec5f06567f', amount: 3058 };
  const lead = { qb_customer_id: '206', status: 'Sold' };
  const waterfall = { applied: true, customer_qb_customer_id: '206', customer_total_received: 3000, this_deal_allocation: { deal_id: 'f9d092c4-f634-4290-85c4-05ec5f06567f', project_total: 3058, allocated_paid: 3000, allocated_remaining: 58, allocated_progress: 98.10 } };
  const fin = getDealPaymentSummary(deal, lead, [], null, waterfall);
  assert.strictEqual(fin.paid, 3000);
  assert.strictEqual(fin.remaining, 58);
  assert.ok(Math.abs(fin.pctPaid - 98.1) < 0.1, 'expected ~98.1, got ' + fin.pctPaid);
  assert.ok(fin.paid > 0, 'paid should be > 0 (not Unpaid)');
});

test('E: Rita — customer total received 7500, allocation per deterministic Deal order', () => {
  const deals = [
    { id: 'deal-rita-1', amount: 5000, name: 'Rita Deal 1', sold_date: '2026-01-15' },
    { id: 'deal-rita-2', amount: 10000, name: 'Rita Deal 2', sold_date: '2026-03-20' },
  ];
  const r = allocateWaterfall(7500, deals);
  assert.strictEqual(r.allocations[0].allocated_paid, 5000, 'Rita deal-1 fully funded');
  assert.strictEqual(r.allocations[1].allocated_paid, 2500, 'Rita deal-2 rollover');
  assert.strictEqual(r.allocations[0].allocated_remaining, 0);
  assert.strictEqual(r.allocations[1].allocated_remaining, 7500);
  assert.strictEqual(r.customer_excess, 0);
});

test('F: multi-Deal rollover (2 deals)', () => {
  const deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }, { id: 'd2', amount: 15000, name: 'Deal 2' }];
  const r = allocateWaterfall(12000, deals);
  assert.strictEqual(r.allocations[0].allocated_paid, 10000);
  assert.strictEqual(r.allocations[1].allocated_paid, 2000);
  assert.strictEqual(r.customer_excess, 0);
});

test('G: 3+ Deal rollover', () => {
  const deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }, { id: 'd2', amount: 15000, name: 'Deal 2' }, { id: 'd3', amount: 5000, name: 'Deal 3' }];
  const r = allocateWaterfall(27000, deals);
  assert.strictEqual(r.allocations[0].allocated_paid, 10000);
  assert.strictEqual(r.allocations[1].allocated_paid, 15000);
  assert.strictEqual(r.allocations[2].allocated_paid, 2000);
  assert.strictEqual(r.customer_excess, 0);
});

test('H: customer excess', () => {
  const deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }, { id: 'd2', amount: 15000, name: 'Deal 2' }];
  const r = allocateWaterfall(30000, deals);
  assert.strictEqual(r.allocations[0].allocated_paid, 10000);
  assert.strictEqual(r.allocations[1].allocated_paid, 15000);
  assert.strictEqual(r.customer_excess, 5000);
});

test('I: conservation — SUM(allocated) + excess = authoritative customer received', () => {
  const deals = [{ id: 'd1', amount: 8000, name: 'Deal 1' }, { id: 'd2', amount: 12000, name: 'Deal 2' }, { id: 'd3', amount: 5000, name: 'Deal 3' }];
  const received = 18500;
  const r = allocateWaterfall(received, deals);
  const sumAllocated = r.allocations.reduce((s, a) => s + a.allocated_paid, 0);
  const total = Math.round((sumAllocated + r.customer_excess + Number.EPSILON) * 100) / 100;
  assert.strictEqual(total, received);
});

test('FALLBACK: sale-scoped paid used when waterfall not applied', () => {
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 5000 };
  const saleInvoices = [{ total_amt: 15000, paid: 5000 }];
  const waterfall = { applied: false, reason: 'no_qb_customer_id' };
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, waterfall);
  assert.strictEqual(fin.paid, 5000);
});

test('EDGE: waterfall applied but deal not in eligible list → direct $0 sale-scoped paid used', () => {
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const saleInvoices = [{ total_amt: 15000, paid: 0 }];
  const waterfall = { applied: true, this_deal_allocation: null };
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, waterfall);
  assert.strictEqual(fin.paid, 0, 'expected 0 (fallback) — no this_deal_allocation to use');
});

test('J: Lalani-class — a REAL nonzero direct paid amount wins over a conflicting waterfall estimate', () => {
  // The exact production shape: an addendum's OWN invoice shows a real,
  // specific $5,000 paid against its $7,934.35 contract, while the
  // customer-level waterfall (because a sibling deal already absorbed
  // most of the customer's total received money) would estimate this
  // addendum as paid $0 — the direct figure must win.
  const deal = { id: 'addendum-1', amount: 7934.35 };
  const lead = { qb_customer_id: '999', qb_invoice_id: 'inv-addendum', qb_invoice_amount: 7934.35, qb_payment_received: 0 };
  const saleInvoices = [{ total_amt: 7934.35, paid: 5000 }];
  const waterfall = { applied: true, this_deal_allocation: { deal_id: 'addendum-1', project_total: 7934.35, allocated_paid: 0, allocated_remaining: 7934.35, allocated_progress: 0 } };
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, waterfall);
  assert.strictEqual(fin.paid, 5000, 'the direct invoice\'s real paid amount must win over the waterfall\'s $0 estimate');
  assert.strictEqual(fin.remaining, Math.round((7934.35 - 5000 + Number.EPSILON) * 100) / 100);
  assert.notStrictEqual(fin.paid, 0, 'must never report $0 paid merely because a sibling deal absorbed the customer\'s total received money');
});
