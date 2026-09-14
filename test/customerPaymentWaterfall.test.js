/* eslint-disable no-undef */
'use strict';

/**
 * customerPaymentWaterfall.test.js — System-wide customer payment waterfall tests.
 *
 * Verifies the business rule: customer-level QB received money is allocated
 * across eligible Deals sequentially in chronological order.
 *
 * Tests the PURE allocateWaterfall function (no DB) plus the ordering logic.
 */
const { allocateWaterfall, round2 } = require('../lib/customerPaymentWaterfall');

function approxEqual(a, b, eps) {
  eps = eps || 0.01;
  return Math.abs(Number(a) - Number(b)) < eps;
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// 1. Single deal, full allocation
test('single_deal_full_allocation', function () {
  var deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }];
  var r = allocateWaterfall(10000, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 10000), 'paid should be 10000');
  assert(approxEqual(r.allocations[0].allocated_remaining, 0), 'remaining should be 0');
  assert(approxEqual(r.allocations[0].allocated_progress, 100), 'progress should be 100');
  assert(approxEqual(r.customer_excess, 0), 'excess should be 0');
});

// 2. Single deal, partial allocation (Dean regression)
test('single_deal_partial_allocation', function () {
  var deals = [{ id: 'd1', amount: 3058, name: 'Dean Deal' }];
  var r = allocateWaterfall(3000, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 3000), 'paid should be 3000');
  assert(approxEqual(r.allocations[0].allocated_remaining, 58), 'remaining should be 58');
  assert(approxEqual(r.allocations[0].allocated_progress, 98.10, 0.05), 'progress should be ~98.10');
  assert(approxEqual(r.customer_excess, 0), 'excess should be 0');
});

// 3. Two deals, rollover
test('two_deals_rollover', function () {
  var deals = [
    { id: 'd1', amount: 10000, name: 'Deal 1' },
    { id: 'd2', amount: 15000, name: 'Deal 2' },
  ];
  var r = allocateWaterfall(12000, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 10000), 'deal1 paid should be 10000');
  assert(approxEqual(r.allocations[0].allocated_progress, 100), 'deal1 progress should be 100');
  assert(approxEqual(r.allocations[1].allocated_paid, 2000), 'deal2 paid should be 2000');
  assert(approxEqual(r.allocations[1].allocated_progress, 13.33, 0.05), 'deal2 progress should be ~13.33');
  assert(approxEqual(r.customer_excess, 0), 'excess should be 0');
});

// 4. Three deals, rollover
test('three_deals_rollover', function () {
  var deals = [
    { id: 'd1', amount: 10000, name: 'Deal 1' },
    { id: 'd2', amount: 15000, name: 'Deal 2' },
    { id: 'd3', amount: 5000, name: 'Deal 3' },
  ];
  var r = allocateWaterfall(27000, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 10000), 'deal1 paid should be 10000');
  assert(approxEqual(r.allocations[1].allocated_paid, 15000), 'deal2 paid should be 15000');
  assert(approxEqual(r.allocations[2].allocated_paid, 2000), 'deal3 paid should be 2000');
  assert(approxEqual(r.customer_excess, 0), 'excess should be 0');
});

// 5. Excess payment beyond all deals
test('excess_payment_beyond_all_deals', function () {
  var deals = [
    { id: 'd1', amount: 10000, name: 'Deal 1' },
    { id: 'd2', amount: 15000, name: 'Deal 2' },
  ];
  var r = allocateWaterfall(30000, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 10000), 'deal1 paid should be 10000');
  assert(approxEqual(r.allocations[1].allocated_paid, 15000), 'deal2 paid should be 15000');
  assert(approxEqual(r.customer_excess, 5000), 'excess should be 5000');
});

// 6. Partial first deal
test('partial_first_deal', function () {
  var deals = [
    { id: 'd1', amount: 10000, name: 'Deal 1' },
    { id: 'd2', amount: 15000, name: 'Deal 2' },
  ];
  var r = allocateWaterfall(7000, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 7000), 'deal1 paid should be 7000');
  assert(approxEqual(r.allocations[0].allocated_progress, 70), 'deal1 progress should be 70');
  assert(approxEqual(r.allocations[1].allocated_paid, 0), 'deal2 paid should be 0');
  assert(approxEqual(r.customer_excess, 0), 'excess should be 0');
});

