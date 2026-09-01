/* eslint-disable no-undef */
/**
 * /api/v1/handoff-estimates — Railway CRM Handoff Estimates API.
 *
 *   GET    /               list (filtered by lead_id, match_status, qb_estimate_id)
 *   GET    /:id            single
 *   POST   /               create (customer_name required)
 *   PUT    /:id            update
 *   DELETE /:id            delete (admin only)
 *
 * Auth: Railway JWT (requireAuth).
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');

const router = express.Router();
router.use(requireAuth);

function serializeEstimate(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    handoff_estimate_id: row.handoff_estimate_id,
    handoff_estimate_number: row.handoff_estimate_number,
    qb_estimate_id: row.qb_estimate_id,
    qb_estimate_number: row.qb_estimate_number,
    lead_id: row.lead_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    customer_email: row.customer_email,
    estimate_amount: Number(row.estimate_amount) || 0,
    estimate_status: row.estimate_status,
    estimate_date: row.estimate_date,
    document_url: row.document_url,
    document_title: row.document_title,
    pdf_url: row.pdf_url,
    pdf_status: row.pdf_status,
    pdf_retry_count: row.pdf_retry_count || 0,
    pdf_fetched_at: row.pdf_fetched_at,
    qb_app_url: row.qb_app_url,
    last_synced_at: row.last_synced_at,
    source: row.source,
    sync_source: row.sync_source,
    match_status: row.match_status,
    match_method: row.match_method,
    raw_payload: row.raw_payload,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = [
  'handoff_estimate_id', 'handoff_estimate_number', 'qb_estimate_id', 'qb_estimate_number',
  'lead_id', 'customer_name', 'customer_phone', 'customer_email', 'estimate_amount',
  'estimate_status', 'estimate_date', 'document_url', 'document_title', 'pdf_url',
  'pdf_status', 'pdf_retry_count', 'pdf_fetched_at', 'qb_app_url', 'last_synced_at',
  'source', 'sync_source', 'match_status', 'match_method', 'raw_payload',
];

router.get('/', async (req, res) => {
  try {
    const { lead_id, match_status, qb_estimate_id, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr || '500', 10), 2000);
    const where = [];
    const params = [];
    let p = 1;
    if (lead_id) {
      if (!UUID_RE.test(String(lead_id))) return res.json({ items: [], total: 0 });
      where.push(`lead_id = $${p}`); params.push(lead_id); p++;
    }
    if (match_status && match_status !== 'all') { where.push(`match_status = $${p}`); params.push(match_status); p++; }
    if (qb_estimate_id) { where.push(`qb_estimate_id = $${p}`); params.push(qb_estimate_id); p++; }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM handoff_estimates ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeEstimate), total: rows.length });
  } catch (e) {
    console.error('[handoff-estimates] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.customer_name) return res.status(400).json({ error: 'customer_name required' });

    const cols = [];
    const vals = [];
    for (const f of FIELDS) {
      if (body[f] !== undefined) { cols.push(f); vals.push(body[f]); }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO handoff_estimates (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    res.status(201).json({ estimate: serializeEstimate(rows[0]) });
  } catch (e) {
    console.error('[handoff-estimates] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM handoff_estimates WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ estimate: serializeEstimate(rows[0]) });
  } catch (e) {
    console.error('[handoff-estimates] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updates = [];
    const params = [];
    let p = 1;
    for (const f of FIELDS) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${p}`); p++; }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at = NOW()');
    params.push(req.params.id);
    const { rows } = await query(`UPDATE handoff_estimates SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ estimate: serializeEstimate(rows[0]) });
  } catch (e) {
    console.error('[handoff-estimates] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM handoff_estimates WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[handoff-estimates] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;