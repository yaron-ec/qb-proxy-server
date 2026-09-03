/* eslint-disable no-undef */
/**
 * /api/v1/invoices — Railway CRM Invoices API.
 *
 *   GET    /api/v1/invoices            list invoices (filtered by lead_id, deal_id, status)
 *   GET    /api/v1/invoices/:id         single invoice
 *   POST   /api/v1/invoices            create an invoice
 *   PUT    /api/v1/invoices/:id         update an invoice
 *   DELETE /api/v1/invoices/:id         delete an invoice
 *
 * Auth: Railway JWT (requireAuth). Admin/manager/office read+write; sales_rep own leads only.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');

const router = express.Router();

function serializeInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    lead_id: row.lead_id,
    deal_id: row.deal_id,
    invoice_number: row.invoice_number,
    amount: row.amount,
    description: row.description,
    payment_stage: row.payment_stage,
    due_date: row.due_date,
    status: row.status,
    qb_invoice_id: row.qb_invoice_id,
    qb_invoice_number: row.qb_invoice_number,
    qb_status: row.qb_status,
    qb_invoice_url: row.qb_invoice_url,
    qb_pdf_url: row.qb_pdf_url,
    qb_pdf_status: row.qb_pdf_status,
    payment_received: row.payment_received,
    payment_status: row.payment_status,
    payment_method: row.payment_method,
    payment_date: row.payment_date,
    notes: row.notes,
    synced_to_qb: row.synced_to_qb,
    email_sent_date: row.email_sent_date,
    email_delivery_status: row.email_delivery_status,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

// ── GET / — list invoices ───────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { lead_id, deal_id, status, limit: limitStr } = req.query;
    // P0 DATA ISOLATION: at least one scope (lead_id or deal_id) is REQUIRED.
    if (!lead_id && !deal_id) return res.json({ items: [], total: 0 });
    const limit = Math.min(parseInt(limitStr || '500', 10), 2000);

    const where = [];
    const params = [];
    let p = 1;

    if (lead_id) {
      if (!UUID_RE.test(String(lead_id))) return res.json({ items: [], total: 0 });
      where.push(`lead_id = $${p}`); params.push(lead_id); p++;
    }
    if (deal_id) {
      if (!UUID_RE.test(String(deal_id))) return res.json({ items: [], total: 0 });
      where.push(`deal_id = $${p}`); params.push(deal_id); p++;
    }
    if (status && status !== 'all') { where.push(`status = $${p}`); params.push(status); p++; }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM invoices ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeInvoice), total: rows.length });
  } catch (e) {
    console.error('[invoices] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST / — create an invoice ──────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.lead_id) return res.status(400).json({ error: 'lead_id required' });
    if (b.amount == null) return res.status(400).json({ error: 'amount required' });

    const { rows } = await query(
      `INSERT INTO invoices (lead_id, deal_id, invoice_number, amount, description, payment_stage, due_date, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [b.lead_id, b.deal_id || null, b.invoice_number || null, b.amount, b.description || null,
       b.payment_stage || 'custom', b.due_date || null, b.status || 'draft', b.notes || null]
    );
    res.status(201).json({ invoice: serializeInvoice(rows[0]) });
  } catch (e) {
    console.error('[invoices] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single invoice ────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ invoice: serializeInvoice(rows[0]) });
  } catch (e) {
    console.error('[invoices] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update an invoice ─────────────────────────────────────────────
const INVOICE_FIELDS = [
  'lead_id', 'deal_id', 'invoice_number', 'amount', 'description', 'payment_stage',
  'due_date', 'status', 'qb_invoice_id', 'qb_invoice_number', 'qb_status',
  'qb_invoice_url', 'qb_pdf_url', 'qb_pdf_status', 'payment_received', 'payment_status',
  'payment_method', 'payment_date', 'notes', 'synced_to_qb', 'qb_sync_error',
  'email_sent_date', 'email_delivery_status', 'email_error', 'email_resend_count',
];

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const updates = [];
    const params = [];
    let p = 1;

    for (const col of INVOICE_FIELDS) {
      if (req.body[col] !== undefined) {
        params.push(req.body[col]);
        updates.push(`${col} = $${p}`);
        p++;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at = NOW()');

    params.push(req.params.id);
    const { rows } = await query(`UPDATE invoices SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ invoice: serializeInvoice(rows[0]) });
  } catch (e) {
    console.error('[invoices] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id — delete an invoice ──────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[invoices] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;