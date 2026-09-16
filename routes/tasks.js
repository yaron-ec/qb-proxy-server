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
const { checkLeadScope, checkDealScope } = require('../lib/recordAccess');

const router = express.Router();

// A task may be scoped by lead_id, by deal_id, or (rarely) neither. Resolve
// ownership via whichever scope the row actually carries; a task with
// neither is only visible to admin/manager (no ownership signal to check a
// sales_rep against — fail closed, not open).
async function checkTaskAccess(user, task, { allowReadOnly = true } = {}) {
  const role = String((user && user.role) || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return { allowed: true };
  if (task.lead_id) {
    const r = await checkLeadScope(user, task.lead_id);
    if (r.allowed && r.readOnly && !allowReadOnly) return { allowed: false, reason: 'read_only_role' };
    return r;
  }
  if (task.deal_id) return checkDealScope(user, task.deal_id);
  return { allowed: false, reason: 'unscoped_task' };
}

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

    // P0 DATA ISOLATION: at least one scope (lead_id or deal_id) is REQUIRED —
    // matches routes/activities.js / routes/invoices.js (never return all
    // tasks across every lead/deal). Beyond that sibling pattern (a known,
    // tracked gap per CLAUDE.md — those siblings check for a scope but not
    // ownership of it), also verify the caller actually owns the referenced
    // lead/deal: a sales_rep must not see another rep's tasks merely by
    // supplying a valid lead_id/deal_id they don't own.
    if (!lead_id && !deal_id) return res.json({ items: [], total: 0 });
    if (lead_id) {
      const access = await checkLeadScope(req.user, lead_id);
      if (!access.allowed) return res.json({ items: [], total: 0 });
    } else if (deal_id) {
      const access = await checkDealScope(req.user, deal_id);
      if (!access.allowed) return res.json({ items: [], total: 0 });
    }

    const where = [];
    const params = [];
    let p = 1;

    if (lead_id) { where.push(`lead_id = $${p}`); params.push(lead_id); p++; }
    if (deal_id) { where.push(`deal_id = $${p}`); params.push(deal_id); p++; }
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

    // A sales_rep must not be able to create a task against another rep's
    // lead/deal merely by knowing its id (matches the read-path checks below).
    if (lead_id) {
      const access = await checkLeadScope(req.user, lead_id);
      if (!access.allowed || access.readOnly) return res.status(403).json({ error: 'forbidden' });
    } else if (deal_id) {
      const access = await checkDealScope(req.user, deal_id);
      if (!access.allowed) return res.status(403).json({ error: 'forbidden' });
    }

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
    const access = await checkTaskAccess(req.user, rows[0]);
    if (!access.allowed) return res.status(403).json({ error: 'forbidden' });
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
    const existing = await query('SELECT id, lead_id, deal_id FROM tasks WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'not_found' });
    const access = await checkTaskAccess(req.user, existing.rows[0], { allowReadOnly: false });
    if (!access.allowed) return res.status(403).json({ error: 'forbidden' });

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
    const existing = await query('SELECT id, lead_id, deal_id FROM tasks WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'not_found' });
    const access = await checkTaskAccess(req.user, existing.rows[0], { allowReadOnly: false });
    if (!access.allowed) return res.status(403).json({ error: 'forbidden' });

    await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[tasks] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;