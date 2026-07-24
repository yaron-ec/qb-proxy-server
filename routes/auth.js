/* eslint-disable no-undef */
/**
 * /api/v1/auth — Railway authentication routes (PERMANENT).
 *
 *   POST /login      { email, password }            -> { access, refresh, user }
 *   POST /refresh    { refresh }                    -> { access, refresh, user }
 *   POST /logout     { refresh }                    -> { ok }
 *   GET  /me                                        -> { user }
 *   POST /migrate    { base44_token }   [TEMPORARY] -> { access, refresh, user }
 *
 * /migrate is the ONLY Base44-dependent route and is explicitly temporary:
 * it seeds the Railway users table from Base44 once, then must be deleted
 * in Stage 9. It is isolated to this single route handler so removal is a
 * one-line deletion with no other code depending on it.
 */
'use strict';

const express = require('express');
const auth = require('../lib/authService');
const b44 = require('../lib/base44');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await auth.authenticatePassword(email, password);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const session = await auth.issueSession(user);
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refresh } = req.body || {};
    if (!refresh) return res.status(400).json({ error: 'refresh token required' });
    const session = await auth.rotateRefreshToken(refresh);
    res.json(session);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const { refresh } = req.body || {};
    if (refresh) await auth.revokeRefreshToken(refresh);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', require('../lib/rbac').requireAuth, async (req, res) => {
  try {
    const user = await auth.getUserById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ user: auth.publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── [TEMPORARY] Base44 → Railway user migration bridge ──────────────────────
// Accepts a Base44 user access token, resolves the Base44 user, and seeds
// (or matches) a Railway user row, then issues a Railway session.
// REMOVAL: delete this route handler in Stage 9 (after all users are
// provisioned in Railway). Nothing else in the codebase depends on it.
router.post('/migrate', async (req, res) => {
  try {
    const { base44_token } = req.body || {};
    if (!base44_token) return res.status(400).json({ error: 'base44_token required' });
    if (!b44.isConfigured()) return res.status(503).json({ error: 'Base44 bridge not configured (temporary)' });

    // Resolve the Base44 user from their token via the Base44 auth endpoint.
    // This is the ONLY Base44 call in the auth path and exists solely to seed
    // the Railway users table once.
    const meRes = await fetch(`${process.env.BASE44_API_URL || 'https://api.base44.com'}/auth/me`, {
      headers: { Authorization: `Bearer ${base44_token}`, 'X-App-ID': process.env.BASE44_APP_ID },
    });
    if (!meRes.ok) return res.status(401).json({ error: 'Base44 token invalid' });
    const bUser = await meRes.json().catch(() => ({}));
    const email = bUser.email;
    if (!email) return res.status(400).json({ error: 'Base44 user has no email' });

    let user = await auth.getUserByEmail(email);
    if (!user) {
      const role = ['admin', 'manager', 'sales_rep', 'office'].includes(bUser.role) ? bUser.role : 'user';
      const ins = await require('../db/client').query(
        `INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3)
         ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = NOW()
         RETURNING *`,
        [email, bUser.full_name || bUser.name || null, role]
      );
      user = ins.rows[0];
    }
    const session = await auth.issueSession(user);
    res.json({ ...session, migrated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ── END [TEMPORARY] bridge ────────────────────────────────────────────────────

module.exports = router;