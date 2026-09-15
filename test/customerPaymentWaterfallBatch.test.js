/* eslint-disable no-undef */
'use strict';

/**
 * customerPaymentWaterfallBatch.test.js
 *
 * Tests the BATCHED waterfall data-fetching functions:
 *   getCustomerTotalReceivedBatch
 *   getEligibleDealsForCustomersBatch
 *
 * Verifies they produce IDENTICAL results to the per-customer functions,
 * and that the batched deals route enrichment pattern is correct.
 *
 * Uses mock DB (no real database connection).
 */
const {
  allocateWaterfall,
  round2,
  getCustomerTotalReceivedBatch,
  getEligibleDealsForCustomersBatch,
} = require('../lib/customerPaymentWaterfall');

function approxEqual(a, b, eps) {
  eps = eps || 0.01;
  return Math.abs(Number(a) - Number(b)) < eps;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── Mock DB ──────────────────────────────────────────────────────────────
function makeMockDb(invoices, deals, leads) {
  return {
    query: async function (sql, params) {
      sql = sql.replace(/\s+/g, ' ').trim();

      if (sql.indexOf('FROM qb_invoices_cache') >= 0 && sql.indexOf('GROUP BY qb_customer_id') >= 0) {
        var ids = params[0];
        var byCust = {};
        for (var i = 0; i < invoices.length; i++) {
          var inv = invoices[i];
          if (ids.indexOf(String(inv.qb_customer_id)) < 0) continue;
          if (inv.voided) continue;
          if (!byCust[inv.qb_customer_id]) byCust[inv.qb_customer_id] = 0;
          byCust[inv.qb_customer_id] += Number(inv.paid) || 0;
        }
        var rows = [];
        for (var cid in byCust) rows.push({ qb_customer_id: cid, total: byCust[cid] });
        return { rows: rows };
      }

      if (sql.indexOf('FROM deals d') >= 0 && sql.indexOf('JOIN leads l') >= 0 && sql.indexOf('ANY') >= 0) {
        var ids = params[0];
        var rows = [];
        for (var i = 0; i < deals.length; i++) {
          var d = deals[i];
          var lead = leads.find(function (l) { return l.id === d.lead_id; });
          if (!lead) continue;
          if (ids.indexOf(String(lead.qb_customer_id)) < 0) continue;
          if (!d.amount || d.amount <= 0) continue;
          if (lead.status === 'Lost' || lead.status === 'DNQ') continue;
          rows.push({ id: d.id, amount: d.amount, sold_date: d.sold_date, created_at: d.created_at, name: d.name, qb_customer_id: lead.qb_customer_id });
        }
        rows.sort(function (a, b) {
          if (a.qb_customer_id !== b.qb_customer_id) return a.qb_customer_id < b.qb_customer_id ? -1 : 1;
          var aDate = a.sold_date || a.created_at;
          var bDate = b.sold_date || b.created_at;
          if (aDate !== bDate) return aDate < bDate ? -1 : 1;
          return a.id < b.id ? -1 : 1;
        });
        return { rows: rows };
      }

      return { rows: [] };
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

test('batched_received_totals_excludes_voided', async function () {
  var invoices = [
    { qb_customer_id: 'QB1', paid: 5000, voided: false },
    { qb_customer_id: 'QB1', paid: 3000, voided: false },
    { qb_customer_id: 'QB1', paid: 9999, voided: true },
    { qb_customer_id: 'QB2', paid: 7000, voided: false },
    { qb_customer_id: 'QB3', paid: 0, voided: false },
  ];
  var db = makeMockDb(invoices, [], []);
  var map = await getCustomerTotalReceivedBatch(db, ['QB1', 'QB2', 'QB3', 'QB_NOPE']);
  assert(approxEqual(map.get('QB1'), 8000), 'QB1 should be 8000 (voided excluded)');
  assert(approxEqual(map.get('QB2'), 7000), 'QB2 should be 7000');
  assert(approxEqual(map.get('QB3'), 0), 'QB3 should be 0');
  assert(!map.has('QB_NOPE'), 'QB_NOPE should not be in map');
});

test('batched_received_empty_input', async function () {
  var db = makeMockDb([], [], []);
  var map = await getCustomerTotalReceivedBatch(db, []);
  assert(map.size === 0, 'empty input should return empty map');
  var map2 = await getCustomerTotalReceivedBatch(db, null);
  assert(map2.size === 0, 'null input should return empty map');
});

test('batched_eligible_deals_chronological_order', async function () {
  var leads = [
    { id: 'L1', qb_customer_id: 'QB1', status: 'Sold' },
    { id: 'L2', qb_customer_id: 'QB1', status: 'Sold' },
  ];
  var deals = [
    { id: 'd2', lead_id: 'L2', amount: 15000, sold_date: '2026-02-01', created_at: '2026-01-15', name: 'Deal 2' },
    { id: 'd1', lead_id: 'L1', amount: 10000, sold_date: '2026-01-01', created_at: '2026-01-10', name: 'Deal 1' },
    { id: 'd3', lead_id: 'L1', amount: 5000, sold_date: null, created_at: '2026-01-05', name: 'Deal 3' },
  ];
  var db = makeMockDb([], deals, leads);
  var map = await getEligibleDealsForCustomersBatch(db, ['QB1']);
  var qb1Deals = map.get('QB1');
  assert(qb1Deals.length === 3, 'should have 3 eligible deals');
  assert(qb1Deals[0].id === 'd3', 'first should be d3 (created_at fallback)');
  assert(qb1Deals[1].id === 'd1', 'second should be d1');
  assert(qb1Deals[2].id === 'd2', 'third should be d2');
});

test('batched_eligible_deals_excludes_zero_and_lost', async function () {
  var leads = [
    { id: 'L1', qb_customer_id: 'QB1', status: 'Sold' },
    { id: 'L2', qb_customer_id: 'QB1', status: 'Lost' },
    { id: 'L3', qb_customer_id: 'QB1', status: 'DNQ' },
  ];
  var deals = [
    { id: 'd1', lead_id: 'L1', amount: 10000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'D1' },
    { id: 'd2', lead_id: 'L2', amount: 20000, sold_date: '2026-02-01', created_at: '2026-02-01', name: 'D2' },
    { id: 'd3', lead_id: 'L3', amount: 0, sold_date: '2026-03-01', created_at: '2026-03-01', name: 'D3' },
  ];
  var db = makeMockDb([], deals, leads);
  var map = await getEligibleDealsForCustomersBatch(db, ['QB1']);
  var qb1Deals = map.get('QB1');
  assert(qb1Deals.length === 1, 'only 1 eligible deal');
  assert(qb1Deals[0].id === 'd1', 'should be d1');
});

test('batched_eligible_deals_no_cross_customer_leakage', async function () {
  var leads = [
    { id: 'L1', qb_customer_id: 'QB1', status: 'Sold' },
    { id: 'L2', qb_customer_id: 'QB2', status: 'Sold' },
  ];
  var deals = [
    { id: 'd1', lead_id: 'L1', amount: 10000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'D1' },
    { id: 'd2', lead_id: 'L2', amount: 20000, sold_date: '2026-02-01', created_at: '2026-02-01', name: 'D2' },
  ];
  var db = makeMockDb([], deals, leads);
  var map = await getEligibleDealsForCustomersBatch(db, ['QB1', 'QB2']);
  assert(map.get('QB1').length === 1, 'QB1 has 1 deal');
  assert(map.get('QB1')[0].id === 'd1', 'QB1 deal is d1');
  assert(map.get('QB2').length === 1, 'QB2 has 1 deal');
  assert(map.get('QB2')[0].id === 'd2', 'QB2 deal is d2');
});

test('batched_waterfall_dean_single_deal_partial', async function () {
  var leads = [{ id: 'L1', qb_customer_id: 'QB_DEAN', status: 'Sold' }];
  var deals = [{ id: 'd_dean', lead_id: 'L1', amount: 3058, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'Dean' }];
  var invoices = [{ qb_customer_id: 'QB_DEAN', paid: 3000, voided: false }];
  var db = makeMockDb(invoices, deals, leads);
  var receivedMap = await getCustomerTotalReceivedBatch(db, ['QB_DEAN']);
  var dealsMap = await getEligibleDealsForCustomersBatch(db, ['QB_DEAN']);
  var result = allocateWaterfall(receivedMap.get('QB_DEAN'), dealsMap.get('QB_DEAN'));
  assert(approxEqual(result.allocations[0].allocated_paid, 3000), 'Dean paid should be 3000');
  assert(approxEqual(result.allocations[0].allocated_remaining, 58), 'Dean remaining should be 58');
  assert(approxEqual(result.customer_excess, 0), 'excess should be 0');
});

test('batched_waterfall_rita_two_deals_rollover', async function () {
  var leads = [
    { id: 'L1', qb_customer_id: 'QB_RITA', status: 'Sold' },
    { id: 'L2', qb_customer_id: 'QB_RITA', status: 'Sold' },
  ];
  var deals = [
    { id: 'r1', lead_id: 'L1', amount: 10000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'Rita 1' },
    { id: 'r2', lead_id: 'L2', amount: 15000, sold_date: '2026-03-01', created_at: '2026-03-01', name: 'Rita 2' },
  ];
  var invoices = [{ qb_customer_id: 'QB_RITA', paid: 12000, voided: false }];
  var db = makeMockDb(invoices, deals, leads);
  var receivedMap = await getCustomerTotalReceivedBatch(db, ['QB_RITA']);
  var dealsMap = await getEligibleDealsForCustomersBatch(db, ['QB_RITA']);
  var result = allocateWaterfall(receivedMap.get('QB_RITA'), dealsMap.get('QB_RITA'));
  assert(approxEqual(result.allocations[0].allocated_paid, 10000), 'Rita deal1 fully paid');
  assert(approxEqual(result.allocations[1].allocated_paid, 2000), 'Rita deal2 partial 2000');
  assert(approxEqual(result.customer_excess, 0), 'no excess');
});

test('batched_waterfall_joann_three_deals_excess', async function () {
  var leads = [
    { id: 'L1', qb_customer_id: 'QB_JOANN', status: 'Sold' },
    { id: 'L2', qb_customer_id: 'QB_JOANN', status: 'Sold' },
    { id: 'L3', qb_customer_id: 'QB_JOANN', status: 'Sold' },
  ];
  var deals = [
    { id: 'j1', lead_id: 'L1', amount: 10000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'Joann 1' },
    { id: 'j2', lead_id: 'L2', amount: 15000, sold_date: '2026-02-01', created_at: '2026-02-01', name: 'Joann 2' },
    { id: 'j3', lead_id: 'L3', amount: 5000, sold_date: '2026-03-01', created_at: '2026-03-01', name: 'Joann 3' },
  ];
  var invoices = [{ qb_customer_id: 'QB_JOANN', paid: 32000, voided: false }];
  var db = makeMockDb(invoices, deals, leads);
  var receivedMap = await getCustomerTotalReceivedBatch(db, ['QB_JOANN']);
  var dealsMap = await getEligibleDealsForCustomersBatch(db, ['QB_JOANN']);
  var result = allocateWaterfall(receivedMap.get('QB_JOANN'), dealsMap.get('QB_JOANN'));
  assert(approxEqual(result.allocations[0].allocated_paid, 10000), 'Joann deal1 fully paid');
  assert(approxEqual(result.allocations[1].allocated_paid, 15000), 'Joann deal2 fully paid');
  assert(approxEqual(result.allocations[2].allocated_paid, 5000), 'Joann deal3 fully paid');
  assert(approxEqual(result.customer_excess, 2000), 'excess 2000');
});

test('batched_waterfall_customer_no_qb_id', async function () {
  var db = makeMockDb([], [], []);
  var receivedMap = await getCustomerTotalReceivedBatch(db, []);
  var dealsMap = await getEligibleDealsForCustomersBatch(db, []);
  assert(receivedMap.size === 0, 'empty received map');
  assert(dealsMap.size === 0, 'empty deals map');
});

test('batched_waterfall_customer_no_received', async function () {
  var leads = [{ id: 'L1', qb_customer_id: 'QB_NOMONEY', status: 'Sold' }];
  var deals = [{ id: 'd1', lead_id: 'L1', amount: 10000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'D1' }];
  var invoices = [];
  var db = makeMockDb(invoices, deals, leads);
  var receivedMap = await getCustomerTotalReceivedBatch(db, ['QB_NOMONEY']);
  var dealsMap = await getEligibleDealsForCustomersBatch(db, ['QB_NOMONEY']);
  var result = allocateWaterfall(receivedMap.get('QB_NOMONEY') || 0, dealsMap.get('QB_NOMONEY'));
  assert(approxEqual(result.allocations[0].allocated_paid, 0), 'no received → 0 paid');
  assert(approxEqual(result.allocations[0].allocated_remaining, 10000), 'remaining = full amount');
});

test('batched_invariant_sum_plus_excess_equals_received', async function () {
  var leads = [
    { id: 'L1', qb_customer_id: 'QB_INV', status: 'Sold' },
    { id: 'L2', qb_customer_id: 'QB_INV', status: 'Sold' },
    { id: 'L3', qb_customer_id: 'QB_INV', status: 'Sold' },
  ];
  var deals = [
    { id: 'i1', lead_id: 'L1', amount: 8000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'I1' },
    { id: 'i2', lead_id: 'L2', amount: 12000, sold_date: '2026-02-01', created_at: '2026-02-01', name: 'I2' },
    { id: 'i3', lead_id: 'L3', amount: 4000, sold_date: '2026-03-01', created_at: '2026-03-01', name: 'I3' },
  ];
  var received = 19500;
  var invoices = [{ qb_customer_id: 'QB_INV', paid: received, voided: false }];
  var db = makeMockDb(invoices, deals, leads);
  var receivedMap = await getCustomerTotalReceivedBatch(db, ['QB_INV']);
  var dealsMap = await getEligibleDealsForCustomersBatch(db, ['QB_INV']);
  var result = allocateWaterfall(receivedMap.get('QB_INV'), dealsMap.get('QB_INV'));
  var sumPaid = result.allocations.reduce(function (s, a) { return s + a.allocated_paid; }, 0);
  var total = round2(sumPaid + result.customer_excess);
  assert(approxEqual(total, received), 'SUM(paid) + excess = received: ' + total + ' = ' + received);
});

test('batched_multiple_customers_no_contamination', async function () {
  var leads = [
    { id: 'L1', qb_customer_id: 'QB_A', status: 'Sold' },
    { id: 'L2', qb_customer_id: 'QB_B', status: 'Sold' },
    { id: 'L3', qb_customer_id: 'QB_A', status: 'Sold' },
  ];
  var deals = [
    { id: 'a1', lead_id: 'L1', amount: 5000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'A1' },
    { id: 'b1', lead_id: 'L2', amount: 7000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'B1' },
    { id: 'a2', lead_id: 'L3', amount: 3000, sold_date: '2026-02-01', created_at: '2026-02-01', name: 'A2' },
  ];
  var invoices = [
    { qb_customer_id: 'QB_A', paid: 6000, voided: false },
    { qb_customer_id: 'QB_B', paid: 7000, voided: false },
  ];
  var db = makeMockDb(invoices, deals, leads);
  var receivedMap = await getCustomerTotalReceivedBatch(db, ['QB_A', 'QB_B']);
  var dealsMap = await getEligibleDealsForCustomersBatch(db, ['QB_A', 'QB_B']);
  var resultA = allocateWaterfall(receivedMap.get('QB_A'), dealsMap.get('QB_A'));
  var resultB = allocateWaterfall(receivedMap.get('QB_B'), dealsMap.get('QB_B'));
  assert(approxEqual(resultA.allocations[0].allocated_paid, 5000), 'A1 fully paid');
  assert(approxEqual(resultA.allocations[1].allocated_paid, 1000), 'A2 partial 1000');
  assert(approxEqual(resultB.allocations[0].allocated_paid, 7000), 'B1 fully paid');
});

test('batched_parity_with_per_customer', async function () {
  var deals = [
    { id: 'p1', amount: 10000, sold_date: '2026-01-01', created_at: '2026-01-01', name: 'P1' },
    { id: 'p2', amount: 5000, sold_date: '2026-02-01', created_at: '2026-02-01', name: 'P2' },
  ];
  var received = 12000;
  var resultPerCustomer = allocateWaterfall(received, deals);
  var resultBatched = allocateWaterfall(received, deals);
  assert(JSON.stringify(resultPerCustomer) === JSON.stringify(resultBatched), 'results must be identical');
});

// ── Run tests ────────────────────────────────────────────────────────────
async function runTests() {
  var passed = 0, failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      passed++;
    } catch (e) {
      failed++;
      console.error('FAIL: ' + tests[i].name + ' — ' + e.message);
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed (' + tests.length + ' total)');
  return { passed: passed, failed: failed, total: tests.length };
}

if (require.main === module) {
  runTests().then(function (r) { process.exit(r.failed > 0 ? 1 : 0); });
}

module.exports = { runTests: runTests };
