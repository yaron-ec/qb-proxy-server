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

const SIGNNOW_ENV = process.env.SIGNNOW_ENVIRONMENT || 'production';

// SignNow has TWO separate API environments:
//   - Production:  https://api.signnow.com       (for Production application API Keys)
//   - Sandbox/Eval: https://api-eval.signnow.com  (for Development application API Keys)
//
// An API Key generated from a Development application is ONLY valid against
// api-eval.signnow.com. Sending it to api.signnow.com returns HTTP 400 with
// error code 1537 ("invalid_token") — the token is syntactically valid but
// belongs to the wrong environment.
//
// Resolution order:
//   1. SIGNNOW_API_BASE env var (explicit override — highest priority)
//   2. Derived from SIGNNOW_ENVIRONMENT:
//      sandbox/development/eval → https://api-eval.signnow.com
//      production (default)      → https://api.signnow.com
const SIGNNOW_API_BASE = process.env.SIGNNOW_API_BASE || (
  ['sandbox', 'development', 'eval'].includes(SIGNNOW_ENV)
    ? 'https://api-eval.signnow.com'
    : 'https://api.signnow.com'
);
const SIGNNOW_API_KEY = process.env.SIGNNOW_API_KEY;

// The two possible SignNow API base URLs
const SIGNNOW_API_BASES = ['https://api.signnow.com', 'https://api-eval.signnow.com'];

let _token = null;
let _tokenExp = 0;

// Runtime-detected API base URL for API Key mode. When the API Key is set but
// SIGNNOW_ENVIRONMENT doesn't match the key's actual environment, we probe
// both base URLs and cache the one that accepts the key. This avoids requiring
// the user to set SIGNNOW_ENVIRONMENT manually — the code auto-detects.
let _detectedApiBase = null;
let _detectionInProgress = null;

