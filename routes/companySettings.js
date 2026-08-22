/* eslint-disable no-undef */
/**
 * /api/v1/company-settings — Railway CRM Company Settings API (singleton).
 *
 *   GET    /               get the singleton company settings row
 *   PUT    /               upsert company settings (admin only)
 *   DELETE /               delete company settings (admin only)
 *
 * Auth: Railway JWT (requireAuth). Admin read+write; others read-only.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth);

function serializeSettings(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_name: row.company_name,
    company_logo_url: row.company_logo_url,
    company_email: row.company_email,
    company_phone: row.company_phone,
    company_address: row.company_address,
    company_city: row.company_city,
    company_state: row.company_state,
    company_zip: row.company_zip,
    admin_name: row.admin_name,
    admin_email: row.admin_email,
    company_website: row.company_website,
    crm_activity_notifications_enabled: row.crm_activity_notifications_enabled || false,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = [
  'company_name', 'company_logo_url', 'company_email', 'company_phone',
  'company_address', 'company_city', 'company_state', 'company_zip',
  'admin_name', 'admin_email', 'company_website', 'crm_activity_notifications_enabled',
];

// ── GET / — get singleton ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM company_settings ORDER BY created_at ASC LIMIT 1');
    if (!rows[0]) return res.json({ settings: null });
    res.json({ settings: serializeSettings(rows[0]) });
  } catch (e) {
    console.error('[company-settings] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT / — upsert (admin only) ──────────────────────────────────────────────
router.put('/', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const existing = await query('SELECT id FROM company_settings ORDER BY created_at ASC LIMIT 1');

    if (existing.rows[0]) {
      // Update existing
      const updates = [];
      const params = [];
      let p = 1;
      for (const f of FIELDS) {
        if (body[f] !== undefined) {
          params.push(f === 'crm_activity_notifications_enabled' ? (body[f] === true || body[f] === 'true') : body[f]);
          updates.push(`${f} = $${p}`);
          p++;
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
      updates.push('updated_at = NOW()');
      params.push(existing.rows[0].id);
      const { rows } = await query(`UPDATE company_settings SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
      return res.json({ settings: serializeSettings(rows[0]) });
    }

    // Create new singleton
    if (!body.company_name) return res.status(400).json({ error: 'company_name required for initial setup' });
    const cols = [];
    const vals = [];
    for (const f of FIELDS) {
      if (body[f] !== undefined) {
        cols.push(f);
        vals.push(f === 'crm_activity_notifications_enabled' ? (body[f] === true || body[f] === 'true') : body[f]);
      }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO company_settings (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    res.status(201).json({ settings: serializeSettings(rows[0]) });
  } catch (e) {
    console.error('[company-settings] put error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE / — delete (admin only) ───────────────────────────────────────────
router.delete('/', requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM company_settings');
    res.json({ success: true });
  } catch (e) {
    console.error('[company-settings] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;