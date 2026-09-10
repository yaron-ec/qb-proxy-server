/* eslint-disable no-undef */
/**
 * /api/v1/users — Railway-native user management (admin-only).
 *
 *   GET    /api/v1/users          — list all users (admin-only)
 *   PUT    /api/v1/users/:id      — update user role/name/status (admin-only)
 *   DELETE /api/v1/users/:id      — delete user (admin-only, protects app owner)
 *
 * Auth: Railway JWT (requireAuth) + admin role (requireRole('admin')).
 * Returns: { items, users, count } for GET (both formats for frontend compat).
 *
 * Maps DB status ('active'/'disabled') ↔ frontend user_status ('active'/'deactivated').
 * Does NOT return password_hash, google_sub, or any secret.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth);

const requireAdmin = requireRole('admin');

// Idempotent: add owner_name column if it doesn't exist (non-destructive, additive).
// Runs once on module load. If it fails (DB not ready), the GET handler falls back
// to a query without owner_name.
let _ownerNameReady = null;
function ensureOwnerNameColumn() {
  if (!_ownerNameReady) {
    _ownerNameReady = query('ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_name TEXT')
      .then(() => true)
      .catch(() => false);
  }
  return _ownerNameReady;
}
ensureOwnerNameColumn();

// Map a DB row to the frontend-expected user object.
function mapUser(r) {
  return {
    id: r.id,
    email: r.email,
    primaryBusinessEmail: r.email,
    full_name: r.full_name,
    role: r.role,
    user_status: r.status === 'disabled' ? 'deactivated' : 'active',
    owner_name: r.owner_name || null,
    has_google_sso: r.google_sub != null,
    has_password: r.password_hash != null,
    created_date: r.created_at,
    updated_date: r.updated_at,
  };
}

// ── GET / — list all users (admin-only) ──────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    await ensureOwnerNameColumn();
    let rows;
    try {
      const result = await query(
        `SELECT id, email, full_name, role, status, owner_name,
                google_sub, password_hash, created_at, updated_at
         FROM users ORDER BY email`
      );
      rows = result.rows;
    } catch (e) {
      // Fallback: owner_name column might not exist yet — query without it
      const result = await query(
        `SELECT id, email, full_name, role, status,
                google_sub, password_hash, created_at, updated_at
         FROM users ORDER BY email`
      );
      rows = result.rows.map(r => ({ ...r, owner_name: null }));
    }
    const items = rows.map(mapUser);
    res.json({ items, users: items, count: items.length });
  } catch (e) {
    console.error('[users] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update user (admin-only) ──────────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role, full_name, user_status, owner_name } = req.body || {};

    const sets = [];
    const vals = [];
    let idx = 1;

    if (role !== undefined) {
      if (!['admin', 'manager', 'sales_rep', 'office', 'user'].includes(role)) {
        return res.status(400).json({ error: 'invalid role' });
      }
      sets.push(`role = $${idx++}`);
      vals.push(role);
    }
    if (full_name !== undefined) {
      sets.push(`full_name = $${idx++}`);
      vals.push(full_name || null);
    }
    if (user_status !== undefined) {
      const dbStatus = user_status === 'deactivated' ? 'disabled' : 'active';
      sets.push(`status = $${idx++}`);
      vals.push(dbStatus);
    }
    if (owner_name !== undefined) {
      await ensureOwnerNameColumn();
      sets.push(`owner_name = $${idx++}`);
      vals.push(owner_name || null);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    vals.push(id);
    const result = await query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${idx}
       RETURNING id, email, full_name, role, status, owner_name, google_sub, password_hash, created_at, updated_at`,
      vals
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'user not found' });
    }

    res.json({ user: mapUser(result.rows[0]) });
  } catch (e) {
    console.error('[users] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id — delete user (admin-only, protects app owner) ─────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await query('SELECT email, role FROM users WHERE id = $1', [id]);
    if (!rows[0]) {
      return res.status(404).json({ error: 'user not found' });
    }

    // Protect the app owner account
    if (rows[0].email === 'yaron@ecconstructiongroup.com') {
      return res.status(403).json({ error: 'Cannot delete the owner of the app' });
    }

    await query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ success: true, id });
  } catch (e) {
    console.error('[users] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;