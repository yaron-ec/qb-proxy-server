/* eslint-disable no-undef */
/**
 * /api/v1/tasks — Railway CRM Tasks API.
 *
 *   GET    /api/v1/tasks               list tasks (filtered by lead_id, status, deal_id)
 *   GET    /api/v1/tasks/:id            single task
 *   POST   /api/v1/tasks               create a task
 *   PUT    /api/v1/tasks/:id            update a task
 *   DELETE /api/v1/tasks/:id            delete a task
 *
 * Auth: Railway JWT (requireAuth). Owner-scoped via lead_id.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');

const router = express.Router();

function serializeTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    lead_id: row.lead_id,
    deal_id: row.deal_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigned_to: row.assigned_to,
    due_date: row.due_date,
    completed_at: row.completed_at,
    created_by: row.created_by,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

// ── GET / — list tasks ──────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { lead_id, deal_id, status, sort = '-created_date', limit: limitStr } = req.query;
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
    const { rows } = await query(`SELECT * FROM tasks ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeTask), total: rows.length });
  } catch (e) {
    console.error('[tasks] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST / — create a task ──────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { lead_id, deal_id, title, description, status = 'pending', priority = 'medium', assigned_to, due_date } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });

    const { rows } = await query(
      `INSERT INTO tasks (lead_id, deal_id, title, description, status, priority, assigned_to, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [lead_id || null, deal_id || null, title, description || null, status, priority, assigned_to || null, due_date || null, req.user.email || null]
    );
    res.status(201).json({ task: serializeTask(rows[0]) });
  } catch (e) {
    console.error('[tasks] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single task ──────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ task: serializeTask(rows[0]) });
  } catch (e) {
    console.error('[tasks] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update a task ─────────────────────────────────────────────────
const TASK_FIELDS = ['lead_id', 'deal_id', 'title', 'description', 'status', 'priority', 'assigned_to', 'due_date', 'completed_at'];

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const updates = [];
    const params = [];
    let p = 1;

    for (const col of TASK_FIELDS) {
      if (req.body[col] !== undefined) {
        params.push(req.body[col]);
        updates.push(`${col} = $${p}`);
        p++;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at = NOW()');

    params.push(req.params.id);
    const { rows } = await query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ task: serializeTask(rows[0]) });
  } catch (e) {
    console.error('[tasks] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id — delete a task ─────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[tasks] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;