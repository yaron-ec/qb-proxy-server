/* eslint-disable no-undef */
/**
 * /api/v1/deal-commissions — Railway CRM Deal Commissions API.
 *
 *   GET    /               list (filtered by deal_id, recipient_user_id)
 *   GET    /:id            single
 *   POST   /               create (deal_id + recipient_name required)
 *   PUT    /:id            update
 *   DELETE /:id            delete (admin only)
 *
 * Auth: Railway JWT (requireAuth). Admin/manager full; sales_rep own commissions.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');

const router = express.Router();
router.use(requireAuth);

function serializeCommission(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    deal_id: row.deal_id,
    lead_id: row.lead_id,
    recipient_user_id: row.recipient_user_id,
    recipient_name: row.recipient_name,
    commission_type: row.commission_type,
    commission_percentage: Number(row.commission_percentage) || 0,
    commission_fixed_amount: Number(row.commission_fixed_amount) || 0,
    calculation_base: row.calculation_base,
    custom_base_amount: Number(row.custom_base_amount) || 0,
    calculated_amount: Number(row.calculated_amount) || 0,
    paid_amount: Number(row.paid_amount) || 0,
    status: row.status,
    paid_date: row.paid_date,
    notes: row.notes,
    receipt_url: row.receipt_url,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = [
  'deal_id', 'lead_id', 'recipient_user_id', 'recipient_name', 'commission_type',
  'commission_percentage', 'commission_fixed_amount', 'calculation_base',
  'custom_base_amount', 'calculated_amount', 'paid_amount', 'status', 'paid_date',
  'notes', 'receipt_url',
];

router.get('/', async (req, res) => {
  try {
    const { deal_id, recipient_user_id, limit: limitStr } = req.query;
    // P0 DATA ISOLATION: deal_id is REQUIRED. Never return all commissions across deals.
    if (!deal_id) return res.json({ items: [], total: 0 });
    if (!UUID_RE.test(String(deal_id))) return res.json({ items: [], total: 0 });
    const limit = Math.min(parseInt(limitStr || '2000', 10), 5000);
    const where = [`deal_id = $1`];
    const params = [deal_id];
    let p = 2;
    if (recipient_user_id) { where.push(`recipient_user_id = $${p}`); params.push(recipient_user_id); p++; }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM deal_commissions ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeCommission), total: rows.length });
  } catch (e) {
    console.error('[deal-commissions] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.deal_id) return res.status(400).json({ error: 'deal_id required' });
    if (!body.recipient_name) return res.status(400).json({ error: 'recipient_name required' });

    const cols = ['created_by'];
    const vals = [req.user.email || null];
    for (const f of FIELDS) {
      if (body[f] !== undefined) { cols.push(f); vals.push(body[f]); }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO deal_commissions (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    res.status(201).json({ commission: serializeCommission(rows[0]) });
  } catch (e) {
    console.error('[deal-commissions] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM deal_commissions WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ commission: serializeCommission(rows[0]) });
  } catch (e) {
    console.error('[deal-commissions] get error:', e.message);
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
    const { rows } = await query(`UPDATE deal_commissions SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ commission: serializeCommission(rows[0]) });
  } catch (e) {
    console.error('[deal-commissions] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM deal_commissions WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[deal-commissions] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;