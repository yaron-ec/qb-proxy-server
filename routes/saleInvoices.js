/* eslint-disable no-undef */
'use strict';

/**
 * saleInvoices — Railway sale-scoped invoice ownership contract.
 *
 * POST /api/v1/sale-invoices/map
 *   Persist the durable sale→invoice mapping AFTER QuickBooks creates an
 *   invoice. Body: { qb_invoice_id, qb_doc_number, crm_sale_id, crm_lead_id,
 *                    qb_customer_id, total_amt?, balance?, paid?, txn_status?,
 *                    voided?, txn_date?, mapping_method? }
 *   - crm_sale_id is REQUIRED. An invoice without a Sale is rejected.
 *   - Idempotent: re-calling with the same qb_invoice_id is a no-op (PK).
 *   - Never reassigns an existing mapping (ON CONFLICT DO NOTHING).
 *
 * POST /api/v1/sale-invoices/classify
 *   READ-ONLY backfill analysis. Classifies existing cached invoices as
 *   SAFE_AUTO_MAP / AMBIGUOUS / UNMAPPED. Never writes. Never auto-assigns.
 *   Body: { resolvers: { leadIdForCustomer, dealCountForLead } }
 *   (Migration-period: a server-side orchestrator supplies the resolvers.
 *    Once leads/deals live on Railway the route resolves them internally.)
 *
 * Auth: Railway JWT (requireAuth). /map and /classify are admin/manager only
 * (they mutate/read sale→invoice ownership).
 */
const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { upsertMapping, upsertInvoiceCache, classifyExisting } = require('../lib/qbInvoiceSaleMap');

const router = express.Router();
router.use(requireAuth);

const requireAdminManager = requireRole('admin', 'manager');

router.post('/map', requireAdminManager, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.crm_sale_id) {
      return res.status(400).json({ error: 'crm_sale_id is required — an invoice must belong to a specific Sale' });
    }
    if (!b.qb_invoice_id || !b.crm_lead_id || !b.qb_customer_id) {
      return res.status(400).json({ error: 'qb_invoice_id, crm_lead_id, qb_customer_id are required' });
    }
    const db = { query };
    await upsertMapping(db, {
      qb_invoice_id: b.qb_invoice_id,
      qb_doc_number: b.qb_doc_number,
      crm_sale_id: b.crm_sale_id,
      crm_lead_id: b.crm_lead_id,
      qb_customer_id: b.qb_customer_id,
      mapping_method: b.mapping_method || 'crm_created',
    });
    if (b.total_amt != null) {
      await upsertInvoiceCache(db, {
        qb_invoice_id: b.qb_invoice_id,
        qb_doc_number: b.qb_doc_number,
        qb_customer_id: b.qb_customer_id,
        total_amt: b.total_amt,
        balance: b.balance != null ? b.balance : (b.total_amt - (b.paid || 0)),
        paid: b.paid || 0,
        txn_status: b.txn_status || null,
        voided: !!b.voided,
        txn_date: b.txn_date || null,
      });
    }
    res.json({ success: true, qb_invoice_id: b.qb_invoice_id, crm_sale_id: b.crm_sale_id });
  } catch (e) {
    console.error('[saleInvoices:map] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/classify', requireAdminManager, async (req, res) => {
  try {
    const resolvers = (req.body || {}).resolvers || {};
    const db = { query };
    const rows = await classifyExisting(db, resolvers);
    const counts = rows.reduce((a, r) => { a[r.classification] = (a[r.classification] || 0) + 1; return a; }, {});
    res.json({ success: true, counts, rows });
  } catch (e) {
    console.error('[saleInvoices:classify] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;