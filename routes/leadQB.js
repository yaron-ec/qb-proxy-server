/* eslint-disable no-undef */
/**
 * /api/v1/lead-qb — Native Railway QuickBooks lead status adapter.
 *
 * Exposes existing native Railway/QB data to the Lead Detail page:
 *   GET  /api/v1/lead-qb/by-external/:externalRef          — QB status for a lead
 *   POST /api/v1/lead-qb/by-external/:externalRef/refresh  — refresh from QB
 *   POST /api/v1/lead-qb/by-external/:externalRef/sync     — sync lead to QB customer
 *
 * Reads from:
 *   - Railway `leads` table (qb_customer_id, qb_invoice_* fields)
 *   - Railway `invoices` table (CRM invoices filtered by lead_id)
 *   - Railway `qb_invoices_cache` (cached QB invoice financials)
 *   - Railway `qb_invoice_sale_map` (sale-scoped invoice ownership)
 *   - Railway `handoff_estimates` (QB estimates matched to this lead)
 *
 * Calls (via qbInternal.js):
 *   - Existing QB proxy /qb/lead-status for live QB data
 *   - Existing QB proxy /qb/sync-lead for customer create/update
 *
 * Preserves sale isolation: invoices are returned with their deal_id
 * (crm_sale_id from qb_invoice_sale_map) so the frontend can group them
 * by sale.
 *
 * Auth: Railway JWT (requireAuth). Admin/manager/office read; admin/manager write.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const qbInternal = require('../lib/qbInternal');
const { resolveLeadByIdentifier } = require('../lib/leadResolver');

const router = express.Router();
router.use(requireAuth);

const requireAdminManager = requireRole('admin', 'manager');

// ── GET /by-external/:externalRef — QB status for a lead ─────────────────────
router.get('/by-external/:externalRef', async (req, res) => {
  try {
    const { externalRef } = req.params;

    // 1. Read lead from Railway (safe identifier resolution — external_ref OR UUID)
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    // 2. Read CRM invoices from Railway (by canonical Railway UUID)
    const invoiceRes = await query(
      `SELECT * FROM invoices WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [lead.id]
    );

    // 3. Read QB invoice cache + sale map (for sale-scoped financials)
    const cacheRes = await query(
      `SELECT c.*, m.crm_sale_id, m.crm_lead_id
       FROM qb_invoices_cache c
       LEFT JOIN qb_invoice_sale_map m ON m.qb_invoice_id = c.qb_invoice_id
       WHERE m.crm_lead_id = $1
       ORDER BY c.created_at DESC LIMIT 100`,
      [lead.id]
    );

    // 4. Read handoff estimates (QB estimates matched to this lead)
    const estRes = await query(
      `SELECT * FROM handoff_estimates WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [lead.id]
    );

    // 5. Check QB auth status
    let qbConnected = false;
    let qbReconnectRequired = false;
    try {
      const status = await qbInternal.getAuthStatus();
      qbConnected = status.connected === true;
      qbReconnectRequired = status.reconnectRequired === true;
    } catch { /* QB proxy not configured — report as disconnected */ }

    // 6. Build response
    res.json({
      lead: {
        id: lead.id,
        external_ref: lead.external_ref,
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email,
        phone: lead.phone,
        qb_customer_id: lead.qb_customer_id,
        qb_invoice_id: lead.qb_invoice_id,
        qb_invoice_number: lead.qb_invoice_number,
        qb_invoice_amount: lead.qb_invoice_amount,
        qb_invoice_status: lead.qb_invoice_status,
        qb_invoice_url: lead.qb_invoice_url,
        qb_deposit_amount: lead.qb_deposit_amount,
        qb_payment_received: lead.qb_payment_received,
        qb_balance_due: lead.qb_balance_due,
        qb_payment_status: lead.qb_payment_status,
        qb_last_sync_at: lead.qb_last_sync_at,
        qb_last_sync_result: lead.qb_last_sync_result,
        qb_last_error: lead.qb_last_error,
      },
      crmInvoices: invoiceRes.rows.map(inv => ({
        id: inv.id,
        deal_id: inv.deal_id,
        invoice_number: inv.invoice_number,
        amount: inv.amount,
        description: inv.description,
        payment_stage: inv.payment_stage,
        status: inv.status,
        qb_invoice_id: inv.qb_invoice_id,
        qb_invoice_number: inv.qb_invoice_number,
        qb_status: inv.qb_status,
        qb_invoice_url: inv.qb_invoice_url,
        qb_pdf_url: inv.qb_pdf_url,
        payment_received: inv.payment_received,
        payment_status: inv.payment_status,
        synced_to_qb: inv.synced_to_qb,
        created_date: inv.created_at,
      })),
      qbInvoices: cacheRes.rows.map(c => ({
        qb_invoice_id: c.qb_invoice_id,
        qb_doc_number: c.qb_doc_number,
        qb_customer_id: c.qb_customer_id,
        total_amt: c.total_amt,
        balance: c.balance,
        paid: c.paid,
        txn_status: c.txn_status,
        voided: c.voided,
        txn_date: c.txn_date,
        crm_sale_id: c.crm_sale_id,
      })),
      estimates: estRes.rows.map(e => ({
        id: e.id,
        qb_estimate_id: e.qb_estimate_id,
        qb_estimate_number: e.qb_estimate_number,
        customer_name: e.customer_name,
        estimate_amount: e.estimate_amount,
        estimate_status: e.estimate_status,
        estimate_date: e.estimate_date,
        document_url: e.document_url,
        pdf_url: e.pdf_url,
        pdf_status: e.pdf_status,
        match_status: e.match_status,
        qb_app_url: e.qb_app_url,
      })),
      qbConnected,
      qbReconnectRequired,
    });
  } catch (e) {
    console.error('[lead-qb] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /by-external/:externalRef/refresh — refresh QB data from Intuit ─────
// Calls the existing QB proxy /qb/lead-status to pull live customer + invoice
// data. Does NOT write to Railway — it returns the live QB data for display.
// The actual sync (writing to Railway) is handled by the existing sync workers.
router.post('/by-external/:externalRef/refresh', requireAdminManager, async (req, res) => {
  try {
    const { externalRef } = req.params;

    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    const name = `${lead.first_name} ${lead.last_name}`.trim();
    const qbData = await qbInternal.getLeadStatus(lead.qb_customer_id, name, lead.email);

    res.json({
      success: true,
      qbData,
      message: qbData.found ? 'QB customer found' : 'No QB customer found for this lead',
    });
  } catch (e) {
    if (e.code === 'QB_PROXY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'QB proxy not configured', message: e.message });
    }
    if (e.qbError && e.qbError.reconnectRequired) {
      return res.status(401).json({ error: 'QUICKBOOKS_RECONNECT_REQUIRED', message: e.message });
    }
    console.error('[lead-qb] refresh error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /by-external/:externalRef/sync-estimates — lead-specific QB estimate sync
// Fetches QB estimates for this lead's QB customer (or by name/email if no QB
// customer ID), matches them to the lead, and upserts into handoff_estimates
// with sync_source = 'QuickBooks'. This is the lead-specific equivalent of the
// system-wide /sync/qb-estimates cron — it only fetches estimates for THIS
// lead's customer, not all QB estimates.
//
// QuickBooks and Handoff are SEPARATE integrations. This endpoint ONLY touches
// QB-sourced estimates (sync_source = 'QuickBooks'). It does NOT call the
// Handoff API. Handoff sync is a separate endpoint (/handoff/sync-estimates-for-lead).
router.post('/by-external/:externalRef/sync-estimates', requireAdminManager, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    // 1. Resolve the QB customer ID — use stored qb_customer_id, or look up by name/email
    let qbCustomerId = lead.qb_customer_id;
    let customerName = `${lead.first_name} ${lead.last_name}`.trim();

    if (!qbCustomerId) {
      // Look up QB customer by name or email
      const qbData = await qbInternal.getLeadStatus(null, customerName, lead.email);
      if (qbData.found && qbData.customer) {
        qbCustomerId = qbData.customer.Id;
        // Persist the QB customer ID for future syncs
        await query(
          'UPDATE leads SET qb_customer_id = $1, qb_last_sync_at = NOW(), qb_last_sync_result = $2, updated_at = NOW() WHERE id = $3',
          [qbCustomerId, 'success', lead.id]
        );
      } else {
        return res.json({
          success: false,
          message: 'No QuickBooks customer found for this lead. Sync the lead to QB first.',
          matched: 0,
        });
      }
    }

    // 2. Fetch QB estimates for this customer (all statuses) via the QB proxy
    //    GET /estimates/by-customer/:customerId returns all estimates for the customer
    const estData = await qbInternal.callQb(`/estimates/by-customer/${qbCustomerId}`, 'GET');
    const estimates = estData.estimates || [];
    if (estimates.length === 0) {
      return res.json({
        success: true,
        message: 'No QuickBooks estimates found for this customer.',
        total_fetched: 0,
        matched: 0,
        created: 0,
        updated: 0,
      });
    }

    // 3. Load existing QB-sourced estimates for this lead to check for duplicates
    const existingRes = await query(
      `SELECT * FROM handoff_estimates WHERE lead_id = $1 AND qb_estimate_id IS NOT NULL`,
      [lead.id]
    );
    const existing = existingRes.rows;
    const existingByQbId = new Map(existing.map(e => [String(e.qb_estimate_id), e]));

    let created = 0, updated = 0;
    const SANDBOX = process.env.QB_SANDBOX === 'true';
    const qbAppUrlBase = SANDBOX ? 'https://sandbox.qbo.intuit.com' : 'https://app.qbo.intuit.com';

    for (const qbEst of estimates) {
      const qbId = String(qbEst.Id);
      const qbNumber = qbEst.DocNumber || qbId;
      const totalAmt = Number(qbEst.TotalAmt) || 0;
      const status = qbEst.TxnStatus || 'Pending';
      const qbAppUrl = `${qbAppUrlBase}/app/estimate?txnId=${qbId}`;
      const estimateDate = qbEst.TxnDate || null;

      const estimateData = {
        qb_estimate_id: qbId,
        qb_estimate_number: qbNumber,
        lead_id: lead.id,
        customer_name: qbEst.CustomerRef?.name || customerName,
        estimate_amount: totalAmt,
        estimate_status: status,
        estimate_date: estimateDate,
        qb_app_url: qbAppUrl,
        last_synced_at: new Date().toISOString(),
        match_status: 'matched',
        match_method: 'qb_direct',
        sync_source: 'QuickBooks',
        source: 'QB Direct Sync',
      };

      const existingRow = existingByQbId.get(qbId);
      if (existingRow) {
        // Update existing — reset PDF status if it was failed
        const pdfReset = existingRow.pdf_status === 'failed'
          ? { pdf_status: 'pending', pdf_retry_count: 0 }
          : {};
        await query(
          `UPDATE handoff_estimates SET
             qb_estimate_number = $1, estimate_amount = $2, estimate_status = $3,
             estimate_date = $4, qb_app_url = $5, last_synced_at = $6,
             match_status = $7, match_method = $8, sync_source = $9, source = $10,
             ${existingRow.pdf_status === 'failed' ? 'pdf_status = $11, pdf_retry_count = $12,' : ''}
             updated_at = NOW()
           WHERE id = $${existingRow.pdf_status === 'failed' ? '13' : '11'}`,
          existingRow.pdf_status === 'failed'
            ? [qbNumber, totalAmt, status, estimateDate, qbAppUrl, estimateData.last_synced_at,
               'matched', 'qb_direct', 'QuickBooks', 'QB Direct Sync', 'pending', 0, existingRow.id]
            : [qbNumber, totalAmt, status, estimateDate, qbAppUrl, estimateData.last_synced_at,
               'matched', 'qb_direct', 'QuickBooks', 'QB Direct Sync', existingRow.id]
        );
        updated++;
      } else {
        // Insert new
        await query(
          `INSERT INTO handoff_estimates
             (qb_estimate_id, qb_estimate_number, lead_id, customer_name,
              estimate_amount, estimate_status, estimate_date, qb_app_url,
              last_synced_at, match_status, match_method, sync_source, source,
              pdf_status, pdf_retry_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',0)`,
          [qbId, qbNumber, lead.id, estimateData.customer_name,
           totalAmt, status, estimateDate, qbAppUrl, estimateData.last_synced_at,
           'matched', 'qb_direct', 'QuickBooks', 'QB Direct Sync']
        );
        created++;
      }
    }

    // 4. Update lead handoff_estimate_status if awaiting_qb
    if (lead.handoff_estimate_status === 'awaiting_qb' && (created > 0 || updated > 0)) {
      await query(
        'UPDATE leads SET handoff_estimate_status = $1, updated_at = NOW() WHERE id = $2',
        ['synced', lead.id]
      ).catch(() => {});
    }

    console.log(`[lead-qb] sync-estimates: customer=${qbCustomerId} fetched=${estimates.length} created=${created} updated=${updated}`);

    res.json({
      success: true,
      message: `Synced ${estimates.length} QuickBooks estimate(s): ${created} new, ${updated} updated`,
      total_fetched: estimates.length,
      matched: estimates.length,
      created,
      updated,
      qb_customer_id: qbCustomerId,
    });
  } catch (e) {
    if (e.code === 'QB_PROXY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'QB proxy not configured', message: e.message });
    }
    if (e.qbError && e.qbError.reconnectRequired) {
      return res.status(401).json({ error: 'QUICKBOOKS_RECONNECT_REQUIRED', message: e.message });
    }
    console.error('[lead-qb] sync-estimates error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /by-external/:externalRef/sync — sync lead to QB customer ──────────
// Creates or updates a QB customer from lead data via the existing QB proxy.
router.post('/by-external/:externalRef/sync', requireAdminManager, async (req, res) => {
  try {
    const { externalRef } = req.params;

    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    const result = await qbInternal.syncLead({
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email,
      phone: lead.phone,
      property_address: lead.property_address,
      city: lead.city,
      qb_customer_id: lead.qb_customer_id,
    });

    // If a customer was created/found, persist the QB customer ID to Railway
    if (result.customer_id || result.customer?.Id) {
      const qbCustomerId = result.customer_id || result.customer.Id;
      await query(
        'UPDATE leads SET qb_customer_id = $1, qb_last_sync_at = NOW(), qb_last_sync_result = $2, updated_at = NOW() WHERE id = $3',
        [qbCustomerId, 'success', lead.id]
      );
    }

    res.json({
      success: true,
      customer_id: result.customer_id || result.customer?.Id,
      customer: result.customer,
    });
  } catch (e) {
    if (e.code === 'QB_PROXY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'QB proxy not configured', message: e.message });
    }
    if (e.qbError && e.qbError.reconnectRequired) {
      return res.status(401).json({ error: 'QUICKBOOKS_RECONNECT_REQUIRED', message: e.message });
    }
    console.error('[lead-qb] sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;