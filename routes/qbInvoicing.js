/* eslint-disable no-undef */
'use strict';

/**
 * /api/v1/qb — admin-only QuickBooks Item/invoice-config discovery (CRM
 * STABILITY PHASE, completion pass, Section B).
 *
 * See lib/qbEstimateInvoice.js for the full architecture rationale: no
 * ItemRef is ever invented — this is the one genuinely account-specific
 * configuration point (listQbItems is a live, READ-ONLY query of this
 * account's real Items, never a write), and the actual Estimate/Invoice
 * creation routes live on the Deal itself (routes/dealQbSync.js, mounted
 * at /api/v1/deals, matching the existing one-router-per-resource
 * convention used by routes/dealExpenses.js etc.).
 *
 * Auth: Railway JWT (requireAuth), admin/manager only.
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
  console.error('[qbInvoicing] error:', e.message);
  res.status(502).json({ error: e.message, qb_response: e.qbResponse || undefined });
}

// ── GET /api/v1/qb/items — READ-ONLY live Item list (admin config UI) ──────
router.get('/items', requireAdminManager, async (req, res) => {
  try {
    const items = await qbEstimateInvoice.listQbItems();
    res.json({ items });
  } catch (e) { handleQbError(e, res); }
});

// ── GET/PUT /api/v1/qb/invoice-config — the one admin-set default ItemRef ──
router.get('/invoice-config', requireAdminManager, async (req, res) => {
  try {
    const config = await qbEstimateInvoice.getInvoiceItemConfig();
    res.json({ config });
  } catch (e) { handleQbError(e, res); }
});

router.put('/invoice-config', requireAdminManager, async (req, res) => {
  try {
    const config = await qbEstimateInvoice.setInvoiceItemConfig(req.body || {});
    res.json({ config });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
