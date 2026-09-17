/* eslint-disable no-undef */
/**
 * /api/v1/owners — Sales-rep / owner directory (R1A foundation).
 *
 *   GET   /api/v1/owners      -> { items }  (active owners: id, email, display_name)
 *   PATCH /api/v1/owners/:id  -> { owner }  (admin-only: edit email/display_name)
 *
 * Auth: Railway JWT (requireAuth). All authenticated users can list owners
 * (needed for the owner-filter dropdown on the Leads page). PATCH is
 * admin-only — it edits the address used as Reply-To for CRM-sent email
 * (ActivityComposer.jsx's resolveOwnerEmail) and shown in the Owner
 * Directory Settings tab.
 *
 * This `owners` table is NOT the authentication table (`users`, via
 * lib/authService.js/rbac.js) — editing a row here changes contact/Reply-To
 * data only and can never affect login, role, or session identity. Until
 * this route existed there was no application path at all to correct a
 * stale owners.email value (e.g. a legacy personal address preserved from
 * the original Base44 migration) — only a direct DB edit, which is exactly
 * what this route exists to make unnecessary.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, display_name, is_active
       FROM owners
       WHERE is_active = true
       ORDER BY display_name ASC NULLS LAST, email ASC`
    );
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        display_name: r.display_name || r.email,
        is_active: r.is_active,
      })),
    });
  } catch (e) {
    console.error('[owners] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.patch('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, display_name } = req.body || {};
    if (email === undefined && display_name === undefined) {
      return res.status(400).json({ error: 'email or display_name required' });
    }
    if (email !== undefined && !EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'invalid email' });
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (email !== undefined) { sets.push(`email = $${i++}`); vals.push(String(email).trim().toLowerCase()); }
    if (display_name !== undefined) { sets.push(`display_name = $${i++}`); vals.push(display_name ? String(display_name).trim() : null); }
    vals.push(id);

    const { rows } = await query(
      `UPDATE owners SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, email, display_name, is_active`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ owner: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email already in use by another owner' });
    console.error('[owners] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;