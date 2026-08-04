/* eslint-disable no-undef */
/**
 * gmailOAuthRouter — one-time Gmail OAuth authorization flow for Railway.
 *
 * Routes (mounted at /internal/gmail/oauth in server.js):
 *   GET /start     — begins the OAuth flow (requires X-Proxy-Secret or setup_token)
 *   GET /callback   — Google redirects here with code+state (state is the auth)
 *   GET /status     — safe connection check (requires X-Proxy-Secret or setup_token)
 *
 * Security:
 *   - State is 32 random bytes, stored as SHA-256 hash (raw state only in the
 *     browser redirect URL + Google's state echo — never logged).
 *   - State expires in 10 minutes, single-use (atomic UPDATE ... RETURNING).
 *   - Setup tokens are short-lived JWTs signed with PROXY_SECRET (10 min).
 *   - Callback verifies the authorized account is exactly
 *     yaron@ecconstructiongroup.com with email_verified=true.
 *   - A refresh_token is required (prompt=consent ensures one is returned).
 *   - No tokens, secrets, or authorization codes are ever logged or returned
 *     to the browser. Google API errors are sanitized before display.
 *   - No Gmail message is sent during this flow.
 *
 * Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_OAUTH_REDIRECT_URI,
 *      PROXY_SECRET, DATABASE_URL (via db/client), ENCRYPTION_KEY (via credential store)
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { sha256Hex, constantTimeEqual } = require('./crypto');

const EXPECTED_EMAIL = 'yaron@ecconstructiongroup.com';
const ENVIRONMENT = process.env.QB_ENVIRONMENT || process.env.NODE_ENV || 'production';
const STATE_TTL_MINUTES = 10;
const SETUP_TOKEN_TTL_SECONDS = 600;

const SCOPES = 'https://www.googleapis.com/auth/gmail.send openid email';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeGoogleError(data) {
  if (!data || typeof data !== 'object') return 'Google API error';
  const err = String(data.error || '');
  const desc = String(data.error_description || '');
  if (err === 'invalid_grant') return 'Authorization code expired or already used. Please restart the authorization flow.';
  if (err === 'invalid_client') return 'Google OAuth client configuration error.';
  if (err === 'redirect_uri_mismatch') return 'Redirect URI mismatch. Check the Google Cloud Console configuration.';
  // Keep it short and safe — no tokens, no body content, no stack traces.
  const safe = desc ? `${err}: ${desc}` : err;
  return `Google OAuth error: ${safe || 'unknown'}`.slice(0, 300);
}

function createGmailOAuthRouter(deps) {
  deps = deps || {};
  const db = deps.db || require('../db/client');
  const credStore = deps.credStore || require('./gmailCredentialStore');
  const fetchFn = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI;
  const proxySecret = process.env.PROXY_SECRET;

  // ── Setup token (short-lived JWT signed with PROXY_SECRET) ──────────────────
  function signSetupToken() {
    if (!proxySecret) throw new Error('PROXY_SECRET not configured');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + SETUP_TOKEN_TTL_SECONDS, purpose: 'gmail_oauth_setup' })).toString('base64url');
    const sig = crypto.createHmac('sha256', proxySecret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  function verifySetupToken(token) {
    if (!proxySecret || !token) return false;
    const parts = String(token).split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = parts;
    const expected = crypto.createHmac('sha256', proxySecret).update(`${h}.${p}`).digest('base64url');
    if (!constantTimeEqual(s, expected)) return false;
    try {
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      if (payload.purpose !== 'gmail_oauth_setup') return false;
      if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return false;
      return true;
    } catch { return false; }
  }

  // ── Authorization middleware ────────────────────────────────────────────────
  function requireInternalAuth(req, res, next) {
    const headerSecret = req.headers['x-proxy-secret'];
    const setupToken = req.query.setup_token;
    if (headerSecret && proxySecret && constantTimeEqual(String(headerSecret), String(proxySecret))) {
      req._authMethod = 'proxy_secret';
      return next();
    }
    if (setupToken && verifySetupToken(setupToken)) {
      req._authMethod = 'setup_token';
      return next();
    }
    return res.status(401).type('text').send('Unauthorized');
  }

  // ── State management ────────────────────────────────────────────────────────
  async function createStateRecord(rawState) {
    const stateHash = sha256Hex(rawState);
    const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO gmail_oauth_states (state_hash, expected_email, expires_at) VALUES ($1, $2, $3)`,
      [stateHash, EXPECTED_EMAIL, expiresAt]
    );
  }

  // Atomically claim: only succeeds if state exists, is unused, and is not expired.
  // Returns { valid: true, expectedEmail } on success, { valid: false, reason } on failure.
  async function validateAndClaimState(rawState) {
    const stateHash = sha256Hex(rawState);
    const { rows } = await db.query(
      `UPDATE gmail_oauth_states
       SET used_at = NOW()
       WHERE state_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       RETURNING id, expected_email`,
      [stateHash]
    );
    if (rows.length) return { valid: true, expectedEmail: rows[0].expected_email };
    // Determine the reason for the failure (for a safe error message).
    const existing = await db.query(
      `SELECT used_at, expires_at FROM gmail_oauth_states WHERE state_hash = $1`,
      [stateHash]
    );
    if (!existing.rows.length) return { valid: false, reason: 'invalid_state' };
    const row = existing.rows[0];
    if (row.used_at) return { valid: false, reason: 'state_already_used' };
    if (new Date(row.expires_at) <= new Date()) return { valid: false, reason: 'state_expired' };
    return { valid: false, reason: 'invalid_state' };
  }

  // ── Token exchange ──────────────────────────────────────────────────────────
  async function exchangeCode(code) {
    if (!fetchFn) return { ok: false, status: 0, error: 'fetch not available' };
    const res = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: sanitizeGoogleError(data) };
    return { ok: true, data };
  }

  // ── Account verification ────────────────────────────────────────────────────
  function decodeIdToken(idToken) {
    try {
      const parts = String(idToken).split('.');
      if (parts.length < 2) return null;
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { return null; }
  }

  async function verifyAccount(data) {
    let email = null;
    let emailVerified = false;
    if (data.id_token) {
      const claims = decodeIdToken(data.id_token);
      if (claims) {
        email = claims.email || null;
        emailVerified = claims.email_verified === true || claims.email_verified === 'true';
      }
    }
    if (!email && data.access_token && fetchFn) {
      try {
        const res = await fetchFn(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });
        if (res.ok) {
          const info = await res.json();
          email = info.email || null;
          emailVerified = info.email_verified === true || info.email_verified === 'true';
        }
      } catch { /* ignore — will fail verification below */ }
    }
    return { email, emailVerified };
  }

  // ── HTML response pages ─────────────────────────────────────────────────────
  function setSafeHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  }

  function sendSuccessPage(res) {
    setSafeHeaders(res);
    res.status(200).type('html').send(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Gmail Connected</title></head>` +
      `<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#EEF1F7;padding:48px 16px;margin:0;">` +
      `<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;text-align:center;">` +
      `<h1 style="color:#16a34a;margin:0 0 16px;font-size:24px;">✓ Gmail Connected</h1>` +
      `<p style="font-size:16px;color:#1A1A2E;line-height:1.6;">Gmail connected successfully to Railway.</p>` +
      `<p style="font-size:14px;color:#6B7280;margin-top:12px;">Authorized account:<br><strong>${escapeHtml(EXPECTED_EMAIL)}</strong></p>` +
      `<p style="font-size:13px;color:#6B7280;margin-top:20px;">No email was sent.</p>` +
      `<p style="font-size:13px;color:#6B7280;margin-top:8px;">You may close this window.</p>` +
      `</div></body></html>`
    );
  }

  function sendErrorPage(res, message) {
    setSafeHeaders(res);
    res.status(400).type('html').send(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Gmail Connection Error</title></head>` +
      `<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#EEF1F7;padding:48px 16px;margin:0;">` +
      `<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;text-align:center;">` +
      `<h1 style="color:#dc2626;margin:0 0 16px;font-size:24px;">✕ Connection Error</h1>` +
      `<p style="font-size:14px;color:#1A1A2E;line-height:1.6;">${escapeHtml(message || 'Unknown error')}</p>` +
      `<p style="font-size:13px;color:#6B7280;margin-top:20px;">No credential was stored. No email was sent.</p>` +
      `</div></body></html>`
    );
  }

  // ── Route handlers ──────────────────────────────────────────────────────────
  async function handleStart(req, res) {
    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(503).type('text').send('Gmail OAuth not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_OAUTH_REDIRECT_URI required)');
    }
    // Issue a setup token (only via X-Proxy-Secret, not via another setup_token).
    if (req.query.issue_setup_token === 'true') {
      if (req._authMethod === 'setup_token') {
        return res.status(403).type('text').send('Cannot issue a setup token using a setup token');
      }
      return res.status(200).json({ setup_token: signSetupToken() });
    }
    const rawState = crypto.randomBytes(32).toString('hex');
    await createStateRecord(rawState);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      login_hint: EXPECTED_EMAIL,
      state: rawState,
    });
    return res.redirect(302, `${GOOGLE_AUTH_URL}?${params.toString()}`);
  }

  async function handleCallback(req, res) {
    try {
      const { code, state, error } = req.query;
      if (error) {
        return sendErrorPage(res, `Authorization denied: ${sanitizeGoogleError({ error: String(error) })}`);
      }
      if (!code || !state) {
        return sendErrorPage(res, 'Missing authorization code or state.');
      }
      const stateResult = await validateAndClaimState(state);
      if (!stateResult.valid) {
        return sendErrorPage(res, `Invalid or expired authorization state. Please restart the authorization flow.`);
      }
      if (!clientId || !clientSecret || !redirectUri) {
        return sendErrorPage(res, 'Gmail OAuth not configured on the server.');
      }
      const tokenResult = await exchangeCode(code);
      if (!tokenResult.ok) {
        return sendErrorPage(res, `Token exchange failed: ${tokenResult.error}`);
      }
      if (!tokenResult.data.refresh_token) {
        return sendErrorPage(res, 'No refresh token returned. Please repeat the authorization with consent (prompt=consent ensures a new refresh token).');
      }
      const { email, emailVerified } = await verifyAccount(tokenResult.data);
      if (!email) {
        return sendErrorPage(res, 'Could not verify the authorized Google account.');
      }
      if (!emailVerified) {
        return sendErrorPage(res, `Authorized email is not verified by Google. Please verify the email in Google before connecting.`);
      }
      if (String(email).toLowerCase() !== EXPECTED_EMAIL) {
        return sendErrorPage(res, `Authorized account does not match the required account (${EXPECTED_EMAIL}). Please authorize with ${EXPECTED_EMAIL}.`);
      }
      await credStore.saveGmailCredential(ENVIRONMENT, {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokenResult.data.refresh_token,
        access_token: tokenResult.data.access_token || null,
        access_token_expires_at: tokenResult.data.expires_in
          ? new Date(Date.now() + tokenResult.data.expires_in * 1000).toISOString()
          : null,
        account_identifier: EXPECTED_EMAIL,
        display_name: `Gmail ${EXPECTED_EMAIL}`,
        connected_at: new Date().toISOString(),
      });
      return sendSuccessPage(res);
    } catch (e) {
      // Never expose internal error details, tokens, or stack traces to the browser.
      console.error('[gmailOAuth] callback error:', e.message);
      return sendErrorPage(res, 'An unexpected error occurred during the Gmail connection. No credential was stored.');
    }
  }

  async function handleStatus(req, res) {
    try {
      const cred = await credStore.loadGmailCredential(ENVIRONMENT);
      if (cred && cred.refresh_token) {
        return res.status(200).json({
          connected: true,
          account: EXPECTED_EMAIL,
          environment: ENVIRONMENT,
          status: 'connected',
        });
      }
    } catch (e) {
      // Store error — treat as not connected. Never expose error details.
    }
    return res.status(200).json({ connected: false });
  }

  // ── Express router ──────────────────────────────────────────────────────────
  const router = express.Router();
  router.get('/start', requireInternalAuth, handleStart);
  router.get('/callback', handleCallback);
  router.get('/status', requireInternalAuth, handleStatus);

  return {
    router,
    handleStart,
    handleCallback,
    handleStatus,
    signSetupToken,
    verifySetupToken,
    createStateRecord,
    validateAndClaimState,
    exchangeCode,
    verifyAccount,
    ENVIRONMENT,
    EXPECTED_EMAIL,
  };
}

// Default export for server.js mounting.
const defaultInstance = createGmailOAuthRouter();
module.exports = defaultInstance.router;
// Factory export for tests.
module.exports.createGmailOAuthRouter = createGmailOAuthRouter;