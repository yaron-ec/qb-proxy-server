/* eslint-disable no-undef */
/**
 * signnowClient — Railway-owned SignNow API client.
 *
 * AUTHENTICATION (in priority order):
 *
 * 1. API KEY (primary, recommended):
 *    Set SIGNNOW_API_KEY in the Railway environment. This is the API key from
 *    the SignNow API dashboard → Apps and Keys → API Keys tab. It's used
 *    directly as a Bearer token for ALL API requests — no password grant, no
 *    user credentials to store. Works for any SignNow account (the key is tied
 *    to the application, not a specific user). This is SignNow's recommended
 *    method for quick authorization and testing.
 *
 * 2. PASSWORD GRANT (fallback, application owner only):
 *    Set SIGNNOW_CLIENT_ID + SIGNNOW_CLIENT_SECRET (or SIGNNOW_BASIC_AUTH_TOKEN)
 *    in the Railway environment. Then connect via Settings → SignNow using
 *    the APPLICATION OWNER's SignNow website credentials. Per SignNow docs:
 *    "This method works only for application owners: for any other user, the
 *    token request fails with an access denied error (code 11005001) even if
 *    the same credentials work for logging in to the SignNow web application."
 *    If the owner logs in via Google/Facebook/Microsoft SSO, they must reset
 *    their password first (Forgot password flow) before the password grant
 *    will work.
 *
 * Env vars:
 *   SIGNNOW_API_KEY            — API key from API Keys tab (primary auth)
 *   SIGNNOW_CLIENT_ID          — OAuth2 client ID (password grant)
 *   SIGNNOW_CLIENT_SECRET      — OAuth2 client secret (password grant)
 *   SIGNNOW_BASIC_AUTH_TOKEN   — Pre-built Basic auth token from OAuth 2.0 tab
 *                                (alternative to constructing from client_id:secret)
 *   SIGNNOW_API_BASE           — Defaults to https://api.signnow.com
 *   SIGNNOW_ENVIRONMENT        — Defaults to production
 *
 * API docs: https://docs.signnow.com/reference
 */
'use strict';

const SIGNNOW_API_BASE = process.env.SIGNNOW_API_BASE || 'https://api.signnow.com';
const SIGNNOW_ENV = process.env.SIGNNOW_ENVIRONMENT || 'production';
const SIGNNOW_API_KEY = process.env.SIGNNOW_API_KEY;

let _token = null;
let _tokenExp = 0;

// Load user credentials from the encrypted credential store (database) first,
// then fall back to environment variables. This allows admins to connect via
// the Settings UI without requiring a Railway redeploy to set env vars.
// Only used for the password grant fallback — not needed when API Key is set.
async function loadUserCredentials() {
  try {
    const credentialStore = require('./integrationCredentialStore');
    const cred = await credentialStore.loadActiveCredential({
      provider: 'signnow',
      credentialType: 'password',
      environment: SIGNNOW_ENV,
    });
    if (cred && cred.payload && cred.payload.username && cred.payload.password) {
      return { username: cred.payload.username, password: cred.payload.password, source: 'database' };
    }
  } catch (e) {
    console.warn('[signnow] Failed to load credentials from store:', e.message);
  }
  const username = process.env.SIGNNOW_USERNAME;
  const password = process.env.SIGNNOW_PASSWORD;
  if (username && password) {
    return { username, password, source: 'env' };
  }
  return null;
}

// Clear the in-memory token cache — called after connect/disconnect so the
// next API call uses the new (or cleared) credentials.
function clearTokenCache() {
  _token = null;
  _tokenExp = 0;
}

