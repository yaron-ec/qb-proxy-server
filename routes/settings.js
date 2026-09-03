/* eslint-disable no-undef */
/**
 * /api/v1/settings — Railway CRM Settings API.
 *
 *   GET  /api/v1/settings           list all settings (admin/manager only)
 *   GET  /api/v1/settings/:key      get a specific setting by key
 *   PUT  /api/v1/settings/:key      upsert a setting (admin only)
 *   DELETE /api/v1/settings/:key    delete a setting (admin only)
 *
 * Auth: Railway JWT (requireAuth). Admin/manager read; admin write.
 *
 * The settings table stores app-level configuration: column layouts, status
 * lists, project types, sources, etc. Each row has a key, value (JSONB), and type.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();

// Admin-only write check
function requireAdmin(req, res, next) {
  const role = String((req.user && req.user.role) || '').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'admin_required' });
  next();
}

// Admin/manager read check
function requireAdminOrManager(req, res, next) {
  const role = String((req.user && req.user.role) || '').toLowerCase();
  if (role !== 'admin' && role !== 'manager') return res.status(403).json({ error: 'forbidden' });
  next();
}

// ── GET / — list all settings ──────────────────────────────────────────────
router.get('/', requireAuth, requireAdminOrManager, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM app_settings ORDER BY key ASC');
    res.json({ items: rows.map(r => ({ key: r.key, value: r.value, type: r.type })) });
  } catch (e) {
    console.error('[settings] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:key — get a specific setting ────────────────────────────────────
router.get('/:key', requireAuth, requireAdminOrManager, async (req, res) => {
  try {
    const { key } = req.params;
    const { rows } = await query('SELECT * FROM app_settings WHERE key = $1', [key]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ key: rows[0].key, value: rows[0].value, type: rows[0].type });
  } catch (e) {
    console.error('[settings] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:key — upsert a setting (admin only) ─────────────────────────────
router.put('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value, type = 'columns' } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: 'value required' });

    const { rows } = await query(
      `INSERT INTO app_settings (key, value, type)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, type = $3, updated_at = NOW()
       RETURNING *`,
      [key, JSON.stringify(value), type]
    );
    res.json({ key: rows[0].key, value: rows[0].value, type: rows[0].type });
  } catch (e) {
    console.error('[settings] put error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:key — delete a setting (admin only) ──────────────────────────
router.delete('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    await query('DELETE FROM app_settings WHERE key = $1', [key]);
    res.json({ success: true, key });
  } catch (e) {
    console.error('[settings] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;