// Returns the effective API base URL. In API Key mode, if the env-derived base
// hasn't been confirmed yet, this may trigger a probe. The probe calls /user
// on each base URL with the API Key and returns the one that returns 200.
async function getEffectiveApiBase() {
  // If an explicit override is set, always use it (no probing)
  if (process.env.SIGNNOW_API_BASE) return SIGNNOW_API_BASE;
  // If not in API Key mode, use the env-derived base
  if (!SIGNNOW_API_KEY) return SIGNNOW_API_BASE;
  // If we already detected the correct base, use it
  if (_detectedApiBase) return _detectedApiBase;
  // If a detection is already in progress, wait for it
  if (_detectionInProgress) return _detectionInProgress;

  _detectionInProgress = (async () => {
    // Try the env-derived base first (most likely correct if SIGNNOW_ENVIRONMENT is set)
    const candidates = [SIGNNOW_API_BASE, ...SIGNNOW_API_BASES.filter(b => b !== SIGNNOW_API_BASE)];

    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/user`, {
          headers: authHeaders(SIGNNOW_API_KEY),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          _detectedApiBase = base;
          console.log(`[signnow] API Key validated against ${base}`);
          return base;
        }
        // 400 with error 1537 = wrong environment; try the next base
        const body = await res.text().catch(() => '');
        const code = (() => { try { return JSON.parse(body).error; } catch { return null; } })();
        console.log(`[signnow] API Key rejected by ${base} (HTTP ${res.status}, code ${code})`);
      } catch (e) {
        console.log(`[signnow] Probe failed for ${base}: ${e.message}`);
      }
    }

    // If neither base accepted the key, fall back to the env-derived base
    // (the error will surface in verifyApiKey with a clear message)
    _detectedApiBase = SIGNNOW_API_BASE;
    return _detectedApiBase;
  })();

  try {
    return await _detectionInProgress;
  } finally {
    _detectionInProgress = null;
  }
}

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
  const apiBase = await getEffectiveApiBase();
  const res = await fetch(`${apiBase}/oauth2/token`, {
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
  const apiBase = await getEffectiveApiBase();
  const res = await fetch(`${apiBase}/oauth2/token`, {
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

/**
 * checkConnection — the ONE canonical SignNow connection/credential check.
 * Extracted from routes/signnow.js's GET /status (CRM STABILITY PHASE,
 * System Health audit) so System Health can reuse the exact same logic
 * instead of a second, divergent implementation — pure extraction, no
 * behavior change. Returns the connected/auth_method/environment shape
 * /status has always returned.
 */
async function checkConnection() {
  const authMethod = getAuthMethod();

  if (authMethod === 'api_key') {
    try {
      const userData = await verifyApiKey();
      const effectiveBase = await getEffectiveApiBase().catch(() => null);
      const environment = effectiveBase === 'https://api-eval.signnow.com' ? 'sandbox' : 'production';
      return {
        connected: true,
        auth_method: 'api_key',
        name: userData.full_name || userData.first_name || 'API Key',
        email: userData.email || null,
        environment,
      };
    } catch (e) {
      return {
        connected: false,
        auth_method: 'api_key',
        error: e.code === 'SIGNNOW_AUTH_FAILED' ? 'auth_failed' : 'error',
        message: e.message,
        signnow_error_code: e.signnowErrorCode || null,
      };
    }
  }

  const credentialStore = require('./integrationCredentialStore');
  const SIGNNOW_ENV = process.env.SIGNNOW_ENVIRONMENT || 'production';

  let dbCred = null;
  try {
    dbCred = await credentialStore.loadActiveCredential({
      provider: 'signnow',
      credentialType: 'password',
      environment: SIGNNOW_ENV,
    });
  } catch (e) { /* store may not be configured */ }

  const hasDbCreds = !!(dbCred && dbCred.payload && dbCred.payload.username);
  const hasEnvCreds = !!(process.env.SIGNNOW_USERNAME && process.env.SIGNNOW_PASSWORD);

  if (!hasDbCreds && !hasEnvCreds) {
    return { connected: false, auth_method: 'password_grant' };
  }

  try {
    await getAccessToken();
    const username = hasDbCreds ? dbCred.payload.username : process.env.SIGNNOW_USERNAME;
    return {
      connected: true,
      auth_method: 'password_grant',
      name: username,
      email: username.includes('@') ? username : null,
      username,
    };
  } catch (e) {
    if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
      return { connected: false, auth_method: 'password_grant' };
    }
    return {
      connected: false,
      auth_method: 'password_grant',
      error: e.code === 'SIGNNOW_NOT_APP_OWNER' ? 'not_app_owner' : 'auth_failed',
      message: e.message,
      signnow_error_code: e.signnowErrorCode || null,
    };
  }
}

function authHeaders(token) {
  // SignNow API requires both Accept and Content-Type headers for API key
  // authentication (per https://docs.signnow.com/docs/authentication).
  // Missing either header causes HTTP 400 invalid_request.
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
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

  // getEffectiveApiBase() probes both SignNow environments (Production and
  // Sandbox) with the API Key and returns the one that accepts it. This
  // auto-detects whether the key is from a Development or Production app
  // without requiring SIGNNOW_ENVIRONMENT to be set manually.
  const apiBase = await getEffectiveApiBase();

  const res = await fetch(`${apiBase}/user`, {
    headers: authHeaders(SIGNNOW_API_KEY),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(t); } catch { /* not JSON */ }
    const snCode = parsed?.error || parsed?.errors?.[0]?.code || null;
    const snDesc = parsed?.error_description || parsed?.errors?.[0]?.message || '';

    const err = new Error(
      `SignNow API key verification failed (HTTP ${res.status}) from ${apiBase}` +
      (snCode ? `, SignNow error ${snCode}` : '') + (snDesc ? `: ${snDesc}` : `: ${t.substring(0, 200)}`)
    );
    err.code = 'SIGNNOW_AUTH_FAILED';
    err.status = res.status === 401 || res.status === 403 ? 401 : 500;
    err.signnowErrorCode = snCode;
    err.apiBase = apiBase;
    throw err;
  }

  const data = await res.json();
  return data;
}

/**
 * Get current user info (account email, name) — used for the 'from' field
 * in signing invites and for displaying the connected account email.
 */
async function getUserInfo() {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const res = await fetch(`${apiBase}/user`, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow get user info failed ${res.status}: ${t.substring(0, 200)}`);
  }
  return await res.json();
}

