/* eslint-disable no-undef */
/**
 * /api/v1/qb-invoice-mapping — admin review + explicit, audited reassignment
 * of a QuickBooks invoice's deal (crm_sale_id) ownership within ONE lead.
 *
 * CRM repair item 4 (QuickBooks Invoice and Payment Reconciliation), item 5
 * (Ali & Mohemmed Lalani case): qb_invoice_sale_map.crm_sale_id is the
 * durable ownership boundary for a QB invoice (lib/qbInvoiceSaleMap.js's own
 * header: "Financial ownership NEVER resolves by customer, amount, project
 * name, or date") and its upsertMapping() NEVER reassigns an existing
 * mapping (ON CONFLICT DO NOTHING) — correct for AUTOMATIC sync/backfill,
 * which must never guess. But nothing in this codebase, before this file,
 * gave a human a way to CORRECT a mapping that automatic backfill got wrong
 * — exactly what happened to Ali & Mohemmed Lalani: a backfill mapped all 6
 * of his real QuickBooks invoices to his original roof-replacement deal,
 * even though at least two of them (dated after his bathroom-repair
 * addendum was accepted) most plausibly belong to that second project.
 *
 * This route is the deliberate, human-only exception the "never
 * auto-merge ambiguous records" rule always implied needed to exist:
 *   GET  /by-lead/:leadId            — the full picture for one lead: every
 *                                      deal, and every invoice currently
 *                                      mapped to any of that lead's deals.
 *   POST /:qbInvoiceId/reassign      — move ONE invoice's mapping to a
 *                                      DIFFERENT deal belonging to the SAME
 *                                      lead. Requires a reason. Writes an
 *                                      audit activity note. Sets
 *                                      mapping_method='manual'. Never
 *                                      touches QuickBooks itself — this is
 *                                      a CRM-side ownership correction only.
 *
 * Deliberately NEVER allows moving an invoice to a deal on a DIFFERENT
 * lead/customer — that would cross the real ownership boundary (a
 * different QB customer entirely) and is never what an "ambiguous
 * addendum vs. original project" correction needs.
 *
 * Auth: Railway JWT (requireAuth). Admin/manager only — a financial
 * ownership correction, same tier as routes/dealQbSync.js's QB writes.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth);
const requireAdminManager = requireRole('admin', 'manager');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── GET /by-lead/:leadId — full invoice/deal picture for one lead ──────────
router.get('/by-lead/:leadId', requireAdminManager, async (req, res) => {
  try {
    const { leadId } = req.params;
    if (!UUID_RE.test(String(leadId))) return res.status(400).json({ error: 'invalid_id' });

    const leadRes = await query('SELECT id, first_name, last_name, qb_customer_id FROM leads WHERE id = $1', [leadId]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'not_found' });

    const { rows: deals } = await query(
      `SELECT id, name, amount, stage, legacy_base44_id IS NOT NULL AS is_migrated
       FROM deals WHERE lead_id = $1 ORDER BY created_at ASC`,
      [leadId]
    );

    const { rows: invoices } = await query(
      `SELECT m.qb_invoice_id, m.qb_doc_number, m.crm_sale_id, m.mapping_method, m.voided,
              c.total_amt, c.balance, c.paid, c.txn_status, c.txn_date
       FROM qb_invoice_sale_map m
       LEFT JOIN qb_invoices_cache c ON c.qb_invoice_id = m.qb_invoice_id
       WHERE m.crm_lead_id = $1
       ORDER BY c.txn_date NULLS LAST, m.qb_invoice_id`,
      [leadId]
    );

    res.json({
      lead: { id: lead.id, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(), qb_customer_id: lead.qb_customer_id },
      deals,
      invoices,
    });
  } catch (e) {
    console.error('[qb-invoice-mapping] by-lead error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:qbInvoiceId/reassign — explicit, audited, lead-scoped reassignment
router.post('/:qbInvoiceId/reassign', requireAdminManager, async (req, res) => {
  try {
    const { qbInvoiceId } = req.params;
    const { crm_sale_id, reason } = req.body || {};
    if (!crm_sale_id) return res.status(400).json({ error: 'crm_sale_id required' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason required', message: 'A reason is required for every invoice reassignment — this is a financial-record correction, never a silent guess.' });
    if (!UUID_RE.test(String(crm_sale_id))) return res.status(400).json({ error: 'invalid_crm_sale_id' });

    const mapRes = await query('SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = $1', [String(qbInvoiceId)]);
    const mapping = mapRes.rows[0];
    if (!mapping) return res.status(404).json({ error: 'not_found', message: 'No mapping exists for this invoice yet — use the normal sync/backfill path to create one, not reassignment.' });

    // The target deal must belong to the EXACT SAME lead this invoice is
    // already mapped to — this can move an invoice between two of the same
    // customer's own projects (the Lalani case), never across customers.
    const targetDealRes = await query('SELECT id, lead_id, name FROM deals WHERE id = $1', [crm_sale_id]);
    const targetDeal = targetDealRes.rows[0];
    if (!targetDeal) return res.status(404).json({ error: 'target_deal_not_found' });
    if (String(targetDeal.lead_id) !== String(mapping.crm_lead_id)) {
      return res.status(422).json({
        error: 'cross_lead_reassignment_blocked',
        message: 'This invoice can only be reassigned to a deal belonging to the SAME lead it is already mapped to — never a different customer\'s project.',
      });
    }
    if (String(targetDeal.id) === String(mapping.crm_sale_id)) {
      return res.status(409).json({ error: 'already_assigned', message: 'This invoice is already mapped to this deal.' });
    }

    const oldDealRes = await query('SELECT name FROM deals WHERE id = $1', [mapping.crm_sale_id]);
    const oldDealName = oldDealRes.rows[0]?.name || mapping.crm_sale_id;

    const upd = await query(
      `UPDATE qb_invoice_sale_map
       SET crm_sale_id = $1, mapping_method = 'manual', updated_at = NOW()
       WHERE qb_invoice_id = $2 RETURNING *`,
      [crm_sale_id, String(qbInvoiceId)]
    );

    try {
      await query(
        `INSERT INTO activities (lead_id, type, content, author, source, created_at)
         VALUES ($1, 'note', $2, $3, 'manual', NOW())`,
        [mapping.crm_lead_id,
         `🔧 Invoice ${mapping.qb_doc_number || qbInvoiceId} reassigned from "${oldDealName}" to "${targetDeal.name}". Reason: ${String(reason).trim()}`,
         req.user.email]
      );
    } catch (actErr) {
      console.warn('[qb-invoice-mapping] activity log failed:', actErr.message);
    }

    res.json({ mapping: upd.rows[0], old_deal_name: oldDealName, new_deal_name: targetDeal.name });
  } catch (e) {
    console.error('[qb-invoice-mapping] reassign error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
