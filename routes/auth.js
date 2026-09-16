/* eslint-disable no-undef */
/**
 * /api/v1/auth — Railway authentication routes (PERMANENT).
 *
 *   POST /login      { email, password }            -> { access, refresh, user }
 *   POST /refresh    { refresh }                    -> { access, refresh, user }
 *   POST /logout     { refresh }                    -> { ok }
 *   GET  /me                                        -> { user }
 *
 * Base44 migration bridge removed — Railway-native auth is the sole path.
 * Google OIDC SSO is the primary login; password is a fallback.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const auth = require('../lib/authService');
const { rateLimit } = require('../lib/rateLimit');

const router = express.Router();

// ── Break-glass admin auth guard (shared by all /admin-* routes below) ──────
//
// Two independent, equally-valid ways in:
//
//   1. A valid Railway JWT for a user whose role is 'admin' — the NORMAL
//      path whenever an admin is already able to log in (Google SSO or
//      existing password). This is what makes these endpoints safe to gate
//      behind a secret that might not be configured: an already-logged-in
//      admin (e.g. Yaron Drilevich or Michelle Roitman Drilevich) never
//      depends on ADMIN_AUTH_SECRET at all for password reset/role/listing
//      operations — they just use their own session. routes/users.js
//      already covers role/status/name changes this way; these admin-*
//      endpoints add password set/clear, which routes/users.js does not
//      currently support, so this JWT path is what keeps a logged-in admin
//      able to reset ANY user's password (including their own) without
//      ADMIN_AUTH_SECRET ever being involved.
//
//   2. A DEDICATED secret (ADMIN_AUTH_SECRET, header X-Admin-Secret) — true
//      break-glass recovery for the case where NO admin can currently log
//      in at all (initial provisioning, or a full lockout with no working
//      JWT session). This never falls back to PROXY_SECRET — PROXY_SECRET
//      is shared across ~60 legacy server-to-server QB-proxy routes, and
//      accepting it here meant anyone/anything holding that broadly-
//      distributed secret could mint admin credentials for any email. If
//      ADMIN_AUTH_SECRET is not set, this second path is simply
//      unavailable (falls through to 401, not a silent weaker fallback) —
//      but path 1 above means that alone can never lock out a logged-in
//      admin. Comparison is constant-time (crypto.timingSafeEqual) to
//      avoid a timing side-channel on the secret. A per-IP rate limit is
//      applied to slow down brute-force guessing of the secret.
const adminAuthLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

function safeSecretEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminSecret(req, res, next) {
  // Path 1: an already-authenticated admin JWT. Checked first so a logged-in
  // admin never even needs ADMIN_AUTH_SECRET to be configured.
  const authHeader = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (m) {
    try {
      const payload = auth.verifyAccessToken(m[1].trim());
      if (payload && payload.role === 'admin') {
        req.user = payload;
        return next();
      }
      // Valid JWT but not an admin — fall through to try the secret path
      // rather than granting access; do NOT leak which case this was.
    } catch (e) {
      // Invalid/expired JWT — fall through to try the secret path.
    }
  }

  // Path 2: dedicated break-glass secret.
  const adminSecret = process.env.ADMIN_AUTH_SECRET;
  if (!adminSecret) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Provide a valid admin JWT (Authorization: Bearer <token>), or configure ' +
        'ADMIN_AUTH_SECRET on the server for break-glass recovery when no admin session exists.',
    });
  }
  const provided = req.headers['x-admin-secret'];
  if (!provided || !safeSecretEquals(provided, adminSecret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

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

// ── Admin: set/reset a user's password (PERMANENT admin tool) ────────────────
//   POST /admin-set-password  { email, password, role? }
//   Header: X-Admin-Secret: <ADMIN_AUTH_SECRET> (dedicated secret — PROXY_SECRET fallback removed)
//
// Allows the admin to set a password for any user (or create one if missing),
// so they can log in via email/password WITHOUT Base44 or Google OAuth.
// This is a permanent admin provisioning tool, not a migration hack.
router.post('/admin-set-password', adminAuthLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    let user = await auth.getUserByEmail(email);
    if (user) {
      await auth.setEmailPassword(user.id, password);
      if (role && ['admin', 'manager', 'sales_rep', 'office', 'user'].includes(role)) {
        await require('../db/client').query('UPDATE users SET role = $1, status = $2, updated_at = NOW() WHERE id = $3', [role, 'active', user.id]);
      } else {
        await require('../db/client').query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', ['active', user.id]);
      }
    } else {
      user = await auth.createUser({ email, full_name: email.split('@')[0], role: role || 'admin', password });
    }
    res.json({ ok: true, email: user.email, message: 'Password set. You can now log in via email + password.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: list users (read-only, admin-only) ────────────────────────────────
//   POST /admin-list-users
//   Header: X-Admin-Secret: <ADMIN_AUTH_SECRET> (dedicated secret — PROXY_SECRET fallback removed)
//
// Returns all users with id, email, full_name, role, status, google_sub presence,
// and password_hash presence. Does NOT return password hashes or tokens.
router.post('/admin-list-users', adminAuthLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { rows } = await require('../db/client').query(
      `SELECT id, email, full_name, role, status,
              (google_sub IS NOT NULL) AS has_google_sso,
              (password_hash IS NOT NULL) AS has_password,
              created_at, updated_at
       FROM users ORDER BY email`
    );
    res.json({ users: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: clear a user's password (admin-only) ──────────────────────────────
//   POST /admin-clear-password  { email }
//   Header: X-Admin-Secret: <ADMIN_AUTH_SECRET> (dedicated secret — PROXY_SECRET fallback removed)
//
// Clears the password_hash for a user, disabling email/password login.
// Google SSO (google_sub) is NOT affected. Use this to remove a temporary
// password after admin-set-password was used for role patching.
router.post('/admin-clear-password', adminAuthLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = await auth.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (!user.google_sub) {
      return res.status(409).json({
        error: 'cannot_clear_password',
        details: 'User has no google_sub — clearing password would lock them out. User must log in via Google SSO first to establish google_sub before password can be cleared.'
      });
    }

    await require('../db/client').query(
      'UPDATE users SET password_hash = NULL, updated_at = NOW() WHERE id = $1',
      [user.id]
    );
    res.json({ ok: true, email: user.email, message: 'Password cleared. Google SSO remains active.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: set a user's role WITHOUT changing their password (PERMANENT) ────
//   POST /admin-set-role  { email, role }
//   Header: X-Admin-Secret: <ADMIN_AUTH_SECRET> (dedicated secret — PROXY_SECRET fallback removed)
//
// Sets the role for an existing user without touching their password_hash
// or Google SSO (google_sub). This is the canonical tool for fixing role
// mismatches without credential side-effects.
router.post('/admin-set-role', adminAuthLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { email, role } = req.body || {};
    if (!email || !role) return res.status(400).json({ error: 'email and role required' });
    if (!['admin', 'manager', 'sales_rep', 'office', 'user'].includes(role)) {
      return res.status(400).json({ error: 'invalid role' });
    }

    const user = await auth.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'user not found' });

    await require('../db/client').query(
      'UPDATE users SET role = $1, status = $2, updated_at = NOW() WHERE id = $3',
      [role, 'active', user.id]
    );
    res.json({ ok: true, email: user.email, role, message: `Role set to ${role}. No password changed.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── [REMOVED] Base44 → Railway migration bridge ─────────────────────────────
// The /migrate endpoint has been removed. Railway auth is now the permanent
// auth layer (Google SSO + email/password via /login + /admin-set-password).
// All users must be provisioned via admin-set-password or Google SSO.
// lib/base44TokenVerify.js has been deleted (Base44 fully decommissioned).

// ── Google OAuth SSO (Railway-native, PERMANENT) ─────────────────────────────
//   GET  /google          → redirect to Google consent screen
//   GET  /google/callback → exchange code, create/find user, issue session,
//                           redirect to frontend with tokens in URL hash
//
// Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET (Railway env vars,
//      NOT Base44 secrets). The redirect URI is auto-derived:
//      ${API_BASE}/api/v1/auth/google/callback
//
// The frontend passes ?redirect=<origin> so the callback knows where to send
// the user back. This is carried through Google's `state` parameter.
router.get('/google', (req, res) => {
  // Fallback: reuse the existing Gmail OAuth client when dedicated CRM auth
  // credentials are absent. Both flows use the same Google OAuth client but
  // request DIFFERENT scopes (Gmail: gmail.send; CRM auth: openid email profile)
  // and DIFFERENT redirect URIs. No conflict — Google clients support multiple
  // scopes + redirect URIs.
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET or GMAIL_CLIENT_ID/SECRET on Railway.',
    });
  }

  // Railway terminates TLS — req.protocol is 'http' behind the proxy.
  // Use x-forwarded-proto to construct the correct HTTPS redirect URI.
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const apiBase = `${proto}://${req.get('host')}`;
  const redirectUri = `${apiBase}/api/v1/auth/google/callback`;

  // Frontend origin to return the user to after callback (carry through state).
  const frontendRedirect = req.query.redirect || process.env.CRM_PUBLIC_URL || '/';
  // Validate: must be a URL starting with http(s) or a relative path.
  const safeRedirect = /^(https?:\/\/|\/)/.test(frontendRedirect) ? frontendRedirect : '/';

  // CSRF nonce + redirect URL encoded in state
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ nonce, redirect: safeRedirect })).toString('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/google/callback', async (req, res) => {
  // Fallback: reuse the existing Gmail OAuth client (same as GET /google).
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('Google OAuth not configured on the server.');
  }

  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Google OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing authorization code.');

  // Decode state to get the frontend redirect URL
  let frontendRedirect = '/';
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
    if (decoded.redirect && /^(https?:\/\/|\/)/.test(decoded.redirect)) {
      frontendRedirect = decoded.redirect;
    }
  } catch (_) { /* use default */ }

  // Railway terminates TLS — use x-forwarded-proto for HTTPS redirect URI.
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const apiBase = `${proto}://${req.get('host')}`;
  const redirectUri = `${apiBase}/api/v1/auth/google/callback`;

  try {
    // 1. Exchange code for Google tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      return res.status(400).send(`Google token exchange failed: ${errText}`);
    }
    const tokens = await tokenResp.json();

    // 2. Get user info (sub + email + name) from Google
    const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userInfoResp.ok) {
      return res.status(400).send('Failed to fetch Google user info.');
    }
    const userInfo = await userInfoResp.json();
    const googleSub = userInfo.sub;
    const email = userInfo.email;
    if (!googleSub || !email) {
      return res.status(400).send('Google did not return email or subject.');
    }

    // 3. Find or create the Railway user via Google sub
    const user = await auth.findOrCreateByGoogleSub(googleSub, email, userInfo.name || userInfo.given_name || '');
    if (user.status !== 'active') {
      return res.status(403).send('Account disabled. Contact admin.');
    }

    // 4. Issue Railway session
    const session = await auth.issueSession(user);

    // 5. Redirect to frontend with tokens in URL hash (not query params —
    //    hash fragments are not sent to servers in subsequent requests)
    const redirectBase = frontendRedirect.startsWith('http')
      ? frontendRedirect.replace(/\/$/, '')
      : '';
    const hash = `#access=${encodeURIComponent(session.access)}&refresh=${encodeURIComponent(session.refresh)}`;
    res.redirect(`${redirectBase}/login${hash}`);
  } catch (e) {
    res.status(500).send(`Google OAuth callback error: ${e.message}`);
  }
});

// ── END Google OAuth SSO ─────────────────────────────────────────────────────

module.exports = router;
// Exposed for testing only (router is a function, so this is a safe extra
// property — does not change what `require('./routes/auth')` returns as the
// mounted Express router).
module.exports._testables = { requireAdminSecret, safeSecretEquals };