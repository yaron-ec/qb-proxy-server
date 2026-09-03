/* eslint-disable no-undef */
/**
 * /api/v1/activities — Railway CRM Activities API.
 *
 *   GET    /api/v1/activities               list (filtered by lead_id, type, source)
 *   GET    /api/v1/activities/:id            single activity
 *   POST   /api/v1/activities               create
 *   PUT    /api/v1/activities/:id            update
 *   DELETE /api/v1/activities/:id            delete
 *
 * Auth: Railway JWT (requireAuth). Owner-scoped via lead_id.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');

const router = express.Router();

function serializeActivity(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    lead_id: row.lead_id,
    type: row.type,
    content: row.content,
    author: row.author,
    source: row.source,
    metadata: row.metadata || {},
    timestamp: row.created_at,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

// ── GET / — list activities ──────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { lead_id, type, source, sort = '-created_date', limit: limitStr } = req.query;
    // P0 DATA ISOLATION: lead_id is REQUIRED. Never return all activities across leads.
    if (!lead_id) return res.json({ items: [], total: 0 });
    if (!UUID_RE.test(String(lead_id))) return res.json({ items: [], total: 0 });
    const limit = Math.min(parseInt(limitStr || '500', 10), 2000);

    const where = [`lead_id = $1`];
    const params = [lead_id];
    let p = 2;

    if (type && type !== 'all') { where.push(`type = $${p}`); params.push(type); p++; }
    if (source && source !== 'all') { where.push(`source = $${p}`); params.push(source); p++; }

    const whereClause = `WHERE ${where.join(' AND ')}`;
    const { rows } = await query(`SELECT * FROM activities ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeActivity), total: rows.length });
  } catch (e) {
    console.error('[activities] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST / — create ──────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { lead_id, type, content, author, source = 'manual', metadata } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id required' });
    if (!UUID_RE.test(String(lead_id))) return res.status(400).json({ error: 'invalid_lead_id', message: 'lead_id must be a valid Railway UUID' });
    if (!type) return res.status(400).json({ error: 'type required' });
    if (!content) return res.status(400).json({ error: 'content required' });

    const validTypes = ['note', 'call', 'email', 'meeting', 'task'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid activity type' });

    const { rows } = await query(
      `INSERT INTO activities (lead_id, type, content, author, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [lead_id, type, content, author || req.user.email || null, source, JSON.stringify(metadata || null)]
    );
    res.status(201).json({ activity: serializeActivity(rows[0]) });
  } catch (e) {
    console.error('[activities] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single ─────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM activities WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ activity: serializeActivity(rows[0]) });
  } catch (e) {
    console.error('[activities] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update ─────────────────────────────────────────────────────────
const ACTIVITY_FIELDS = ['type', 'content', 'author', 'source', 'metadata'];

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const updates = [];
    const params = [];
    let p = 1;

    for (const col of ACTIVITY_FIELDS) {
      if (req.body[col] !== undefined) {
        params.push(col === 'metadata' ? JSON.stringify(req.body[col]) : req.body[col]);
        updates.push(`${col} = $${p}`);
        p++;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at = NOW()');

    params.push(req.params.id);
    const { rows } = await query(`UPDATE activities SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ activity: serializeActivity(rows[0]) });
  } catch (e) {
    console.error('[activities] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM activities WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[activities] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;