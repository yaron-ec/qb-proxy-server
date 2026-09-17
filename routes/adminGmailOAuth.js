/* eslint-disable no-undef */
/**
 * /api/v1/admin/gmail-oauth — ADMIN-AUTHENTICATED bridge into the internal
 * Gmail OAuth flow (lib/gmailOAuthRouter.js), so a CRM admin can reconnect
 * Gmail from Settings using their normal Railway session — no PROXY_SECRET,
 * no Railway dashboard, no environment variables, no copy/pasted tokens.
 *
 *   GET /status     -> { connected, has_send_access, has_read_access, ... }
 *                       (reuses gmailOAuthRouter's own handleStatus — same
 *                       response shape, never exposes token material)
 *   GET /start-url  -> { path }  — a same-origin, server-relative path
 *                       (/internal/gmail/oauth/start?setup_token=...) for
 *                       the BROWSER to navigate to (not fetch). The setup
 *                       token is short-lived (10 min) and single-purpose —
 *                       it can only start the OAuth flow, nothing else —
 *                       minted server-side via the PROXY_SECRET the browser
 *                       never sees. Navigating there lets /internal/gmail/
 *                       oauth/start's own requireInternalAuth accept it,
 *                       then redirect the browser on to Google's real
 *                       consent screen with the current SCOPES.
 *
 * Auth: Railway JWT (requireAuth) + admin role only — this mints a
 * privileged, if short-lived and narrow, credential.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const gmailOAuth = require('../lib/gmailOAuthRouter');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/status', gmailOAuth.handleStatus);

router.get('/start-url', (req, res) => {
  try {
    const setupToken = gmailOAuth.signSetupToken();
    res.json({ path: `/internal/gmail/oauth/start?setup_token=${encodeURIComponent(setupToken)}` });
  } catch (e) {
    res.status(503).json({ error: 'Gmail OAuth is not configured on the server.' });
  }
});

module.exports = router;
