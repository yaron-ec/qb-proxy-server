/* eslint-disable no-undef */
'use strict';

/**
 * customerPaymentWaterfall — System-wide customer payment waterfall allocation.
 *
 * BUSINESS RULE:
 *   For each QB-connected CRM customer, QuickBooks money received is allocated
 *   across the customer's eligible Deals sequentially (chronological order).
 *
 *   1. Determine the customer's eligible CRM Deals in deterministic chronological order.
 *   2. Determine the total ACTUAL MONEY RECEIVED in QuickBooks for that customer.
 *      paid = Invoice.TotalAmt - Invoice.Balance  (from qb_invoices_cache.paid)
 *      Do NOT add qb_payments_cache — that would double-count.
 *   3. Allocate that received money sequentially across the customer's Deals.
 *      Each Deal receives money up to its CRM project/contract amount.
 *      When a Deal reaches its full project amount, remaining money flows to the next.
 *   4. Excess after all Deals are fully funded remains as customer-level excess.
 *
 * Deal ordering (deterministic):
 *   1. COALESCE(deals.sold_date, deals.created_at) ASC  — canonical sale/contract date
 *   2. deals.id ASC  — UUID tie-breaker for identical timestamps
 *
 * Eligible deals:
 *   amount > 0 AND lead.status NOT IN ('Lost', 'DNQ')
 *
 * This is a PURE COMPUTATION layer. No persistence. No side effects.
 * Idempotent: same inputs → same outputs. Rebuildable from QB-authoritative data.
 *
 * Invoice ownership (qb_invoice_sale_map) is SEPARATE from payment allocation.
 * The waterfall NEVER writes to qb_invoice_sale_map.
 */
const { query } = require('../db/client');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Get the total ACTUAL MONEY RECEIVED from QuickBooks for a customer.
 * Source: qb_invoices_cache.paid (where paid = TotalAmt - Balance).
 * Voided invoices are excluded.
 *
 * This is the SINGLE authoritative source for received money.
 * qb_payments_cache is NOT added (would double-count the same payment).
 */
