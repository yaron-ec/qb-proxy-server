/* eslint-disable no-undef */
'use strict';

/**
 * /api/v1/deals/:id/qb-estimate, /api/v1/deals/:id/qb-invoice — real QB
 * Estimate/Invoice creation from a Deal (CRM STABILITY PHASE, completion
 * pass, Section B — see lib/qbEstimateInvoice.js for the full design).
 *
 * Mounted at /api/v1/deals alongside routes/deals.js, routes/dealFinancials.js,
 * routes/dealTimeline.js. Auth: Railway JWT (requireAuth), admin/manager only
 * — matches the existing precedent for financial-mutation routes
 * (routes/signnow.js's prepare/send, routes/saleInvoices.js's /map).
 */
const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { requireModuleEnabled } = require('../lib/moduleGate');
const qbEstimateInvoice = require('../lib/qbEstimateInvoice');

const router = express.Router();
router.use(requireAuth);
router.use(requireModuleEnabled('quickbooks'));
const requireAdminManager = requireRole('admin', 'manager');

function handleQbError(e, res) {
  if (e.code === 'qb_item_not_configured') return res.status(422).json({ error: e.code, message: e.message });
  if (e.code === 'QB_NOT_CONNECTED') return res.status(503).json({ error: e.code, message: e.message });
  if (e.status === 404) return res.status(404).json({ error: e.message });
  console.error('[dealQbSync] error:', e.message);
  res.status(502).json({ error: e.message, qb_response: e.qbResponse || undefined });
}

router.post('/:id/qb-estimate', requireAdminManager, async (req, res) => {
  try {
    const result = await qbEstimateInvoice.createEstimateForDeal(req.params.id);
    res.status(result.created ? 201 : 200).json(result);
  } catch (e) { handleQbError(e, res); }
});

router.post('/:id/qb-invoice', requireAdminManager, async (req, res) => {
  try {
    const result = await qbEstimateInvoice.createInvoiceForDeal(req.params.id);
    res.status(result.created ? 201 : 200).json(result);
  } catch (e) { handleQbError(e, res); }
});

module.exports = router;