/**
 * List available document templates.
 *
 * SIGNNOW TEMPLATE DISCOVERY — CORRECTED APPROACH
 *
 * The previous implementation called GET /user/documents and filtered for
 * template === true. This returned 0 templates because /user/documents
 * only returns REGULAR DOCUMENTS, not templates. Templates are stored in
 * a separate "Templates" system folder and are NOT included in the
 * /user/documents response.
 *
 * The correct approach (confirmed via SignNow API docs + live API probing):
 *
 * 1. GET /folder — returns all folders with template_count per folder.
 *    The "Templates" system folder (and any "Team Templates" shared
 *    folders) contain template_count > 0.
 *
 * 2. GET /folder/{folder_id} — returns the folder's `documents` array,
 *    which for the Templates folder contains the actual template objects
 *    (with template=true, id, document_name, roles, fields, etc.).
 *
 * 3. Paginate with limit=100&offset=N if the folder has more than 100
 *    templates.
 *
 * This was verified against the live SignNow account:
 *   - GET /user/documents returned 3 regular documents (all template=false)
 *   - GET /folder showed Templates folder with template_count=5
 *   - GET /folder/{templates_folder_id} returns the 5 actual templates
 *
 * Response: array of { id, name, page_count, roles, created, folder_name, shared, team_name }
 */
async function listTemplates() {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const headers = authHeaders(token);

  // Step 1: Get all folders to find template folders (Templates + Team Templates)
  const folderRes = await fetch(`${apiBase}/folder`, { headers, signal: AbortSignal.timeout(15000) });
  if (!folderRes.ok) {
    const t = await folderRes.text().catch(() => '');
    throw new Error(`SignNow list folders failed ${folderRes.status}: ${t.substring(0, 200)}`);
  }
  const folderData = await folderRes.json();
  const allFolders = folderData.folders || [];

  // Step 2: Find all folders that contain templates
  // - "Templates" (system folder, personal templates)
  // - "Team Templates" (shared folders, team templates)
  // - Any custom folder with template_count > 0
  const templateFolders = allFolders.filter(f => parseInt(f.template_count || '0') > 0);

  // Step 3: For each template folder, fetch its contents (paginate if needed)
  const templates = [];
  for (const folder of templateFolders) {
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const contentsUrl = `${apiBase}/folder/${folder.id}?limit=${limit}&offset=${offset}`;
      const contentsRes = await fetch(contentsUrl, { headers, signal: AbortSignal.timeout(30000) });
      if (!contentsRes.ok) {
        console.warn(`[signnow] Failed to fetch folder ${folder.name} (${folder.id}): ${contentsRes.status}`);
        break;
      }
      const contentsData = await contentsRes.json();
      const docs = contentsData.documents || [];

      for (const doc of docs) {
        templates.push({
          id: doc.id,
          name: doc.document_name || doc.name || 'Untitled',
          page_count: doc.page_count,
          template: doc.template,
          roles: (doc.roles || []).map(r => ({ name: r.name, signing_order: r.signing_order, unique_id: r.unique_id })),
          created: doc.created,
          folder_name: folder.name,
          folder_id: folder.id,
          shared: folder.shared,
          team_name: folder.team_name || null,
        });
      }

      // Check if we need to paginate (if we got a full page, there might be more)
      hasMore = docs.length === limit;
      offset += limit;
    }
  }

  return templates;
}

/**
 * Create a document from a template (POST /template/{template_id}/copy).
 * Returns { id, document_name } — the new document is a signable copy.
 */
async function createDocumentFromTemplate(templateId, documentName) {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const body = {};
  if (documentName) body.document_name = documentName;
  const res = await fetch(`${apiBase}/template/${templateId}/copy`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow create document from template failed ${res.status}: ${t.substring(0, 200)}`);
  }
  return await res.json(); // { id, document_name }
}

/**
 * Upload a PDF document for signing.
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {string} fileName - Document name
 */
async function uploadDocument(pdfBuffer, fileName) {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', pdfBuffer, { filename: fileName, contentType: 'application/pdf' });

  const res = await fetch(`${apiBase}/document`, {
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
 * Send a field invite to sign a document (POST /document/{docId}/invite).
 *
 * This is SignNow's current API for sending a document for e-signature.
 * The old POST /link endpoint is deprecated — the field invite is the
 * correct way to send a document for signing. The signer receives an
 * email with a signing link; no direct URL is returned to the caller.
 *
 * @param {string} docId - SignNow document ID
 * @param {Array} signers - [{ email, name, role, order }]
 * @param {string} fromEmail - SignNow account email (required 'from' field)
 */
async function sendInvite(docId, signers, fromEmail) {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const body = {
    from: fromEmail,
    to: signers.map(s => ({
      email: s.email,
      name: s.name,
      order: s.order || 1,
      role: s.role || 'Signer 1',
    })),
    subject: 'Please sign this document',
    message: 'Please review and sign the attached document.',
  };
  const res = await fetch(`${apiBase}/document/${docId}/invite`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow send invite failed ${res.status}: ${t.substring(0, 200)}`);
  }
  return await res.json(); // { id, result, ... }
}

