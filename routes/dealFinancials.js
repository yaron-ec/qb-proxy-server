/* eslint-disable no-undef */
'use strict';

/**
 * dealFinancials — Railway sale-scoped financial endpoint.
 *
 * GET /api/v1/deals/:id/financials?sale_total=<number>
 *   Returns the sale-scoped financial summary AND the customer payment waterfall.
 *
 * The waterfall is computed in a separate try-catch so that a waterfall error
 * (e.g., missing column, deal not found) never prevents the sale-scoped
 * summary from being returned. The frontend falls back to the summary when
 * the waterfall is null.
 *
 * Auth: Railway JWT (requireAuth). Mounted at /api/v1/deals.
 */
const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { getInvoicesForSale, computeSaleFinancials } = require('../lib/qbInvoiceSaleMap');
const { computeWaterfallForDeal } = require('../lib/customerPaymentWaterfall');
const { checkDealScope } = require('../lib/recordAccess');

const router = express.Router();
router.use(requireAuth);

/**
 * Core, auth-independent computation behind GET /:id/financials — extracted
 * so the consolidated Master Project aggregation (routes/deals.js's
 * GET /:id/addendums) can call it directly, per deal, without an internal
 * HTTP round-trip, and so there is exactly ONE implementation of the
 * direct-invoice-vs-waterfall precedence rule for both callers to share.
 *
 * @param db        { query } — same shape every caller in this codebase uses
 * @param saleId    the Deal's own id (crm_sale_id)
 * @param saleTotal the Deal's own contract amount (Deal.amount)
 * @returns { summary, invoices, waterfall, waterfallError }
 */
async function getSaleFinancialSummary(db, saleId, saleTotal) {
  const invoices = await getInvoicesForSale(db, saleId);
  const summary = computeSaleFinancials(saleTotal, invoices);
  // Customer payment waterfall — allocates customer-level QB received money
  // across eligible Deals chronologically. Invoice ownership is separate.
  // Computed in a separate try-catch so a waterfall error never prevents
  // the sale-scoped summary from being returned.
  let waterfall = null;
  let waterfallError = null;
  try {
    waterfall = await computeWaterfallForDeal(db, saleId);
    // Override summary with the waterfall allocation ONLY when this deal
    // has NO direct (qb_invoice_sale_map-attributed) invoices of its own
    // — the waterfall exists for exactly that gap (a multi-Deal customer
    // whose invoice ownership was never explicitly mapped), never as a
    // replacement for real, directly-attributed invoice data.
    //
    // ROOT-CAUSE FIX (November 2026 production correction — the Ali &
    // Mohemmed Lalani "Bathroom Repair addendum shows an artificial Paid
    // amount" report): this override previously applied UNCONDITIONALLY
    // whenever the lead had a linked QuickBooks customer, even when `invoices` (this
    // deal's own direct mapping) was non-empty — silently discarding real,
    // specifically-attributed invoice/payment data in favor of a
    // customer-level, contract-size-capped ESTIMATE. That is the literal
    // "Paid amount derived from the contract value" symptom: the
    // waterfall's allocated_paid is mathematically bounded by
    // `Math.min(remaining, projectTotal)` (lib/customerPaymentWaterfall.js),
    // so once a customer's total received money exceeds an addendum's own
    // (smaller) contract amount, the override reports that addendum as
    // fully paid regardless of what was actually invoiced/paid against it
    // specifically. A deal with its own real invoice attribution must
    // always win over that estimate.
    if (invoices.length === 0 && waterfall && waterfall.applied && waterfall.this_deal_allocation) {
      const wfPaid = Number(waterfall.this_deal_allocation.allocated_paid) || 0;
      summary.paid = wfPaid;
      summary.balance = Math.max(0, saleTotal - wfPaid);
      // Keep the same two fields added in computeSaleFinancials() in sync
      // when the waterfall overrides paid/balance — see the field-naming
      // note on computeSaleFinancials for what each one means.
      summary.remaining = summary.balance;
      summary.invoiced_unpaid = Math.max(0, summary.invoiced - wfPaid);
      summary.payment_status = wfPaid >= saleTotal ? 'paid' : (wfPaid > 0 ? 'partial' : 'unpaid');
    }
  } catch (e) {
    console.error('[dealFinancials] waterfall error (non-fatal):', e.message);
    waterfallError = e.message;
  }
  return { summary, invoices, waterfall, waterfallError };
}

router.get('/:id/financials', async (req, res) => {
  try {
    const saleId = req.params.id;
    const saleTotal = Number(req.query.sale_total);
    if (!Number.isFinite(saleTotal)) {
      return res.status(400).json({ error: 'sale_total query param (Deal.amount) is required' });
    }
    // A sales_rep must not be able to pull another rep's deal financials
    // merely by knowing the deal id.
    const access = await checkDealScope(req.user, saleId);
    if (!access.allowed) {
      const status = access.reason === 'deal_not_found' ? 404 : 403;
      return res.status(status).json({ error: status === 404 ? 'not_found' : 'forbidden' });
    }
    const db = { query };
    const { summary, invoices, waterfall, waterfallError } = await getSaleFinancialSummary(db, saleId, saleTotal);
    res.json({ crm_sale_id: saleId, ...summary, invoices, waterfall, waterfallError });
  } catch (e) {
    console.error('[dealFinancials] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.getSaleFinancialSummary = getSaleFinancialSummary;
