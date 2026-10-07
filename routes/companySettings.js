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
const companyConfig = require('../lib/companyConfig');

const router = express.Router();
router.use(requireAuth);

// Modules a company can independently enable/disable — mirrors
// company_settings.enabled_modules (migration 2026-44) and
// docs/CONFIGURATION_REFERENCE.md. Kept as an explicit allowlist so a PUT
// body can never inject an arbitrary key into stored JSON.
const MODULE_KEYS = ['quickbooks', 'gmail', 'google_calendar', 'google_contacts', 'signnow', 'handoff', 'meta', 'sms', 'website_intake'];

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
    // Operational region label (e.g. "SoCal", "NorCal", "SoCal + NorCal")
    // — a display-only string, not a tenancy/routing concept. NULL means
    // not configured; consumers fall back to company_city/company_state.
    company_region: row.company_region || null,
    admin_name: row.admin_name,
    admin_email: row.admin_email,
    company_website: row.company_website,
    crm_activity_notifications_enabled: row.crm_activity_notifications_enabled || false,
    // PRODUCTIZATION FOUNDATION fields (migration 2026-44) — see
    // lib/companyConfig.js and docs/CONFIGURATION_REFERENCE.md. All optional;
    // NULL/default means "use the product default", never a broken installation.
    legal_name: row.legal_name || null,
    dba: row.dba || null,
    company_slug: row.company_slug || null,
    currency: row.currency || 'USD',
    favicon_url: row.favicon_url || null,
    brand_primary_color: row.brand_primary_color || null,
    timezone: row.timezone,
    locale: row.locale,
    business_hours: row.business_hours || null,
    appointment_travel_buffer_minutes: row.appointment_travel_buffer_minutes,
    enabled_modules: row.enabled_modules || null,
    installation_id: row.installation_id || null,
    // PRODUCTIZATION PHASE 2 fields (migration 2026-45) — see
    // lib/notificationRecipients.js. NULL/default falls back to admin_email
    // (recipients/default owner) or "<company_name> CRM" (sender name) —
    // never a hardcoded EC value for a database that configures these.
    notification_recipients: row.notification_recipients || { to: [], cc: [] },
    email_from_name: row.email_from_name || null,
    default_owner_email: row.default_owner_email || null,
    default_owner_name: row.default_owner_name || null,
    protected_admin_emails: row.protected_admin_emails || [],
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = [
  'company_name', 'company_logo_url', 'company_email', 'company_phone',
  'company_address', 'company_city', 'company_state', 'company_zip',
  'admin_name', 'admin_email', 'company_website', 'crm_activity_notifications_enabled',
  'company_region',
  'legal_name', 'dba', 'company_slug', 'currency', 'favicon_url', 'brand_primary_color',
  'timezone', 'locale', 'business_hours', 'appointment_travel_buffer_minutes', 'enabled_modules',
  'notification_recipients', 'email_from_name', 'default_owner_email', 'default_owner_name',
  'protected_admin_emails',
];

// Columns stored as JSONB — bound with an explicit ::jsonb cast and
// JSON.stringify'd before binding.
const JSONB_FIELDS = new Set(['business_hours', 'enabled_modules', 'notification_recipients', 'protected_admin_emails']);

// Fields whose value must be serialized (JSON columns) or validated before
// being bound as a query parameter.
function coerceFieldValue(field, value) {
  if (field === 'crm_activity_notifications_enabled') return value === true || value === 'true';
  if (field === 'business_hours') return value === null ? null : JSON.stringify(value);
  if (field === 'enabled_modules') {
    if (value === null) return null;
    const out = {};
    for (const k of MODULE_KEYS) out[k] = value[k] === true;
    return JSON.stringify(out);
  }
  if (field === 'notification_recipients') {
    if (value === null) return JSON.stringify({ to: [], cc: [] });
    const to = Array.isArray(value.to) ? value.to.filter((e) => typeof e === 'string' && e) : [];
    const cc = Array.isArray(value.cc) ? value.cc.filter((e) => typeof e === 'string' && e) : [];
    return JSON.stringify({ to, cc });
  }
  if (field === 'protected_admin_emails') {
    if (value === null) return JSON.stringify([]);
    return JSON.stringify(Array.isArray(value) ? value.filter((e) => typeof e === 'string' && e) : []);
  }
  if (field === 'appointment_travel_buffer_minutes') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 60;
  }
  return value;
}

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
          params.push(coerceFieldValue(f, body[f]));
          updates.push(JSONB_FIELDS.has(f) ? `${f} = $${p}::jsonb` : `${f} = $${p}`);
          p++;
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
      updates.push('updated_at = NOW()');
      params.push(existing.rows[0].id);
      const { rows } = await query(`UPDATE company_settings SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
      companyConfig.invalidate();
      return res.json({ settings: serializeSettings(rows[0]) });
    }

    // Create new singleton
    if (!body.company_name) return res.status(400).json({ error: 'company_name required for initial setup' });
    const cols = [];
    const vals = [];
    const placeholderFor = [];
    for (const f of FIELDS) {
      if (body[f] !== undefined) {
        cols.push(f);
        vals.push(coerceFieldValue(f, body[f]));
        placeholderFor.push(f);
      }
    }
    const placeholders = placeholderFor.map((f, i) => JSONB_FIELDS.has(f) ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO company_settings (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    companyConfig.invalidate();
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
    companyConfig.invalidate();
    res.json({ success: true });
  } catch (e) {
    console.error('[company-settings] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;