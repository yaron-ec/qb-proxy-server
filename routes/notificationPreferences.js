/* eslint-disable no-undef */
/**
 * /api/v1/notification-preferences — admin-managed, per-user notification
 * category opt-out (CRM STABILITY PHASE, Section H).
 *
 *   GET  /api/v1/notification-preferences              — full matrix (all users x all categories)
 *   GET  /api/v1/notification-preferences/:userEmail   — one user's preferences
 *   PUT  /api/v1/notification-preferences/:userEmail    — set one category's enabled flag
 *                                                          Body: { category, enabled }
 *
 * Auth: Railway JWT (requireAuth), admin only — this changes what OTHER
 * staff members receive, not a self-service setting.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const notificationPreferences = require('../lib/notificationPreferences');

const router = express.Router();
router.use(requireAuth);
const requireAdmin = requireRole('admin');

router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await notificationPreferences.listAllPreferences();
    res.json({ categories: notificationPreferences.CATEGORIES, overrides: rows });
  } catch (e) {
    console.error('[notification-preferences] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:userEmail', requireAdmin, async (req, res) => {
  try {
    const preferences = await notificationPreferences.getPreferencesForUser(req.params.userEmail);
    res.json({ user_email: req.params.userEmail, preferences });
  } catch (e) {
    console.error('[notification-preferences] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:userEmail', requireAdmin, async (req, res) => {
  try {
    const { category, enabled } = req.body || {};
    if (!category) return res.status(400).json({ error: 'category required' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    await notificationPreferences.setPreference(req.params.userEmail, category, enabled);
    const preferences = await notificationPreferences.getPreferencesForUser(req.params.userEmail);
    res.json({ success: true, user_email: req.params.userEmail, preferences });
  } catch (e) {
    if (String(e.message || '').startsWith('unknown category')) {
      return res.status(400).json({ error: e.message });
    }
    console.error('[notification-preferences] set error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
