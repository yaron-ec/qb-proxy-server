/* eslint-disable no-undef */
/**
 * /api/v1/financial-backfill — Deterministic backfill for invoice→sale ownership.
 *
 * Safely sets `invoices.deal_id` on CRM invoices that are missing it, but ONLY
 * when the relationship can be proven deterministically:
 *   - The invoice's lead_id has EXACTLY ONE deal → set deal_id to that deal.
 *   - The invoice's lead_id has ZERO deals → leave null (no sale to assign).
 *   - The invoice's lead_id has MULTIPLE deals → AMBIGUOUS, leave null.
 *
 * Also backfills `qb_invoice_sale_map.crm_sale_id` for cached QB invoices that
 * have a crm_lead_id but no crm_sale_id, using the same deterministic rule.
 *
 * NEVER guesses. NEVER uses amount as a disambiguator. Ambiguous records are
 * reported, not auto-assigned.
 *
 *   POST /api/v1/financial-backfill              — apply (permanent)
 *   POST /api/v1/financial-backfill?dry_run=true — dry run (no writes)
 *
 * Auth: Railway JWT (requireAuth). Admin/manager only.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth);
const requireAdminManager = requireRole('admin', 'manager');

router.post('/', requireAdminManager, async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === true;

    // 1. Find CRM invoices with NULL deal_id that have a lead_id
    const { rows: orphanedInvoices } = await query(`
      SELECT i.id, i.lead_id, i.invoice_number, i.amount,
             (SELECT COUNT(*) FROM deals d WHERE d.lead_id = i.lead_id) AS deal_count,
             (SELECT d.id FROM deals d WHERE d.lead_id = i.lead_id LIMIT 1) AS single_deal_id
      FROM invoices i
      WHERE i.deal_id IS NULL AND i.lead_id IS NOT NULL
    `);

    const safeAutoMap = orphanedInvoices.filter(i => Number(i.deal_count) === 1 && i.single_deal_id);
    const ambiguous = orphanedInvoices.filter(i => Number(i.deal_count) > 1);
    const noDeals = orphanedInvoices.filter(i => Number(i.deal_count) === 0);

    let updatedInvoices = 0;
    if (!dryRun) {
      for (const inv of safeAutoMap) {
        await query('UPDATE invoices SET deal_id = $1, updated_at = NOW() WHERE id = $2 AND deal_id IS NULL',
          [inv.single_deal_id, inv.id]);
        updatedInvoices++;
      }
    }

    // 2. Find qb_invoice_sale_map entries with empty crm_sale_id
    const { rows: orphanedMaps } = await query(`
      SELECT m.qb_invoice_id, m.crm_lead_id,
             (SELECT COUNT(*) FROM deals d WHERE d.lead_id = m.crm_lead_id::uuid) AS deal_count,
             (SELECT d.id::text FROM deals d WHERE d.lead_id = m.crm_lead_id::uuid LIMIT 1) AS single_deal_id
      FROM qb_invoice_sale_map m
      WHERE m.crm_sale_id IS NULL OR m.crm_sale_id = ''
    `);

    const safeMapAuto = orphanedMaps.filter(m => Number(m.deal_count) === 1 && m.single_deal_id);
    const ambiguousMaps = orphanedMaps.filter(m => Number(m.deal_count) > 1);

    let updatedMaps = 0;
    if (!dryRun) {
      for (const m of safeMapAuto) {
        await query('UPDATE qb_invoice_sale_map SET crm_sale_id = $1 WHERE qb_invoice_id = $2 AND (crm_sale_id IS NULL OR crm_sale_id = $3)',
          [m.single_deal_id, m.qb_invoice_id, '']);
        updatedMaps++;
      }
    }

    res.json({
      success: true,
      dry_run: dryRun,
      crm_invoices: {
        total_orphaned: orphanedInvoices.length,
        safe_auto_mapped: safeAutoMap.length,
        ambiguous: ambiguous.length,
        no_deals: noDeals.length,
        updated: updatedInvoices,
      },
      qb_sale_map: {
        total_orphaned: orphanedMaps.length,
        safe_auto_mapped: safeMapAuto.length,
        ambiguous: ambiguousMaps.length,
        updated: updatedMaps,
      },
      ambiguous_records: ambiguous.map(a => ({
        invoice_id: a.id,
        lead_id: a.lead_id,
        deal_count: Number(a.deal_count),
        invoice_number: a.invoice_number,
        amount: Number(a.amount),
      })),
    });
  } catch (e) {
    console.error('[financial-backfill] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;