// Build a meaningful error from SignNow's OAuth2 token response.
// SignNow returns JSON error bodies like:
//   {"error":"11005001","error_description":"Access denied"}
//   {"errors":[{"code":"11005001","message":"Access denied"}]}
// Key error codes:
//   11005001 — Access denied: the user is NOT the API application owner.
//              Password grant only works for the account that generated the
//              CLIENT_ID/CLIENT_SECRET. Website login credentials for any other
//              account will fail with this code even if they work on signnow.com.
// This function NEVER includes the password, token, or client secret in the
// returned error — only the sanitized SignNow error code and description.
function buildSignNowAuthError(httpStatus, responseText) {
  let errorCode = null;
  let errorDesc = null;

  try {
    const body = JSON.parse(responseText);
    // Format 1: {"error":"11005001","error_description":"Access denied"}
    if (body.error) {
      errorCode = String(body.error);
      errorDesc = body.error_description || body.error;
    }
    // Format 2: {"errors":[{"code":"11005001","message":"Access denied"}]}
    if (!errorCode && body.errors && body.errors[0]) {
      errorCode = String(body.errors[0].code || body.errors[0].error || '');
      errorDesc = body.errors[0].message || body.errors[0].description || '';
    }
  } catch { /* not JSON — use raw text */ }
  if (!errorCode && !errorDesc) {
    errorDesc = responseText.substring(0, 200);
  }

  // 11005001 = "Access denied" — the user is not the API application owner.
  if (errorCode === '11005001') {
    const err = new Error(
      'SignNow access denied (error 11005001): This SignNow account is not the API application owner. ' +
      'The password grant only works for the SignNow account that generated the API key (CLIENT_ID/CLIENT_SECRET). ' +
      'Website login credentials for any other SignNow account will be rejected. ' +
      'Fix: Set SIGNNOW_API_KEY in the Railway environment (API dashboard → API Keys tab) — this authenticates ' +
      'without the password grant and works for any account. ' +
      'Or use the application owner\'s SignNow credentials, or regenerate the API key from this SignNow account.'
    );
    err.code = 'SIGNNOW_NOT_APP_OWNER';
    err.status = 403;
    err.signnowErrorCode = errorCode;
    return err;
  }

  // Generic auth failure — include the SignNow error code for diagnostics
  const err = new Error(
    `SignNow authentication failed (HTTP ${httpStatus}${errorCode ? ', error ' + errorCode : ''})${errorDesc ? ': ' + errorDesc : ''}`
  );
  err.code = 'SIGNNOW_AUTH_FAILED';
  err.status = 401;
  err.signnowErrorCode = errorCode;
  return err;
}

// ── Authentication: get an access token ───────────────────────────────────────
//
// Priority 1: API Key — if SIGNNOW_API_KEY is set, use it directly as the
//             Bearer token. No password grant, no user credentials needed.
//             This is SignNow's recommended method and works for any account.
//
// Priority 2: Password grant — if API Key is not set, use the OAuth2 password
//             grant with stored user credentials (database or env). Only works
//             for the application owner.
async function getAccessToken() {
  // Priority 1: API Key
  if (SIGNNOW_API_KEY) {
    return SIGNNOW_API_KEY;
  }

  // Priority 2: Password grant
  const now = Date.now();
  if (_token && _tokenExp > now + 5000) return _token;

  const clientId = process.env.SIGNNOW_CLIENT_ID;
  const clientSecret = process.env.SIGNNOW_CLIENT_SECRET;
  const basicAuthToken = process.env.SIGNNOW_BASIC_AUTH_TOKEN;

  if (!basicAuthToken && (!clientId || !clientSecret)) {
    const err = new Error(
      'SignNow not configured. Set SIGNNOW_API_KEY (recommended — API dashboard → API Keys tab) ' +
      'or SIGNNOW_CLIENT_ID + SIGNNOW_CLIENT_SECRET (password grant, application owner only).'
    );
    err.code = 'SIGNNOW_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }

  const userCreds = await loadUserCredentials();
  if (!userCreds) {
    const err = new Error(
      'SignNow credentials not configured. Set SIGNNOW_API_KEY (recommended) or ' +
      'connect via Settings → SignNow using the application owner\'s website credentials.'
    );
    err.code = 'SIGNNOW_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }

  // Use the pre-built Basic Authorization Token if provided (from OAuth 2.0 tab),
  // otherwise construct from client_id:client_secret.
  const creds = basicAuthToken || Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${SIGNNOW_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: userCreds.username,
      password: userCreds.password,
      scope: '*',
    }).toString(),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw buildSignNowAuthError(res.status, t);
  }

  const data = await res.json();
  _token = data.access_token;
  _tokenExp = now + (data.expires_in || 3600) * 1000;
  return _token;
}

