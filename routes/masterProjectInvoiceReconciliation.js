/* eslint-disable no-undef */
/**
 * GET /api/v1/deals/:id/invoice-reconciliation — admin-only, read-only
 * itemized invoice reconciliation for a Master Project (November 2026,
 * built for the Lalani $42,031-vs-$40,934 discrepancy investigation).
 *
 * Reuses lib/masterProjectInvoiceReconciliation.js — purely read-only
 * (every query a SELECT), never writes/voids/reassigns anything. Gated
 * admin-only (the same lib/rbac.js convention as every other sensitive
 * read-only diagnostic in this codebase, e.g. routes/reminderDiagnostics.js)
 * rather than the regular canAccessDeal scope, since this surfaces raw
 * cross-deal invoice data (including invoices mapped to OTHER, unrelated
 * deals for the same QuickBooks customer) that a sales_rep has no
 * legitimate need to see.
 */
'use strict';

const express = require('express');
const { query } = require('../db/client');
const { requireAuth, requireAdmin } = require('../lib/rbac');
const { getMasterProjectInvoiceReconciliation } = require('../lib/masterProjectInvoiceReconciliation');

const router = express.Router();

router.get('/:id/invoice-reconciliation', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await getMasterProjectInvoiceReconciliation({ query }, req.params.id);
    if (!result.found) return res.status(404).json({ error: 'not_found' });
    res.json(result);
  } catch (e) {
    console.error('[invoice-reconciliation] error:', e.message);
    res.status(500).json({ error: 'invoice_reconciliation_failed', message: e.message });
  }
});

module.exports = router;
