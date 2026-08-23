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
const crypto = require('crypto');
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

// ── Admin: set/reset a user's password (PERMANENT admin tool) ────────────────
//   POST /admin-set-password  { email, password, role? }
//   Header: X-Admin-Secret: <ADMIN_AUTH_SECRET or QB_PROXY_SECRET>
//
// Allows the admin to set a password for any user (or create one if missing),
// so they can log in via email/password WITHOUT Base44 or Google OAuth.
// This is a permanent admin provisioning tool, not a migration hack.
router.post('/admin-set-password', async (req, res) => {
  const adminSecret = process.env.ADMIN_AUTH_SECRET || process.env.PROXY_SECRET;
  const provided = req.headers['x-admin-secret'];
  if (!adminSecret || provided !== adminSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
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