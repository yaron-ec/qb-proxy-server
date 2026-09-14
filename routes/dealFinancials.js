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

const router = express.Router();
router.use(requireAuth);

router.get('/:id/financials', async (req, res) => {
  try {
    const saleId = req.params.id;
    const saleTotal = Number(req.query.sale_total);
    if (!Number.isFinite(saleTotal)) {
      return res.status(400).json({ error: 'sale_total query param (Deal.amount) is required' });
    }
    const db = { query };
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
    } catch (e) {
      console.error('[dealFinancials] waterfall error (non-fatal):', e.message);
      waterfallError = e.message;
    }
    res.json({ crm_sale_id: saleId, ...summary, invoices, waterfall, waterfallError });
  } catch (e) {
    console.error('[dealFinancials] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