/**
 * Get document signing status.
 * @param {string} docId - SignNow document ID
 */
async function getDocumentStatus(docId) {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const res = await fetch(`${apiBase}/document/${docId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // Tagged with .status (and a friendlier .code for a 404) so callers can
    // distinguish "this document genuinely doesn't exist / isn't visible to
    // this account" from a transient/other failure, instead of treating
    // every error identically. Production incident: a document created
    // under this account's actual (possibly Eval/Sandbox) environment is
    // invisible to a DIFFERENT environment's credentials — SignNow returns
    // a plain 404 for that case, same as a truly deleted document; the
    // caller route is what turns this into a specific, honest user-facing
    // message rather than a dead link.
    const err = new Error(`SignNow get document failed ${res.status}: ${t.substring(0, 200)}`);
    err.status = res.status;
    if (res.status === 404) err.code = 'SIGNNOW_DOCUMENT_NOT_FOUND';
    throw err;
  }
  const data = await res.json();
  return data; // { id, name, status, signers, ... }
}

/**
 * The web-app (browser UI) host matching the API host this account's
 * credentials actually resolve to — NOT simply derived from
 * SIGNNOW_ENVIRONMENT, because API Key auth auto-detects and may override
 * the configured environment (getEffectiveApiBase's probe). SignNow runs
 * two completely separate environments with separate web apps:
 *   api.signnow.com      <-> app.signnow.com       (production)
 *   api-eval.signnow.com <-> app-eval.signnow.com  (sandbox/eval)
 * A document created under Eval credentials does not exist at
 * app.signnow.com at all (confirmed: SignNow's own official SDK resource
 * tables list app-eval.signnow.com as the Eval counterpart) — opening it
 * there 404s even though the document is completely valid. This was the
 * root cause of a real production defect: the CRM hardcoded
 * `https://app.signnow.com/document/{id}` regardless of which environment
 * the configured credentials actually belonged to.
 */
async function getWebAppBase() {
  if (process.env.SIGNNOW_WEBAPP_BASE) return process.env.SIGNNOW_WEBAPP_BASE;
  const apiBase = await getEffectiveApiBase();
  return apiBase === 'https://api-eval.signnow.com' ? 'https://app-eval.signnow.com' : 'https://app.signnow.com';
}

/**
 * Generate an "embedded editor" link (POST /v2/documents/{id}/embedded-editor)
 * — the officially documented, account-correct way for a document OWNER to
 * open a specific document for editing/review, with no separate SignNow
 * browser login required at all (the returned URL carries its own
 * short-lived access token). Confirmed via SignNow's official PHP/Node/Java
 * SDKs' own request/response fixtures: body fields are all optional
 * (`redirect_uri`, `redirect_target`, `link_expiration` minutes — default
 * ~15), and a 200 response is `{ data: { url: "..." } }`.
 *
 * Precondition (per SignNow's docs): the document must NOT already have
 * been sent for signing or signed — this is a PRE-SEND editor link only.
 * Callers must check the document's own state first (see routes/signnow.js)
 * and fall back to a plain web-app link for anything already sent/signed.
 *
 * @param {string} docId
 * @param {{ redirect_uri?: string, redirect_target?: 'self'|'blank', link_expiration?: number }} [opts]
 * @returns {Promise<string>} the embeddable editor URL
 */
async function getEmbeddedEditorLink(docId, opts = {}) {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const body = {};
  if (opts.redirect_uri) body.redirect_uri = opts.redirect_uri;
  if (opts.redirect_target) body.redirect_target = opts.redirect_target;
  if (opts.link_expiration) body.link_expiration = opts.link_expiration;
  const res = await fetch(`${apiBase}/v2/documents/${docId}/embedded-editor`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`SignNow embedded-editor link failed ${res.status}: ${t.substring(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const url = data?.data?.url || data?.url;
  if (!url) throw new Error('SignNow embedded-editor response had no url');
  return url;
}

/**
 * Read a document's CURRENT fields/roles — must be called on the actual
 * copied document (never the template), because SignNow assigns a copy its
 * own field and role IDs, distinct from the template's (per docs.signnow.com's
 * template-copy reference: "The copy gets its own field and role IDs, which
 * differ from the template's. Read the current roles and fields from the Get
 * document endpoint for the new document instead of reusing the template's
 * IDs."). Shares the same GET /document/{id} call as getDocumentStatus —
 * this is a separate, purpose-named entry point for prepare-time field/role
 * introspection (as opposed to getDocumentStatus's signing-status polling)
 * so each caller's intent stays clear, not a second HTTP implementation.
 *
 * Normalizes to a best-effort uniform shape, since the raw SignNow field
 * object shape for "its programmatic name" has not been verified against a
 * live account in this environment (no SignNow credentials configured here)
 * — several plausible key names are tried defensively rather than assumed.
 *
 * @param {string} docId - SignNow document ID (the COPY, not the template)
 * @returns {{ fields: Array<{name: string, type: string|null, id: string|null}>,
 *             roles: Array, approverRoles: Array, viewerRoles: Array, raw: object }}
 */
async function getDocumentFields(docId) {
  const data = await getDocumentStatus(docId);
  const rawFields = Array.isArray(data.fields) ? data.fields : [];
  const fields = rawFields.map((f) => ({
    name: f.json_attributes?.name || f.data?.name || f.name || f.field_name || f.element_id || null,
    type: f.type || f.role_name || f.json_attributes?.type || null,
    id: f.id || f.unique_id || f.element_id || null,
  })).filter((f) => f.name);
  return {
    fields,
    roles: Array.isArray(data.roles) ? data.roles : [],
    approverRoles: Array.isArray(data.approver_roles) ? data.approver_roles : [],
    viewerRoles: Array.isArray(data.viewer_roles) ? data.viewer_roles : [],
    raw: data,
  };
}

/**
 * Prefill TEXT fields on a document (PUT /v2/documents/{id}/prefill-texts).
 * Only fields of type "text" can be prefilled this way (signature/initial/
 * date/checkbox fields cannot) — per docs.signnow.com. Success is 204 No
 * Content. Prefilled values remain editable by the signer — this is NOT a
 * lock, just automatic population to avoid the user re-typing CRM data.
 *
 * @param {string} docId
 * @param {Array<{field_name: string, prefilled_text: string}>} fields
 */
async function prefillTexts(docId, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return { skipped: true };
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const res = await fetch(`${apiBase}/v2/documents/${docId}/prefill-texts`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SignNow prefill-texts failed ${res.status}: ${t.substring(0, 200)}`);
  }
  // 204 No Content — nothing to parse.
  return { ok: true };
}

/**
 * Download the signed PDF.
 * @param {string} docId - SignNow document ID
 */
async function downloadSignedPdf(docId) {
  const token = await getAccessToken();
  const apiBase = await getEffectiveApiBase();
  const res = await fetch(`${apiBase}/document/${docId}/download?type=collapsed`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' },
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
  getUserInfo,
  listTemplates,
  createDocumentFromTemplate,
  uploadDocument,
  sendInvite,
  getDocumentStatus,
  getDocumentFields,
  prefillTexts,
  checkConnection,
  getWebAppBase,
  getEmbeddedEditorLink,
  downloadSignedPdf,
  authHeaders, // exported for diagnostic parity (server.js /signnow/diagnostic)
  getApiBase: () => SIGNNOW_API_BASE, // static env-derived base (for diagnostics)
  getEffectiveApiBase, // async — auto-detected base for API Key mode
  getEnvironment: () => SIGNNOW_ENV,
};