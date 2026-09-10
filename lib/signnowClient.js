/* eslint-disable no-undef */
/**
 * signnowClient — Railway-owned SignNow API client.
 *
 * Calls the SignNow API directly using SIGNNOW_CLIENT_ID/SECRET + username/password
 * (OAuth2 password grant). No Base44, no browser tokens.
 *
 * Env: SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_USERNAME, SIGNNOW_PASSWORD
 *
 * API docs: https://docs.signnow.com/reference
 *
 * Operations:
 *   getAccessToken()           — OAuth2 password grant
 *   listTemplates(token)       — list document templates
 *   uploadDocument(token, file) — upload a PDF for signing
 *   createSigningLink(token, docId, signers) — create a signing request
 *   getDocumentStatus(token, docId) — check signing status
 *   downloadSignedPdf(token, docId) — download the signed PDF
 */
'use strict';

const SIGNNOW_API_BASE = process.env.SIGNNOW_API_BASE || 'https://api.signnow.com';
const SIGNNOW_ENV = process.env.SIGNNOW_ENVIRONMENT || 'production';

let _token = null;
let _tokenExp = 0;

// Load user credentials from the encrypted credential store (database) first,
// then fall back to environment variables. This allows admins to connect via
// the Settings UI without requiring a Railway redeploy to set env vars.
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
  // This is the most common error when website credentials work but the API
  // password grant fails. SignNow's password grant is restricted to the
  // account that created the API application (generated CLIENT_ID/SECRET).
  if (errorCode === '11005001') {
    const err = new Error(
      'SignNow access denied (error 11005001): This SignNow account is not the API application owner. ' +
      'The password grant only works for the SignNow account that generated the API key (CLIENT_ID/CLIENT_SECRET). ' +
      'Website login credentials for any other SignNow account will be rejected. ' +
      'Use the application owner\'s SignNow credentials, or regenerate the API key from this SignNow account.'
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

async function getAccessToken() {
  const now = Date.now();
  if (_token && _tokenExp > now + 5000) return _token;

  const clientId = process.env.SIGNNOW_CLIENT_ID;
  const clientSecret = process.env.SIGNNOW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('SIGNNOW_CLIENT_ID and SIGNNOW_CLIENT_SECRET not configured');
    err.code = 'SIGNNOW_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }

  const userCreds = await loadUserCredentials();
  if (!userCreds) {
    const err = new Error('SignNow credentials not configured. Connect via Settings → SignNow, or set SIGNNOW_USERNAME/SIGNNOW_PASSWORD env vars.');
    err.code = 'SIGNNOW_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
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
async function verifyCredentials(username, password) {
  const clientId = process.env.SIGNNOW_CLIENT_ID;
  const clientSecret = process.env.SIGNNOW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('SIGNNOW_CLIENT_ID and SIGNNOW_CLIENT_SECRET not configured');
    err.code = 'SIGNNOW_NOT_CONFIGURED';
    err.status = 501;
    throw err;
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
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

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
  clearTokenCache,
  loadUserCredentials,
  listTemplates,
  uploadDocument,
  createSigningLink,
  getDocumentStatus,
  downloadSignedPdf,
};