/* eslint-disable no-undef */
'use strict';

/**
 * dealFinancials — Railway sale-scoped financial endpoint.
 *
 * GET /api/v1/deals/:id/financials?sale_total=<number>
 *   Returns the sale-scoped financial summary for the given crm_sale_id.
 *   sale_total (Deal.amount) is supplied by the caller during the migration
 *   period; once Deals live on Railway the endpoint will load it from the
 *   deals table. It is NEVER derived from customer or invoices.
 *
 * No customer-level aggregation is used. Only invoices mapped to this
 * crm_sale_id contribute. Voided invoices are excluded.
 *
 * Auth: Railway JWT (requireAuth). Mounted at /api/v1/deals.
 */
const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { getInvoicesForSale, computeSaleFinancials } = require('../lib/qbInvoiceSaleMap');

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
    res.json({ crm_sale_id: saleId, ...summary, invoices });
  } catch (e) {
    console.error('[dealFinancials] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;