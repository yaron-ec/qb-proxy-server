/* eslint-disable no-undef */
/**
 * /api/v1/deal-loan-payments — Railway CRM Deal Loan Payments API.
 *
 *   GET    /               list (filtered by deal_id)
 *   GET    /:id            single
 *   POST   /               create (deal_id + payment_date + total_payment_amount required)
 *   PUT    /:id            update
 *   DELETE /:id            delete (admin only)
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

function serializeLoanPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    deal_id: row.deal_id,
    lead_id: row.lead_id,
    payment_date: row.payment_date,
    lender_name: row.lender_name,
    loan_account_name: row.loan_account_name,
    total_payment_amount: Number(row.total_payment_amount) || 0,
    principal_amount: Number(row.principal_amount) || 0,
    interest_amount: Number(row.interest_amount) || 0,
    fee_amount: Number(row.fee_amount) || 0,
    other_cost_amount: Number(row.other_cost_amount) || 0,
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

const FIELDS = [
  'deal_id', 'lead_id', 'payment_date', 'lender_name', 'loan_account_name',
  'total_payment_amount', 'principal_amount', 'interest_amount', 'fee_amount',
  'other_cost_amount', 'reference_number', 'receipt_url', 'receipt_key',
  'receipt_filename', 'notes',
];

router.get('/', async (req, res) => {
  try {
    const { deal_id, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr || '2000', 10), 5000);
    const where = [];
    const params = [];
    let p = 1;
    if (deal_id) {
      if (!UUID_RE.test(String(deal_id))) return res.json({ items: [], total: 0 });
      where.push(`deal_id = $${p}`); params.push(deal_id); p++;
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM deal_loan_payments ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeLoanPayment), total: rows.length });
  } catch (e) {
    console.error('[deal-loan-payments] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.deal_id) return res.status(400).json({ error: 'deal_id required' });
    if (!body.payment_date) return res.status(400).json({ error: 'payment_date required' });
    if (body.total_payment_amount === undefined) return res.status(400).json({ error: 'total_payment_amount required' });

    const cols = ['created_by'];
    const vals = [req.user.email || null];
    for (const f of FIELDS) {
      if (body[f] !== undefined) { cols.push(f); vals.push(body[f]); }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO deal_loan_payments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    res.status(201).json({ loanPayment: serializeLoanPayment(rows[0]) });
  } catch (e) {
    console.error('[deal-loan-payments] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM deal_loan_payments WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ loanPayment: serializeLoanPayment(rows[0]) });
  } catch (e) {
    console.error('[deal-loan-payments] get error:', e.message);
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
    const { rows } = await query(`UPDATE deal_loan_payments SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ loanPayment: serializeLoanPayment(rows[0]) });
  } catch (e) {
    console.error('[deal-loan-payments] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM deal_loan_payments WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[deal-loan-payments] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;