// 7. Unpaid invoices only (zero received)
test('unpaid_invoices_only', function () {
  var deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }];
  var r = allocateWaterfall(0, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 0), 'paid should be 0');
  assert(approxEqual(r.allocations[0].allocated_remaining, 10000), 'remaining should be 10000');
  assert(approxEqual(r.allocations[0].allocated_progress, 0), 'progress should be 0');
});

// 8. Zero-amount deal excluded
test('zero_amount_deal_excluded', function () {
  var deals = [
    { id: 'd1', amount: 10000, name: 'Deal 1' },
    { id: 'd2', amount: 0, name: 'Deal 2' },
  ];
  var r = allocateWaterfall(10000, deals);
  assert(approxEqual(r.allocations[0].allocated_paid, 10000), 'deal1 paid should be 10000');
  assert(approxEqual(r.allocations[1].allocated_paid, 0), 'deal2 paid should be 0 (excluded)');
  assert(approxEqual(r.allocations[1].allocated_progress, 0), 'deal2 progress should be 0');
});

// 9. Idempotent rerun
test('idempotent_rerun', function () {
  var deals = [
    { id: 'd1', amount: 10000, name: 'Deal 1' },
    { id: 'd2', amount: 15000, name: 'Deal 2' },
  ];
  var r1 = allocateWaterfall(12000, deals);
  var r2 = allocateWaterfall(12000, deals);
  assert(JSON.stringify(r1) === JSON.stringify(r2), 'reruns should produce identical results');
});

// 10. Percentage precision preserved (not rounded to integer)
test('percentage_precision_preserved', function () {
  var deals = [{ id: 'd1', amount: 15000, name: 'Deal 1' }];
  var r = allocateWaterfall(2000, deals);
  // 2000/15000 = 13.333...% — must NOT be rounded to 13
  assert(approxEqual(r.allocations[0].allocated_progress, 13.33, 0.05), 'progress should be ~13.33, not 13');
  assert(r.allocations[0].allocated_progress !== 13, 'progress must not be integer-rounded');
});

// 11. No deal receives more than its project total
test('no_deal_exceeds_project_total', function () {
  var deals = [
    { id: 'd1', amount: 5000, name: 'Deal 1' },
    { id: 'd2', amount: 3000, name: 'Deal 2' },
  ];
  var r = allocateWaterfall(99999, deals);
  assert(r.allocations[0].allocated_paid <= 5000, 'deal1 must not exceed 5000');
  assert(r.allocations[1].allocated_paid <= 3000, 'deal2 must not exceed 3000');
});

// 12. No negative remaining
test('no_negative_remaining', function () {
  var deals = [
    { id: 'd1', amount: 1000, name: 'Deal 1' },
    { id: 'd2', amount: 2000, name: 'Deal 2' },
  ];
  var r = allocateWaterfall(50000, deals);
  for (var i = 0; i < r.allocations.length; i++) {
    assert(r.allocations[i].allocated_remaining >= 0, 'remaining must be non-negative');
  }
});

// 13. Conservation: SUM(allocated_paid) + excess = customer_total_received
test('conservation_of_funds', function () {
  var deals = [
    { id: 'd1', amount: 10000, name: 'Deal 1' },
    { id: 'd2', amount: 15000, name: 'Deal 2' },
    { id: 'd3', amount: 5000, name: 'Deal 3' },
  ];
  var totalReceived = 27000;
  var r = allocateWaterfall(totalReceived, deals);
  var sumAllocated = r.allocations.reduce(function (s, a) { return s + a.allocated_paid; }, 0);
  var total = round2(sumAllocated + r.customer_excess);
  assert(approxEqual(total, totalReceived), 'SUM(allocated) + excess must equal total received: got ' + total + ' expected ' + totalReceived);
});

// 14. Empty deals array
test('empty_deals_array', function () {
  var r = allocateWaterfall(5000, []);
  assert(approxEqual(r.customer_excess, 5000), 'all received should be excess');
  assert(r.allocations.length === 0, 'no allocations');
});

// 15. Null deals
test('null_deals', function () {
  var r = allocateWaterfall(5000, null);
  assert(approxEqual(r.customer_excess, 5000), 'all received should be excess');
});

// Run all tests
var passed = 0, failed = 0;
for (var i = 0; i < tests.length; i++) {
  try {
    tests[i].fn();
    console.log('  \u2713 ' + tests[i].name);
    passed++;
  } catch (e) {
    console.error('  \u2717 ' + tests[i].name + ': ' + e.message);
    failed++;
  }
}
console.log('\\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