// Verify credentials by attempting a token exchange — does NOT store the token.
// Used by the /connect route to validate before persisting.
// If API Key is set, this is a no-op (API Key doesn't need verification — it's
// verified on first API call). If password grant, verifies the credentials.
async function verifyCredentials(username, password) {
  // API Key mode — no verification needed (the key is in the environment)
  if (SIGNNOW_API_KEY) {
    return SIGNNOW_API_KEY;
  }

  const clientId = process.env.SIGNNOW_CLIENT_ID;
  const clientSecret = process.env.SIGNNOW_CLIENT_SECRET;
  const basicAuthToken = process.env.SIGNNOW_BASIC_AUTH_TOKEN;

  if (!basicAuthToken && (!clientId || !clientSecret)) {
    const err = new Error(
      'SignNow not configured. Set SIGNNOW_API_KEY (recommended) or ' +
      'SIGNNOW_CLIENT_ID + SIGNNOW_CLIENT_SECRET.'
    );
    err.code = 'SIGNNOW_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }

  const creds = basicAuthToken || Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${SIGNNOW_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username,
      password,
      scope: '*',
    }).toString(),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw buildSignNowAuthError(res.status, t);
  }

  const data = await res.json();
  return data.access_token;
}

// Check which authentication method is available
function getAuthMethod() {
  if (SIGNNOW_API_KEY) return 'api_key';
  if (process.env.SIGNNOW_BASIC_AUTH_TOKEN || (process.env.SIGNNOW_CLIENT_ID && process.env.SIGNNOW_CLIENT_SECRET)) {
    return 'password_grant';
  }
  return 'none';
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Verify that the API Key works by calling a simple SignNow endpoint.
 * Used by the /status and /connect routes when API Key is set.
 */
async function verifyApiKey() {
  if (!SIGNNOW_API_KEY) {
    const err = new Error('SIGNNOW_API_KEY not configured');
    err.code = 'SIGNNOW_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }

  // Call the /user endpoint to verify the API Key is valid
  const res = await fetch(`${SIGNNOW_API_BASE}/user`, {
    headers: authHeaders(SIGNNOW_API_KEY),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`SignNow API key verification failed (HTTP ${res.status}): ${t.substring(0, 200)}`);
    err.code = 'SIGNNOW_AUTH_FAILED';
    err.status = res.status === 401 || res.status === 403 ? 401 : 500;
    err.signnowErrorCode = null;
    throw err;
  }

  const data = await res.json();
  return data;
}

/**
 * List available document templates.
 */
async function listTemplates() {
  const token = await getAccessToken();
  const res = await fetch(`${SIGNNOW_API_BASE}/document/templates`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow list templates failed ${res.status}: ${t.substring(0, 200)}`);
  }
  const data = await res.json();
  return data.templates || [];
}

/**
 * Upload a PDF document for signing.
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {string} fileName - Document name
 */
async function uploadDocument(pdfBuffer, fileName) {
  const token = await getAccessToken();
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', pdfBuffer, { filename: fileName, contentType: 'application/pdf' });

  const res = await fetch(`${SIGNNOW_API_BASE}/document`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow upload failed ${res.status}: ${t.substring(0, 200)}`);
  }
  const data = await res.json();
  return data; // { id, name, ... }
}

/**
 * Create a signing link for a document.
 * @param {string} docId - SignNow document ID
 * @param {Array} signers - [{ email, name, role }]
 */
async function createSigningLink(docId, signers) {
  const token = await getAccessToken();
  const body = {
    document_id: docId,
    recipients: signers.map(s => ({
      email: s.email,
      name: s.name,
      role: s.role || 'Signer 1',
      order: 1,
    })),
  };

  const res = await fetch(`${SIGNNOW_API_BASE}/link`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow create link failed ${res.status}: ${t.substring(0, 200)}`);
  }
  const data = await res.json();
  return data; // { link, ... }
}

/**
 * Get document signing status.
 * @param {string} docId - SignNow document ID
 */
async function getDocumentStatus(docId) {
  const token = await getAccessToken();
  const res = await fetch(`${SIGNNOW_API_BASE}/document/${docId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow get document failed ${res.status}: ${t.substring(0, 200)}`);
  }
  const data = await res.json();
  return data; // { id, name, status, signers, ... }
}

/**
 * Download the signed PDF.
 * @param {string} docId - SignNow document ID
 */
async function downloadSignedPdf(docId) {
  const token = await getAccessToken();
  const res = await fetch(`${SIGNNOW_API_BASE}/document/${docId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow download failed ${res.status}: ${t.substring(0, 200)}`);
  }
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

module.exports = {
  getAccessToken,
  verifyCredentials,
  verifyApiKey,
  getAuthMethod,
  clearTokenCache,
  loadUserCredentials,
  listTemplates,
  uploadDocument,
  createSigningLink,
  getDocumentStatus,
  downloadSignedPdf,
};