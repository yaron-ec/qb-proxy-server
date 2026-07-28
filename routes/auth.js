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

    // Authoritative verification: email + role come ONLY from Base44's verified
    // /auth/me response, never from the browser. See lib/base44TokenVerify.js.
    const verified = await require('../lib/base44TokenVerify').verifyBase44Token(base44_token);

    let user = await auth.getUserByEmail(verified.email);
    if (user) {
      // EXISTING Railway user: their stored Railway role ALWAYS wins. A Base44
      // sales_rep can never exchange into admin, and an admin demoted in
      // Railway keeps the Railway role. Disabled users are rejected.
      if (user.status !== 'active') return res.status(403).json({ error: 'account disabled' });
    } else {
      // NEW user: role from the verified Base44 token only (never browser-supplied),
      // defaulting to 'user' if Base44 reported an unrecognized role.
      const role = verified.role || 'user';
      const ins = await require('../db/client').query(
        `INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3)
         ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = NOW()
         RETURNING *`,
        [verified.email, verified.full_name, role]
      );
      user = ins.rows[0];
    }
    const session = await auth.issueSession(user);
    res.json({ ...session, migrated: true });
  } catch (e) {
    const code = e && e.code;
    if (code === 'missing_token') return res.status(400).json({ error: 'base44_token required' });
    if (code === 'bridge_unavailable' || code === 'base44_unavailable') return res.status(503).json({ error: 'authentication bridge unavailable' });
    if (code === 'invalid_token') return res.status(401).json({ error: 'Base44 token invalid' });
    if (code === 'no_email') return res.status(400).json({ error: 'verified user has no email' });
    res.status(500).json({ error: e.message });
  }
});
// ── END [TEMPORARY] bridge ────────────────────────────────────────────────────

module.exports = router;