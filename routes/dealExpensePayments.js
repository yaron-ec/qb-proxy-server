/* eslint-disable no-undef */
/**
 * /api/v1/deal-expense-payments — Railway CRM Deal Expense Payments API.
 *
 *   GET    /               list (filtered by expense_id, deal_id)
 *   GET    /:id            single
 *   POST   /               create (expense_id + deal_id required)
 *   PUT    /:id            update
 *   DELETE /:id            delete
 *
 * Auth: Railway JWT (requireAuth). Admin/manager full.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');

const router = express.Router();
router.use(requireAuth);

function serializePayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    deal_id: row.deal_id,
    expense_id: row.expense_id,
    payment_date: row.payment_date,
    amount: Number(row.amount) || 0,
    payment_method: row.payment_method,
    reference_number: row.reference_number,
    receipt_url: row.receipt_url,
    receipt_key: row.receipt_key,
    receipt_filename: row.receipt_filename,
    notes: row.notes,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = ['deal_id', 'expense_id', 'payment_date', 'amount', 'payment_method', 'reference_number', 'receipt_url', 'receipt_key', 'receipt_filename', 'notes'];

router.get('/', async (req, res) => {
  try {
    const { expense_id, deal_id, limit: limitStr } = req.query;
    // P0 DATA ISOLATION: deal_id is REQUIRED. Never return all payments across deals.
    if (!deal_id) return res.json({ items: [], total: 0 });
    if (!UUID_RE.test(String(deal_id))) return res.json({ items: [], total: 0 });
    const limit = Math.min(parseInt(limitStr || '2000', 10), 5000);
    const where = [`deal_id = $1`];
    const params = [deal_id];
    let p = 2;
    if (expense_id) { where.push(`expense_id = $${p}`); params.push(expense_id); p++; }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM deal_expense_payments ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializePayment), total: rows.length });
  } catch (e) {
    console.error('[deal-expense-payments] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.expense_id) return res.status(400).json({ error: 'expense_id required' });
    if (!body.deal_id) return res.status(400).json({ error: 'deal_id required' });
    if (body.amount === undefined) return res.status(400).json({ error: 'amount required' });

    const cols = ['created_by'];
    const vals = [req.user.email || null];
    for (const f of FIELDS) {
      if (body[f] !== undefined) { cols.push(f); vals.push(body[f]); }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO deal_expense_payments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    res.status(201).json({ payment: serializePayment(rows[0]) });
  } catch (e) {
    console.error('[deal-expense-payments] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM deal_expense_payments WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ payment: serializePayment(rows[0]) });
  } catch (e) {
    console.error('[deal-expense-payments] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
    const { rows } = await query(`UPDATE deal_expense_payments SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ payment: serializePayment(rows[0]) });
  } catch (e) {
    console.error('[deal-expense-payments] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await query('DELETE FROM deal_expense_payments WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[deal-expense-payments] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;