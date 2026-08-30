/* eslint-disable no-undef */
/**
 * /api/v1/settings — Railway CRM Settings API (singleton app_lists JSONB).
 *
 *   GET    /           list settings (returns singleton app_lists as single item)
 *   GET    /:key       get a setting by key (app_lists returns the full object)
 *   PUT    /:key       upsert a setting (admin only)
 *   DELETE /:key       delete a setting (admin only)
 *
 * Auth: Railway JWT (requireAuth). Admin/manager read; admin write.
 *
 * The settings table is a singleton (id=1) with an app_lists JSONB column
 * that stores all app-level configuration (project types, sources, columns, etc.).
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();

function requireAdmin(req, res, next) {
  const role = String((req.user && req.user.role) || '').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'admin_required' });
  next();
}

function requireAdminOrManager(req, res, next) {
  const role = String((req.user && req.user.role) || '').toLowerCase();
  if (role !== 'admin' && role !== 'manager') return res.status(403).json({ error: 'forbidden' });
  next();
}

// ── GET / — list all settings ──
router.get('/', requireAuth, requireAdminOrManager, async (req, res) => {
  try {
    const { rows } = await query('SELECT app_lists FROM settings WHERE id = 1');
    const appLists = (rows[0] && rows[0].app_lists) || {};
    res.json({ items: [{ key: 'app_lists', value: appLists, type: 'statuses' }] });
  } catch (e) {
    console.error('[settings] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:key — get a specific setting ──
router.get('/:key', requireAuth, requireAdminOrManager, async (req, res) => {
  try {
    const { key } = req.params;
    const { rows } = await query('SELECT app_lists FROM settings WHERE id = 1');
    const appLists = (rows[0] && rows[0].app_lists) || {};
    if (key === 'app_lists') {
      return res.json({ key: 'app_lists', value: appLists, type: 'statuses' });
    }
    // Support arbitrary keys stored as top-level keys within app_lists
    if (appLists[key] !== undefined) {
      return res.json({ key, value: appLists[key], type: 'statuses' });
    }
    res.status(404).json({ error: 'not_found' });
  } catch (e) {
    console.error('[settings] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:key — upsert a setting (admin only) ──
router.put('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value, type = 'statuses' } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: 'value required' });

    if (key === 'app_lists') {
      // Replace the entire app_lists JSONB singleton
      const { rows } = await query(
        'UPDATE settings SET app_lists = $1::jsonb, updated_at = NOW() WHERE id = 1 RETURNING app_lists',
        [JSON.stringify(value)]
      );
      return res.json({ key: 'app_lists', value: rows[0].app_lists, type });
    }

    // For arbitrary keys, store as a top-level key within app_lists JSONB
    const { rows } = await query(
      `UPDATE settings SET app_lists = jsonb_set(COALESCE(app_lists, '{}'::jsonb), $1, $2::jsonb, true), updated_at = NOW() WHERE id = 1 RETURNING app_lists`,
      ['{" + key + "}', JSON.stringify(value)]
    );
    res.json({ key, value, type });
  } catch (e) {
    console.error('[settings] put error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:key — delete a setting (admin only) ──
router.delete('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    if (key === 'app_lists') {
      await query('UPDATE settings SET app_lists = \'{}\'::jsonb, updated_at = NOW() WHERE id = 1');
    } else {
      await query(
        'UPDATE settings SET app_lists = app_lists - $1, updated_at = NOW() WHERE id = 1',
        [key]
      );
    }
    res.json({ success: true, key });
  } catch (e) {
    console.error('[settings] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
