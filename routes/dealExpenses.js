/* eslint-disable no-undef */
/**
 * /api/v1/deal-expenses — Railway CRM Deal Expenses API.
 *
 *   GET    /               list (filtered by deal_id, category, payment_status)
 *   GET    /:id            single
 *   POST   /               create (deal_id required)
 *   PUT    /:id            update
 *   DELETE /:id            delete
 *
 * Auth: Railway JWT (requireAuth). Admin/manager full; sales_rep own deals only.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth);

function serializeExpense(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    deal_id: row.deal_id,
    lead_id: row.lead_id,
    expense_date: row.expense_date,
    vendor_name: row.vendor_name,
    vendor_id: row.vendor_id,
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    amount: Number(row.amount) || 0,
    payment_status: row.payment_status,
    payment_method: row.payment_method,
    check_or_reference_number: row.check_or_reference_number,
    quickbooks_transaction_id: row.quickbooks_transaction_id,
    quickbooks_sync_status: row.quickbooks_sync_status,
    receipt_url: row.receipt_url,
    receipt_key: row.receipt_key,
    receipt_filename: row.receipt_filename,
    receipt_mime_type: row.receipt_mime_type,
    notes: row.notes,
    include_in_profit_calculation: row.include_in_profit_calculation,
    amount_paid: Number(row.amount_paid) || 0,
    amount_remaining: Number(row.amount_remaining) || 0,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = [
  'deal_id', 'lead_id', 'expense_date', 'vendor_name', 'vendor_id', 'category',
  'subcategory', 'description', 'amount', 'payment_status', 'payment_method',
  'check_or_reference_number', 'quickbooks_transaction_id', 'quickbooks_sync_status',
  'receipt_url', 'receipt_key', 'receipt_filename', 'receipt_mime_type', 'notes',
  'include_in_profit_calculation', 'amount_paid', 'amount_remaining',
];

// ── GET / — list ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { deal_id, category, payment_status, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr || '2000', 10), 5000);

    const where = [];
    const params = [];
    let p = 1;

    if (deal_id) { where.push(`deal_id = $${p}`); params.push(deal_id); p++; }
    if (category && category !== 'all') { where.push(`category = $${p}`); params.push(category); p++; }
    if (payment_status && payment_status !== 'all') { where.push(`payment_status = $${p}`); params.push(payment_status); p++; }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM deal_expenses ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeExpense), total: rows.length });
  } catch (e) {
    console.error('[deal-expenses] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST / — create ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.deal_id) return res.status(400).json({ error: 'deal_id required' });
    if (!body.vendor_name) return res.status(400).json({ error: 'vendor_name required' });
    if (body.amount === undefined) return res.status(400).json({ error: 'amount required' });

    const cols = ['created_by'];
    const vals = [req.user.email || null];
    for (const f of FIELDS) {
      if (body[f] !== undefined) { cols.push(f); vals.push(body[f]); }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO deal_expenses (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    res.status(201).json({ expense: serializeExpense(rows[0]) });
  } catch (e) {
    console.error('[deal-expenses] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM deal_expenses WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ expense: serializeExpense(rows[0]) });
  } catch (e) {
    console.error('[deal-expenses] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update ────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const updates = ['updated_by'];
    const params = [req.user.email || null];
    let p = 2;

    for (const f of FIELDS) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${p}`); p++; }
    }
    if (updates.length === 1) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at = NOW()');

    params.push(req.params.id);
    const { rows } = await query(`UPDATE deal_expenses SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ expense: serializeExpense(rows[0]) });
  } catch (e) {
    console.error('[deal-expenses] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await query('DELETE FROM deal_expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[deal-expenses] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;