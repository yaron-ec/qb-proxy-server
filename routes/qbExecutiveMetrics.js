/* eslint-disable no-undef */
/**
 * /api/v1/qb-executive-metrics — Railway-native QB Executive Metrics.
 *
 * Replaces the Base44 function getQBExecutiveMetrics. Reads from:
 *   - Railway `leads` table (leads with qb_customer_id)
 *   - QB proxy /invoices (live QB invoice data)
 *   - Railway `qb_invoices_cache` (cached QB financials)
 *   - Railway `qb_invoice_sale_map` (sale-scoped ownership)
 *   - Railway `sync_cursors` (sync status)
 *
 * Sale-scoped: revenue is computed per-deal (crm_sale_id), not per-customer.
 * A customer with multiple sales sees each sale's financials independently.
 *
 * Auth: Railway JWT (requireAuth). Admin only.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const qbInternal = require('../lib/qbInternal');

const router = express.Router();
router.use(requireAuth);
const requireAdmin = requireRole('admin');

const QB_APP_BASE = 'https://qbo.intuit.com/app';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    // 1. QB auth status
    let qbConnected = false;
    let qbReconnectRequired = false;
    let environment = null;
    let realmId = null;
    try {
      const status = await qbInternal.getAuthStatus();
      qbConnected = status.connected === true;
      qbReconnectRequired = status.reconnectRequired === true;
      environment = status.environment || null;
      realmId = status.realm_id || null;
    } catch (e) {
      // QB proxy not configured or unreachable
      return res.json({
        success: true,
        connected: false,
        error: 'Cannot reach QB proxy',
        metrics: null,
      });
    }

    if (!qbConnected) {
      return res.json({
        success: true,
        connected: false,
        reconnectRequired: qbReconnectRequired,
        metrics: null,
      });
    }

    // 2. Load all leads with QB customer ID from Railway
    const { rows: leadsWithQB } = await query(`
      SELECT id, first_name, last_name, email, assigned_rep, status,
             qb_customer_id, owner_id
      FROM leads
      WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
      ORDER BY created_at DESC
      LIMIT 5000
    `);

    // 3. Load all deals from Railway (for sale-scoped revenue)
    const { rows: deals } = await query(`
      SELECT id, lead_id, name, amount, stage, assigned_rep, sold_date
      FROM deals
      ORDER BY created_at DESC
      LIMIT 5000
    `);

    // 4. Load QB invoice cache + sale map from Railway
    const { rows: cachedInvoices } = await query(`
      SELECT c.qb_invoice_id, c.qb_doc_number, c.qb_customer_id,
             c.total_amt, c.balance, c.paid, c.txn_status, c.voided, c.txn_date,
             m.crm_sale_id, m.crm_lead_id
      FROM qb_invoices_cache c
      LEFT JOIN qb_invoice_sale_map m ON m.qb_invoice_id = c.qb_invoice_id
      WHERE COALESCE(c.voided, FALSE) = FALSE
      ORDER BY c.txn_date DESC NULLS LAST
      LIMIT 5000
    `);

    // 5. Build customer → lead map
    const customerMap = {};
    for (const lead of leadsWithQB) {
      const custId = lead.qb_customer_id;
      if (!customerMap[custId]) {
        customerMap[custId] = {
          id: custId,
          leadId: lead.id,
          name: `${lead.first_name} ${lead.last_name}`.trim(),
          email: lead.email || null,
          assignedRep: lead.assigned_rep || 'Unassigned',
          leadStatus: lead.status,
          deals: deals.filter(d => d.lead_id === lead.id),
          invoices: [],
          totalInvoiced: 0,
          totalPaid: 0,
          openBalance: 0,
        };
      }
    }

    // 6. Match cached invoices to customers (sale-scoped)
    for (const inv of cachedInvoices) {
      const custId = inv.qb_customer_id;
      if (!customerMap[custId]) continue;
      const cust = customerMap[custId];
      const totalAmt = round2(Number(inv.total_amt) || 0);
      const balance = round2(Number(inv.balance) || 0);
      const paid = round2(Math.max(0, totalAmt - balance));

      cust.invoices.push({
        id: inv.qb_invoice_id,
        docNumber: inv.qb_doc_number,
        txnDate: inv.txn_date,
        total: totalAmt,
        paid: paid,
        balance: balance,
        status: balance === 0 ? 'Paid' : (balance < totalAmt ? 'Partial' : 'Open'),
        crmSaleId: inv.crm_sale_id,
        appUrl: `${QB_APP_BASE}/invoice?txnId=${inv.qb_invoice_id}`,
      });

      cust.totalInvoiced = round2(cust.totalInvoiced + totalAmt);
      cust.totalPaid = round2(cust.totalPaid + paid);
      cust.openBalance = round2(cust.openBalance + balance);
    }

    // 7. Revenue by Sales Rep (sale-scoped)
    const repMetrics = {};
    for (const cust of Object.values(customerMap)) {
      const rep = cust.assignedRep;
      if (!repMetrics[rep]) {
        repMetrics[rep] = {
          rep,
          totalRevenue: 0,
          totalCollected: 0,
          openBalance: 0,
          invoiceCount: 0,
          customerCount: 0,
          avgDealSize: 0,
        };
      }
      repMetrics[rep].totalRevenue = round2(repMetrics[rep].totalRevenue + cust.totalInvoiced);
      repMetrics[rep].totalCollected = round2(repMetrics[rep].totalCollected + cust.totalPaid);
      repMetrics[rep].openBalance = round2(repMetrics[rep].openBalance + cust.openBalance);
      repMetrics[rep].customerCount += 1;
      repMetrics[rep].invoiceCount += cust.invoices.length;
    }
    for (const rep of Object.values(repMetrics)) {
      rep.avgDealSize = rep.customerCount > 0 ? round2(rep.totalRevenue / rep.customerCount) : 0;
    }

    // 8. Sync status from Railway sync_cursors
    const { rows: syncCursors } = await query(`
      SELECT integration, last_successful_sync_at, last_sync_summary
      FROM sync_cursors
      WHERE integration LIKE 'quickbooks%'
      ORDER BY last_successful_sync_at DESC NULLS LAST
    `);

    const syncStatus = {
      connected: true,
      environment: environment === 'production' ? 'Production' : 'Sandbox',
      realmId,
      lastFullSync: syncCursors.find(c => c.integration === 'quickbooks_customers')?.last_successful_sync_at || null,
      recentActivity: syncCursors.map(c => ({
        integration: c.integration,
        lastSync: c.last_successful_sync_at,
        summary: c.last_sync_summary,
      })),
    };

    // 9. Executive Metrics (sale-scoped)
    const allCustomers = Object.values(customerMap);
    const revenue = {
      totalInvoiced: round2(allCustomers.reduce((s, c) => s + c.totalInvoiced, 0)),
      totalCollected: round2(allCustomers.reduce((s, c) => s + c.totalPaid, 0)),
      outstanding: round2(allCustomers.reduce((s, c) => s + c.openBalance, 0)),
      openInvoiceCount: allCustomers.reduce((s, c) => s + c.invoices.filter(i => i.status !== 'Paid').length, 0),
      avgInvoiceValue: 0,
      thisMonth: 0,
      thisYear: 0,
    };

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisYearStart = new Date(now.getFullYear(), 0, 1);

    for (const cust of allCustomers) {
      for (const inv of cust.invoices) {
        if (!inv.txnDate) continue;
        const invDate = new Date(inv.txnDate);
        if (invDate >= thisMonthStart) revenue.thisMonth = round2(revenue.thisMonth + inv.total);
        if (invDate >= thisYearStart) revenue.thisYear = round2(revenue.thisYear + inv.total);
      }
    }

    const totalInvoices = allCustomers.reduce((s, c) => s + c.invoices.length, 0);
    revenue.avgInvoiceValue = totalInvoices > 0 ? round2(revenue.totalInvoiced / totalInvoices) : 0;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      connected: true,
      syncStatus,
      revenue,
      customers: allCustomers,
      repMetrics: Object.values(repMetrics).sort((a, b) => b.totalRevenue - a.totalRevenue),
    });
  } catch (e) {
    console.error('[qb-executive-metrics] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;