async function getCustomerTotalReceived(db, qbCustomerId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(c.paid), 0) AS total
     FROM qb_invoices_cache c
     WHERE c.qb_customer_id = $1 AND COALESCE(c.voided, FALSE) = FALSE`,
    [String(qbCustomerId)]
  );
  return round2(r.rows[0].total);
}

/**
 * Get the customer's eligible CRM Deals in deterministic chronological order.
 * Eligible: amount > 0, lead status NOT Lost/DNQ.
 * Order: COALESCE(sold_date, created_at) ASC, id ASC.
 */
async function getEligibleDealsForCustomer(db, qbCustomerId) {
  const r = await db.query(
    `SELECT d.id, d.amount, d.sold_date, d.created_at, d.name
     FROM deals d
     JOIN leads l ON l.id = d.lead_id
     WHERE l.qb_customer_id = $1
       AND d.amount IS NOT NULL AND d.amount > 0
       AND l.status NOT IN ('Lost', 'DNQ')
     ORDER BY COALESCE(d.sold_date, d.created_at) ASC, d.id ASC`,
    [String(qbCustomerId)]
  );
  return r.rows;
}

/**
 * Pure waterfall allocation. No DB calls.
 *
 * @param customerTotalReceived  number — total QB paid for the customer
 * @param deals  array of { id, amount, name, sold_date, created_at } in chronological order
 * @returns { allocations: [...], customer_excess: number }
 */
function allocateWaterfall(customerTotalReceived, deals) {
  let remaining = round2(customerTotalReceived);
  const allocations = (deals || []).map(function (deal) {
    var projectTotal = round2(Number(deal.amount) || 0);
    if (projectTotal <= 0) {
      return {
        deal_id: deal.id,
        deal_name: deal.name,
        project_total: 0,
        allocated_paid: 0,
        allocated_remaining: 0,
        allocated_progress: 0,
      };
    }
    var allocatedPaid = round2(Math.min(remaining, projectTotal));
    var allocatedRemaining = round2(Math.max(0, projectTotal - allocatedPaid));
    // Preserve percentage precision — do NOT round to integer.
    var allocatedProgress = projectTotal > 0
      ? Math.min(100, (allocatedPaid / projectTotal) * 100)
      : 0;
    remaining = round2(remaining - allocatedPaid);
    return {
      deal_id: deal.id,
      deal_name: deal.name,
      project_total: projectTotal,
      allocated_paid: allocatedPaid,
      allocated_remaining: allocatedRemaining,
      allocated_progress: round2(allocatedProgress * 100) / 100,
    };
  });
  return { allocations: allocations, customer_excess: round2(Math.max(0, remaining)) };
}

/**
 * Compute the full waterfall for a specific Deal.
 *
 * Returns:
 *   { applied: true, customer_qb_customer_id, customer_total_received,
 *     customer_excess, deal_order: [...], this_deal_allocation: {...} }
 *
 * Or when not applicable:
 *   { applied: false, reason: 'deal_not_found' | 'no_qb_customer_id' | 'lead_lost_or_dnq' }
 */
async function computeWaterfallForDeal(db, dealId) {
  // 1. Get the deal's lead + qb_customer_id + lead status
  var dealRes = await db.query(
    `SELECT d.id, d.amount, d.lead_id, l.qb_customer_id, l.status
     FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.id = $1`,
    [dealId]
  );
  if (!dealRes.rows.length) return { applied: false, reason: 'deal_not_found' };
  var deal = dealRes.rows[0];
  if (!deal.qb_customer_id) return { applied: false, reason: 'no_qb_customer_id' };
  if (deal.status === 'Lost' || deal.status === 'DNQ') return { applied: false, reason: 'lead_lost_or_dnq' };

  // 2. Get customer total received (single authoritative source)
  var customerTotalReceived = await getCustomerTotalReceived(db, deal.qb_customer_id);

  // 3. Get eligible deals in chronological order
  var eligibleDeals = await getEligibleDealsForCustomer(db, deal.qb_customer_id);

  // 4. Run waterfall
  var result = allocateWaterfall(customerTotalReceived, eligibleDeals);

  // 5. Find THIS deal's allocation
  var thisAllocation = null;
  for (var i = 0; i < result.allocations.length; i++) {
    if (result.allocations[i].deal_id === dealId) {
      thisAllocation = result.allocations[i];
      break;
    }
  }

  return {
    applied: true,
    customer_qb_customer_id: deal.qb_customer_id,
    customer_total_received: customerTotalReceived,
    customer_excess: result.customer_excess,
    deal_order: eligibleDeals.map(function (d) {
      return { deal_id: d.id, sold_date: d.sold_date, amount: round2(Number(d.amount) || 0) };
    }),
    this_deal_allocation: thisAllocation,
  };
}


/**
 * BATCHED: Get total ACTUAL MONEY RECEIVED for ALL customers in ONE query.
 * Returns a Map<qbCustomerId, totalReceived>.
 * Voided invoices are excluded. Same source as getCustomerTotalReceived.
 *
 * This replaces N calls to getCustomerTotalReceived with a single set-based query.
 */
async function getCustomerTotalReceivedBatch(db, customerIds) {
  if (!customerIds || customerIds.length === 0) return new Map();
  var r = await db.query(
    `SELECT qb_customer_id, COALESCE(SUM(paid), 0) AS total
     FROM qb_invoices_cache
     WHERE qb_customer_id = ANY($1::text[])
       AND COALESCE(voided, FALSE) = FALSE
     GROUP BY qb_customer_id`,
    [customerIds.map(String)]
  );
  var map = new Map();
  for (var i = 0; i < r.rows.length; i++) {
    map.set(r.rows[i].qb_customer_id, round2(r.rows[i].total));
  }
  return map;
}

/**
 * BATCHED: Get eligible Deals for ALL customers in ONE query.
 * Returns a Map<qbCustomerId, deals[]> where each deals array is in
 * deterministic chronological order:
 *   COALESCE(sold_date, created_at) ASC, id ASC
 *
 * Same eligibility rules as getEligibleDealsForCustomer:
 *   amount > 0, lead status NOT Lost/DNQ
 *
 * This replaces N calls to getEligibleDealsForCustomer with a single set-based query.
 * The ORDER BY groups by customer first, then sorts chronologically within each
 * customer. The Map preserves insertion order, so each customer's deals array
 * is already in chronological order — no re-sort needed.
 */
async function getEligibleDealsForCustomersBatch(db, customerIds) {
  if (!customerIds || customerIds.length === 0) return new Map();
  var r = await db.query(
    `SELECT d.id, d.amount, d.sold_date, d.created_at, d.name, l.qb_customer_id
     FROM deals d
     JOIN leads l ON l.id = d.lead_id
     WHERE l.qb_customer_id = ANY($1::text[])
       AND d.amount IS NOT NULL AND d.amount > 0
       AND l.status NOT IN ('Lost', 'DNQ')
     ORDER BY l.qb_customer_id, COALESCE(d.sold_date, d.created_at) ASC, d.id ASC`,
    [customerIds.map(String)]
  );
  var map = new Map();
  for (var i = 0; i < r.rows.length; i++) {
    var row = r.rows[i];
    if (!map.has(row.qb_customer_id)) map.set(row.qb_customer_id, []);
    map.get(row.qb_customer_id).push(row);
  }
  return map;
}

module.exports = {
  round2: round2,
  getCustomerTotalReceived: getCustomerTotalReceived,
  getEligibleDealsForCustomer: getEligibleDealsForCustomer,
  getCustomerTotalReceivedBatch: getCustomerTotalReceivedBatch,
  getEligibleDealsForCustomersBatch: getEligibleDealsForCustomersBatch,
  allocateWaterfall: allocateWaterfall,
  computeWaterfallForDeal: computeWaterfallForDeal,
};
