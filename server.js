/* eslint-disable no-undef */
/**
 * QuickBooks Proxy Server
 * 
 * Deploys to: AWS Lambda + API Gateway, Google Cloud Run, or any VPS (Node.js)
 * Purpose: All QB API calls go through here so only this server's static IP
 *          needs to be whitelisted with Intuit Production.
 * 
 * ENVIRONMENT VARIABLES (set on the server, NOT in Base44):
 *   QB_CLIENT_ID         - from Intuit Developer Portal (Production app)
 *   QB_CLIENT_SECRET     - from Intuit Developer Portal (Production app)
 *   QB_REDIRECT_URI      - OAuth redirect URI (must match Intuit app config)
 *   QB_ENVIRONMENT       - "sandbox" or "production"
 *   PROXY_SECRET         - shared secret; Base44 must send this in X-Proxy-Secret header
 *   PORT                 - (optional) defaults to 3000
 */

// NOTE: This file is a standalone Node.js server — not a browser or Deno module.
// Run with: node server.js  (requires Node.js 18+)
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// QB estimate sync (replaces Base44 scheduled syncEstimatesFromQBDirect)
const qbMatch = require('./lib/qbMatch');
const b44 = require('./lib/base44');

const app = express();

// ── CORS — allow requests from any Base44 app domain ────────────────────────
app.use(cors({
  origin: true, // reflect request origin (all Base44 app origins are valid)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Proxy-Secret'],
  credentials: false,
}));

app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────

const QB_CLIENT_ID     = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI  = process.env.QB_REDIRECT_URI;
const QB_ENVIRONMENT   = process.env.QB_ENVIRONMENT || 'sandbox';
const PROXY_SECRET     = process.env.PROXY_SECRET;
const ENCRYPTION_KEY   = process.env.ENCRYPTION_KEY;
const BASE44_APP_ID    = process.env.BASE44_APP_ID;
const BASE44_API_KEY   = process.env.BASE44_API_KEY;
const BASE44_API_URL   = process.env.BASE44_API_URL || 'https://api.base44.com';

if (!ENCRYPTION_KEY) {
  console.error('[proxy] FATAL: ENCRYPTION_KEY not set in environment. Exiting.');
  process.exit(1);
}

const PROXY_SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_ENVIRONMENT_NAME || 'QB Proxy (Unknown Service)';
const USE_BASE44_STORAGE = BASE44_APP_ID && BASE44_API_KEY;

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const QB_SCOPES    = 'com.intuit.quickbooks.accounting openid profile email';

const QB_API_BASE = QB_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com/v3/company'
  : 'https://sandbox-quickbooks.api.intuit.com/v3/company';

// ── Persistent Token Storage ────────────────────────────────────────────────

const TOKEN_FILE = path.join(__dirname, '.qb-tokens.encrypted');

function encryptToken(data) {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptToken(encryptedData) {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const [ivHex, encrypted] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// ── Base44 Persistent Storage (Primary) ──────────────────────────────────────
async function loadTokensFromBase44(realmId) {
  if (!USE_BASE44_STORAGE) return null;
  try {
    const key = `qb_tokens_${QB_ENVIRONMENT}_${realmId}`;
    const url = `${BASE44_API_URL}/entities/QBConnection?filter={"key":"${encodeURIComponent(key)}"}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'X-App-ID': BASE44_APP_ID }
    });
    const data = await res.json();
    if (data && data.length > 0) {
      const encrypted = data[0].encrypted_tokens;
      console.log('[proxy] Tokens loaded from Base44 database');
      return decryptToken(encrypted);
    }
  } catch (e) {
    console.warn('[proxy] Base44 token load failed (will fall back to filesystem):', e.message);
  }
  return null;
}

async function saveTokensToBase44(tokens, realmId) {
  if (!USE_BASE44_STORAGE) return false;
  try {
    const key = `qb_tokens_${QB_ENVIRONMENT}_${realmId}`;
    const encrypted = encryptToken(tokens);
    const url = `${BASE44_API_URL}/entities/QBConnection`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'X-App-ID': BASE44_APP_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, encrypted_tokens: encrypted, realm_id: realmId, environment: QB_ENVIRONMENT })
    });
    if (res.ok) {
      console.log('[proxy] Tokens saved to Base44 database');
      return true;
    }
  } catch (e) {
    console.warn('[proxy] Base44 token save failed (will fall back to filesystem):', e.message);
  }
  return false;
}

// ── Filesystem Fallback ──────────────────────────────────────────────────────
function loadTokensFromFile() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const encrypted = fs.readFileSync(TOKEN_FILE, 'utf8');
      console.log('[proxy] Tokens loaded from filesystem (.qb-tokens.encrypted)');
      return decryptToken(encrypted);
    }
  } catch (e) {
    console.error('[proxy] Failed to load tokens from file:', e.message);
  }
  return null;
}

function saveTokensToFile(tokens) {
  try {
    const encrypted = encryptToken(tokens);
    fs.writeFileSync(TOKEN_FILE, encrypted, 'utf8');
    console.log('[proxy] Tokens saved to filesystem (.qb-tokens.encrypted)');
  } catch (e) {
    console.error('[proxy] Failed to save tokens to file:', e.message);
  }
}

// Load tokens on startup (try Base44 first, fallback to filesystem)
let storedTokens = loadTokensFromFile();
let tokenStorageMethod = 'filesystem';

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireProxySecret(req, res, next) {
  const secret = req.headers['x-proxy-secret'];
  if (!PROXY_SECRET || secret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid X-Proxy-Secret' });
  }
  next();
}

// ── Token helpers ────────────────────────────────────────────────────────────

// Custom error class to signal reconnect required to Base44
class ReconnectRequiredError extends Error {
  constructor(reason) {
    super(`QUICKBOOKS_RECONNECT_REQUIRED: ${reason}`);
    this.code = 'QUICKBOOKS_RECONNECT_REQUIRED';
    this.reconnectRequired = true;
  }
}

function isTokenExpiredOrClose(tokens) {
  if (!tokens || !tokens.expires_at) return true;
  // Refresh 5 minutes before expiry
  return Date.now() >= new Date(tokens.expires_at).getTime() - 5 * 60 * 1000;
}

function isRefreshTokenExpired(tokens) {
  if (!tokens || !tokens.refresh_expires_at) return false;
  return Date.now() >= new Date(tokens.refresh_expires_at).getTime();
}

async function doRefreshToken() {
  if (!storedTokens || !storedTokens.refresh_token) {
    throw new ReconnectRequiredError('No refresh token stored');
  }
  if (isRefreshTokenExpired(storedTokens)) {
    console.error('[proxy] Refresh token is expired — reconnect required');
    throw new ReconnectRequiredError('Refresh token expired');
  }

  console.log('[proxy] Access token expired or close to expiry — refreshing...');
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: storedTokens.refresh_token }).toString(),
  });
  const data = await res.json();

  if (!res.ok) {
    const errCode = data.error || '';
    const errDesc = data.error_description || errCode;
    // Intuit returns these codes when the refresh token is invalid/revoked
    if (['invalid_grant', 'token_revoked', 'AuthenticationFailed'].includes(errCode)) {
      console.error(`[proxy] Refresh token invalid/revoked (${errCode}) — reconnect required`);
      throw new ReconnectRequiredError(`Refresh failed: ${errDesc}`);
    }
    console.error(`[proxy] Token refresh failed: ${errDesc}`);
    throw new Error(`Token refresh failed: ${errDesc}`);
  }

  storedTokens = {
    ...storedTokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || storedTokens.refresh_token,
    expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
    // Intuit rotates refresh token expiry on each use
    refresh_expires_at: data.x_refresh_token_expires_in
      ? new Date(Date.now() + data.x_refresh_token_expires_in * 1000).toISOString()
      : storedTokens.refresh_expires_at,
    last_refresh_at: new Date().toISOString(),
  };

  const savedToBase44 = await saveTokensToBase44(storedTokens, storedTokens.realm_id);
  if (!savedToBase44) saveTokensToFile(storedTokens);
  console.log(`[proxy] Token refreshed successfully — expires ${storedTokens.expires_at}`);
  return storedTokens;
}

async function getValidTokens() {
  if (!storedTokens) {
    throw new ReconnectRequiredError('No tokens stored — QB has never been connected');
  }
  if (isTokenExpiredOrClose(storedTokens)) {
    return await doRefreshToken();
  }
  console.log(`[proxy] Token valid — expires ${storedTokens.expires_at}`);
  return storedTokens;
}

async function qbFetch(path, options = {}, retried = false) {
  const tokens = await getValidTokens();
  const url = `${QB_API_BASE}/${tokens.realm_id}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  // If QB returns 401 and we haven't retried yet, force-refresh and retry once
  if (res.status === 401 && !retried) {
    console.warn('[proxy] QB returned 401 — forcing token refresh and retrying once');
    storedTokens = { ...storedTokens, expires_at: new Date(0).toISOString() }; // force expiry
    return qbFetch(path, options, true);
  }

  if (!res.ok) {
    const detail = json?.Fault?.Error?.[0]?.Detail || json?.Fault?.Error?.[0]?.Message || text.slice(0, 300);
    throw Object.assign(new Error(`QB ${res.status}: ${detail}`), { status: res.status, qbError: json });
  }
  return json;
}

async function qbQuery(query) {
  return qbFetch(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
}

// Shared error handler — converts ReconnectRequiredError into a standard response
function handleQBError(e, res) {
  if (e.reconnectRequired) {
    console.error(`[proxy] Reconnect required: ${e.message}`);
    return res.status(401).json({
      error: 'QUICKBOOKS_RECONNECT_REQUIRED',
      message: e.message,
      reconnectRequired: true,
    });
  }
  return res.status(e.status || 500).json({ error: e.message, qbError: e.qbError });
}

// ── Health & Diagnostics ───────────────────────────────────────────────────

function buildHealthPayload() {
  const now = Date.now();
  const tokenExpired = isTokenExpiredOrClose(storedTokens);
  const refreshExpired = isRefreshTokenExpired(storedTokens);
  const reconnectRequired = !storedTokens || refreshExpired;
  const connected = !!(storedTokens && !refreshExpired);
  return {
    status: 'ok',
    service_name: PROXY_SERVICE_NAME,
    environment: QB_ENVIRONMENT,
    connected,
    realmId: storedTokens?.realm_id || null,
    tokenExpiresAt: storedTokens?.expires_at || null,
    tokenExpired,
    refreshExpiresAt: storedTokens?.refresh_expires_at || null,
    reconnectRequired,
    lastRefreshedAt: storedTokens?.last_refresh_at || null,
    connectedAt: storedTokens?.connected_at || null,
    storageMethod: USE_BASE44_STORAGE ? 'base44_database+filesystem_fallback' : 'filesystem',
  };
}

// General health (no auth required)
app.get('/health', (req, res) => {
  res.json(buildHealthPayload());
});

// QB-specific health endpoint (matches requirement: GET /qb/health)
app.get('/qb/health', (req, res) => {
  const payload = buildHealthPayload();
  res.json(payload);
});

// ── Auth routes ──────────────────────────────────────────────────────────────

// GET /auth/connect — returns the Intuit OAuth URL
// Accepts optional ?redirect_uri= override so the CRM can pass its production URL
app.get('/auth/connect', requireProxySecret, (req, res) => {
  if (!QB_CLIENT_ID) return res.status(500).json({ error: 'QB_CLIENT_ID not configured on proxy' });
  const redirectUri = req.query.redirect_uri || QB_REDIRECT_URI;
  if (!redirectUri) return res.status(500).json({ error: 'QB_REDIRECT_URI not configured on proxy and no redirect_uri param provided' });
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    response_type: 'code',
    scope: QB_SCOPES,
    redirect_uri: redirectUri,
    state: 'qb_oauth',
  });
  console.log('[proxy] /auth/connect — using redirect_uri:', redirectUri);
  res.json({ auth_url: `${QB_AUTH_URL}?${params}`, environment: QB_ENVIRONMENT, redirect_uri: redirectUri });
});

// POST /auth/callback — exchange code for tokens (called from your OAuth callback page)
// Accepts optional redirect_uri in body to match what was used in /auth/connect
app.post('/auth/callback', requireProxySecret, async (req, res) => {
  const { code, realmId, redirect_uri } = req.body;
  if (!code || !realmId) return res.status(400).json({ error: 'Missing code or realmId' });

  const redirectUri = redirect_uri || QB_REDIRECT_URI;
  if (!redirectUri) return res.status(500).json({ error: 'QB_REDIRECT_URI not configured and no redirect_uri in request body' });
  console.log('[proxy] /auth/callback — using redirect_uri:', redirectUri);

  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) return res.status(400).json({ error: tokenData.error_description || 'Token exchange failed' });

  storedTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    realm_id: realmId,
    environment: QB_ENVIRONMENT,
    expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + (tokenData.x_refresh_token_expires_in || 8726400) * 1000).toISOString(),
    connected_at: new Date().toISOString(),
  };

  // Save to Base44 if available, fallback to filesystem
  const savedToBase44 = await saveTokensToBase44(storedTokens, realmId);
  if (!savedToBase44) saveTokensToFile(storedTokens);
  tokenStorageMethod = savedToBase44 ? 'base44_database' : 'filesystem';
  
  console.log('[proxy] OAuth complete — realm_id:', realmId, 'env:', QB_ENVIRONMENT, 'storage:', tokenStorageMethod);
  res.json({ success: true, realm_id: realmId, environment: QB_ENVIRONMENT, storage_method: tokenStorageMethod });
});

// GET /auth/status — connection status
app.get('/auth/status', requireProxySecret, (req, res) => {
  if (!storedTokens) return res.json({ connected: false, reconnectRequired: true });
  const refreshExpired = isRefreshTokenExpired(storedTokens);
  res.json({
    connected: !refreshExpired,
    reconnectRequired: refreshExpired,
    realm_id: storedTokens.realm_id,
    environment: QB_ENVIRONMENT,
    connected_at: storedTokens.connected_at,
    refresh_expires_at: storedTokens.refresh_expires_at,
    token_expires_at: storedTokens.expires_at,
  });
});

// POST /auth/disconnect
app.post('/auth/disconnect', requireProxySecret, (req, res) => {
  storedTokens = null;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  } catch (e) {
    console.error('[proxy] Failed to delete token file:', e.message);
  }
  res.json({ success: true });
});

// ── Company Info ─────────────────────────────────────────────────────────────

app.get('/company', requireProxySecret, async (req, res) => {
  try {
    const tokens = await getValidTokens();
    const data = await qbFetch(`/companyinfo/${tokens.realm_id}?minorversion=65`);
    res.json({ company: data.CompanyInfo });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// ── Customers ─────────────────────────────────────────────────────────────────

// GET /customers?since=ISO_DATE   — paginated fetch of all customers (optional incremental)
app.get('/customers', requireProxySecret, async (req, res) => {
  try {
    const { since } = req.query;
    const whereClause = since ? ` WHERE MetaData.LastUpdatedTime > '${since}'` : '';
    const all = [];
    let pos = 1;
    while (true) {
      const qr = await qbQuery(`SELECT * FROM Customer${whereClause} STARTPOSITION ${pos} MAXRESULTS 1000`);
      const batch = qr?.QueryResponse?.Customer || [];
      all.push(...batch);
      if (batch.length < 1000) break;
      pos += 1000;
    }
    res.json({ customers: all, total: all.length, environment: QB_ENVIRONMENT });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// GET /customers/:id — fetch a single customer by QB ID
app.get('/customers/:id', requireProxySecret, async (req, res) => {
  try {
    const data = await qbFetch(`/customer/${req.params.id}?minorversion=65`);
    res.json({ customer: data.Customer });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// POST /customers — create or update a customer
app.post('/customers', requireProxySecret, async (req, res) => {
  try {
    const data = await qbFetch('/customer?minorversion=65', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (e) {
    return handleQBError(e, res);
  }
});

// GET /customers/search?displayName=X&email=Y
app.get('/customers/search', requireProxySecret, async (req, res) => {
  try {
    const { displayName, email } = req.query;
    let customer = null;

    if (email) {
      const qr = await qbQuery(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email.replace(/'/g, "\\'")}' MAXRESULTS 1`);
      customer = qr?.QueryResponse?.Customer?.[0] || null;
    }
    if (!customer && displayName) {
      const qr = await qbQuery(`SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}' MAXRESULTS 1`);
      customer = qr?.QueryResponse?.Customer?.[0] || null;
    }
    if (!customer && displayName) {
      const qr = await qbQuery(`SELECT * FROM Customer WHERE DisplayName LIKE '${displayName.replace(/'/g, "\\'")}' MAXRESULTS 5`);
      const candidates = qr?.QueryResponse?.Customer || [];
      const nameLower = displayName.toLowerCase();
      customer = candidates.find(c => (c.DisplayName || '').toLowerCase() === nameLower) || candidates[0] || null;
    }

    res.json({ customer });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// ── Estimates ─────────────────────────────────────────────────────────────────

// GET /estimates?since=ISO_DATE&customerId=X   — paginated
// NOTE: QB's Estimate query WITHOUT a status filter only returns "Pending" estimates.
// To get ALL estimates (including Accepted, Closed, Converted), we query each status separately.
app.get('/estimates', requireProxySecret, async (req, res) => {
  try {
    const { since, customerId } = req.query;

    if (customerId || since) {
      let whereClause = customerId
        ? ` WHERE CustomerRef = '${customerId}'`
        : ` WHERE MetaData.LastUpdatedTime > '${since}'`;
      const all = [];
      let pos = 1;
      while (true) {
        const qr = await qbQuery(`SELECT * FROM Estimate${whereClause} STARTPOSITION ${pos} MAXRESULTS 1000`);
        const batch = qr?.QueryResponse?.Estimate || [];
        all.push(...batch);
        if (batch.length < 1000) break;
        pos += 1000;
      }
      return res.json({ estimates: all, total: all.length, environment: QB_ENVIRONMENT });
    }

    const allStatuses = ['Pending', 'Accepted', 'Closed'];
    const all = [];
    const seenIds = new Set();
    for (const status of allStatuses) {
      let pos = 1;
      while (true) {
        const qr = await qbQuery(`SELECT * FROM Estimate WHERE TxnStatus = '${status}' STARTPOSITION ${pos} MAXRESULTS 1000`);
        const batch = qr?.QueryResponse?.Estimate || [];
        for (const est of batch) {
          if (!seenIds.has(est.Id)) { seenIds.add(est.Id); all.push(est); }
        }
        if (batch.length < 1000) break;
        pos += 1000;
      }
    }
    res.json({ estimates: all, total: all.length, environment: QB_ENVIRONMENT });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// GET /estimates/by-customer/:customerId — fetch ALL estimates for a specific customer (all statuses)
// This is the reliable way to find estimates that may have been converted to invoices.
app.get('/estimates/by-customer/:customerId', requireProxySecret, async (req, res) => {
  try {
    const customerId = req.params.customerId;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    const all = [];
    let pos = 1;
    while (true) {
      const qr = await qbQuery(`SELECT * FROM Estimate WHERE CustomerRef = '${customerId}' STARTPOSITION ${pos} MAXRESULTS 1000`);
      const batch = qr?.QueryResponse?.Estimate || [];
      all.push(...batch);
      if (batch.length < 1000) break;
      pos += 1000;
    }
    res.json({ estimates: all, total: all.length, environment: QB_ENVIRONMENT });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// GET /estimates/:id — fetch a single estimate with full details
app.get('/estimates/:id', requireProxySecret, async (req, res) => {
  const id = req.params.id;
  if (!id || id === 'by-customer') return res.status(400).json({ error: 'estimateId required' });
  try {
    const data = await qbFetch(`/estimate/${id}?minorversion=65`);
    res.json({ estimate: data.Estimate });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// POST /estimates — create estimate
app.post('/estimates', requireProxySecret, async (req, res) => {
  try {
    const data = await qbFetch('/estimate?minorversion=65', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (e) {
    return handleQBError(e, res);
  }
});

// GET /estimates/:id/pdf
app.get('/estimates/:id/pdf', requireProxySecret, async (req, res) => {
  try {
    const tokens = await getValidTokens();
    const url = `${QB_API_BASE}/${tokens.realm_id}/estimate/${req.params.id}/pdf?minorversion=65`;
    const pdfRes = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/pdf' },
    });
    if (!pdfRes.ok) return res.status(pdfRes.status).json({ error: `PDF fetch failed: ${pdfRes.status}` });
    const buffer = await pdfRes.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(buffer));
  } catch (e) {
    return handleQBError(e, res);
  }
});

// ── Invoices ──────────────────────────────────────────────────────────────────

// GET /invoices?since=ISO_DATE&customerId=X
app.get('/invoices', requireProxySecret, async (req, res) => {
  try {
    const { since, customerId } = req.query;
    let whereClause = '';
    if (customerId) {
      whereClause = ` WHERE CustomerRef = '${customerId}'`;
    } else if (since) {
      whereClause = ` WHERE MetaData.LastUpdatedTime > '${since}'`;
    }

    const all = [];
    let pos = 1;
    while (true) {
      const qr = await qbQuery(`SELECT * FROM Invoice${whereClause} STARTPOSITION ${pos} MAXRESULTS 1000`);
      const batch = qr?.QueryResponse?.Invoice || [];
      all.push(...batch);
      if (batch.length < 1000) break;
      pos += 1000;
    }
    res.json({ invoices: all, total: all.length, environment: QB_ENVIRONMENT });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// POST /invoices — create invoice OR void invoice
// If body contains { operation: 'void', Id, SyncToken }, voids the invoice instead.
// This serves as a fallback for deployments where /invoices/:id/void is not yet available.
app.post('/invoices', requireProxySecret, async (req, res) => {
  try {
    if (req.body.operation === 'void' && req.body.Id && req.body.SyncToken !== undefined) {
      console.log(`[proxy] Voiding invoice ${req.body.Id} via POST /invoices fallback`);
      const data = await qbFetch('/invoice?operation=void&minorversion=65', {
        method: 'POST',
        body: JSON.stringify({ Id: req.body.Id, SyncToken: req.body.SyncToken }),
      });
      return res.json({ success: true, invoice: data.Invoice || data });
    }
    const data = await qbFetch('/invoice?minorversion=65', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (e) {
    return handleQBError(e, res);
  }
});

app.get('/invoices/:id', requireProxySecret, async (req, res) => {
  try {
    const data = await qbFetch(`/invoice/${req.params.id}?minorversion=65`);
    res.json({ invoice: data.Invoice });
  } catch (e) {
    return handleQBError(e, res);
  }
});

// POST /invoices/:id/void — void an invoice in QuickBooks
// QB void requires fetching current SyncToken, then POST with operation=void
app.post('/invoices/:id/void', requireProxySecret, async (req, res) => {
  try {
    // First fetch the invoice to get SyncToken
    const current = await qbFetch(`/invoice/${req.params.id}?minorversion=65`);
    const inv = current?.Invoice;
    if (!inv) return res.status(404).json({ error: 'Invoice not found in QuickBooks' });
    // QB void: POST to /invoice with operation=void query param
    const data = await qbFetch(`/invoice?operation=void&minorversion=65`, {
      method: 'POST',
      body: JSON.stringify({ Id: inv.Id, SyncToken: inv.SyncToken }),
    });
    res.json({ success: true, invoice: data.Invoice });
  } catch (e) {
    return handleQBError(e, res);
  }
});

app.get('/invoices/:id/pdf', requireProxySecret, async (req, res) => {
  try {
    const tokens = await getValidTokens();
    const url = `${QB_API_BASE}/${tokens.realm_id}/invoice/${req.params.id}/pdf?minorversion=65`;
    const pdfRes = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/pdf' },
    });
    if (!pdfRes.ok) return res.status(pdfRes.status).json({ error: `PDF fetch failed: ${pdfRes.status}` });
    const buffer = await pdfRes.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(buffer));
  } catch (e) {
    return handleQBError(e, res);
  }
});

// ── File Upload to Cloudflare R2 / S3-compatible storage ──────────────────────
//
// Required env vars (set in Railway):
//   R2_ACCOUNT_ID        — Cloudflare Account ID (for R2 endpoint)
//   R2_ACCESS_KEY_ID     — R2 API token Access Key ID
//   R2_SECRET_ACCESS_KEY — R2 API token Secret Access Key
//   R2_BUCKET_NAME       — R2 bucket name
//   R2_PUBLIC_URL        — Public base URL for served files, e.g. https://files.ecconstructiongroup.com
//                          (or Cloudflare R2 public URL like https://pub-xxxx.r2.dev)
//
// Alternatively, use plain S3:
//   S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_NAME, S3_PUBLIC_URL

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL        = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// S3 fallback config
const S3_REGION            = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY_ID     = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME       = process.env.S3_BUCKET_NAME;
const S3_PUBLIC_URL        = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');

// Build S3 client (R2 is S3-compatible — just uses a different endpoint)
let s3Client = null;
let activeBucket = null;
let activePublicUrl = null;

if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  activeBucket = R2_BUCKET_NAME;
  activePublicUrl = R2_PUBLIC_URL;
  console.log('[upload] Cloudflare R2 configured — bucket:', R2_BUCKET_NAME);
} else if (S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && S3_BUCKET_NAME) {
  s3Client = new S3Client({
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
  activeBucket = S3_BUCKET_NAME;
  activePublicUrl = S3_PUBLIC_URL || `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com`;
  console.log('[upload] AWS S3 configured — bucket:', S3_BUCKET_NAME);
} else {
  console.warn('[upload] No R2/S3 credentials configured — file uploads will be disabled');
}

// multer: memory storage (we stream directly to R2/S3, no temp disk needed)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

// POST /api/files/upload
// Accepts: multipart/form-data with field "file"
// Returns: { success, url, key, fileName, contentType, size }
app.post('/api/files/upload', requireProxySecret, upload.single('file'), async (req, res) => {
  if (!s3Client) {
    return res.status(503).json({ success: false, error: 'File storage not configured on server. Set R2_* or S3_* environment variables.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file provided. Use multipart/form-data with field name "file".' });
  }

  try {
    const file = req.file;
    // Build a unique key: uploads/<year>/<month>/<timestamp>-<sanitized-filename>
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ts = now.getTime();
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `uploads/${year}/${month}/${ts}-${sanitized}`;

    const command = new PutObjectCommand({
      Bucket: activeBucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ContentDisposition: `inline; filename="${sanitized}"`,
    });

    await s3Client.send(command);

    const url = activePublicUrl ? `${activePublicUrl}/${key}` : `https://${activeBucket}/${key}`;

    console.log(`[upload] Uploaded: ${key} (${file.size} bytes)`);

    res.json({
      success: true,
      url,
      key,
      fileName: file.originalname,
      contentType: file.mimetype,
      size: file.size,
    });
  } catch (err) {
    console.error('[upload] Upload failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/files/status — check if file uploads are configured
app.get('/api/files/status', requireProxySecret, (req, res) => {
  res.json({
    configured: !!s3Client,
    provider: R2_ACCOUNT_ID ? 'cloudflare_r2' : S3_ACCESS_KEY_ID ? 'aws_s3' : 'none',
    bucket: activeBucket || null,
    publicUrl: activePublicUrl || null,
  });
});

// POST /api/files/signed-url — short-lived presigned GET URL for one private R2 object
// Body: { key: "uploads/...", disposition: "inline" | "attachment" }
// Returns: { success, url, expiresIn: 600 }
app.post('/api/files/signed-url', requireProxySecret, async (req, res) => {
  const { key, disposition } = req.body || {};
  if (!key || typeof key !== 'string' || !key.startsWith('uploads/')) {
    return res.status(400).json({ success: false, error: 'Invalid key (must start with uploads/).' });
  }
  if (!s3Client) {
    return res.status(503).json({ success: false, error: 'File storage not configured on server.' });
  }
  try {
    const isAttachment = disposition === 'attachment';
    const fileName = key.split('/').pop() || 'file';
    const command = new GetObjectCommand({
      Bucket: activeBucket,
      Key: key,
      ResponseContentDisposition: isAttachment
        ? `attachment; filename="${fileName}"`
        : 'inline',
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 600 });
    res.json({ success: true, url, expiresIn: 600 });
  } catch (err) {
    console.error('[signed-url] Failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/files/delete — delete one R2 object by key
// Body: { key: "uploads/..." }
// Returns: { success, key }
app.delete('/api/files/delete', requireProxySecret, async (req, res) => {
  const { key } = req.body || {};
  // ── TEMPORARY TRACE: R2 delete verification (remove after diagnosis) ──
  console.log('[EXPENSE-DELETE-TRACE] proxy.delete route hit key=', key);
  if (!key || typeof key !== 'string' || !key.startsWith('uploads/')) {
    console.log('[EXPENSE-DELETE-TRACE] proxy.delete rejecting: invalid key');
    return res.status(400).json({ success: false, error: 'Invalid key (must start with uploads/).' });
  }
  if (!s3Client) {
    console.log('[EXPENSE-DELETE-TRACE] proxy.delete rejecting: s3Client not configured');
    return res.status(503).json({ success: false, error: 'File storage not configured on server.' });
  }
  try {
    // Log exact S3/R2 target configuration
    console.log('[EXPENSE-DELETE-TRACE] proxy.delete S3 config', {
      bucket: activeBucket,
      accountId: R2_ACCOUNT_ID || '(s3 fallback)',
      endpoint: R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : `aws-s3:${S3_REGION}`,
      key,
    });

    // 1. Send DeleteObjectCommand and log the raw response
    const deleteCmd = new DeleteObjectCommand({ Bucket: activeBucket, Key: key });
    const deleteRes = await s3Client.send(deleteCmd);
    console.log('[EXPENSE-DELETE-TRACE] proxy.delete DeleteObjectCommand rawResponse', {
      $metadata: deleteRes?.$metadata,
      DeleteMarker: deleteRes?.DeleteMarker,
      VersionId: deleteRes?.VersionId,
      ETag: deleteRes?.ETag,
    });

    // 2. Immediately verify with HeadObjectCommand
    let headStatus = 'unknown';
    let headInfo = {};
    try {
      const headRes = await s3Client.send(new HeadObjectCommand({ Bucket: activeBucket, Key: key }));
      headStatus = '200_OBJECT_STILL_EXISTS';
      headInfo = {
        $metadata: headRes?.$metadata,
        ContentLength: headRes?.ContentLength,
        ContentType: headRes?.ContentType,
        ETag: headRes?.ETag,
        LastModified: headRes?.LastModified,
      };
      console.log('[EXPENSE-DELETE-TRACE] proxy.delete HeadObjectCommand result=200 OBJECT STILL EXISTS', headInfo);
    } catch (headErr) {
      const name = headErr?.name || '';
      const code = headErr?.Code || headErr?.$metadata?.httpStatusCode || headErr?.$response?.status;
      const httpStatus = headErr?.$metadata?.httpStatusCode || headErr?.$response?.status;
      if (httpStatus === 404 || name === 'NotFound' || code === '404' || code === 'NoSuchKey') {
        headStatus = '404_OBJECT_DELETED';
        headInfo = { httpStatus, name, code };
        console.log('[EXPENSE-DELETE-TRACE] proxy.delete HeadObjectCommand result=404 OBJECT CONFIRMED DELETED', headInfo);
      } else {
        headStatus = 'HEAD_ERROR';
        headInfo = { httpStatus, name, code, message: headErr?.message };
        console.log('[EXPENSE-DELETE-TRACE] proxy.delete HeadObjectCommand result=ERROR', headInfo);
      }
    }

    console.log(`[delete] Deleted R2 object: ${key} (head=${headStatus})`);
    res.json({ success: true, key, headStatus, headInfo });
  } catch (err) {
    console.error('[EXPENSE-DELETE-TRACE] proxy.delete DeleteObjectCommand threw:', err.message, err);
    res.status(500).json({ success: false, error: err.message });
  }
  // ── END TEMPORARY TRACE ──
});

// ── /qb/* alias routes (thin POST wrappers over existing QB logic) ────────────
// These match the paths the CRM frontend calls via railwayClient.js

app.post('/qb/auth-status', requireProxySecret, (req, res) => {
  if (!storedTokens) return res.json({ connected: false, reconnectRequired: true });
  const refreshExpired = isRefreshTokenExpired(storedTokens);
  res.json({
    connected: !refreshExpired,
    reconnectRequired: refreshExpired,
    realm_id: storedTokens.realm_id,
    environment: QB_ENVIRONMENT,
    connected_at: storedTokens.connected_at,
    refresh_expires_at: storedTokens.refresh_expires_at,
    token_expires_at: storedTokens.expires_at,
  });
});

app.post('/qb/auth-connect', requireProxySecret, (req, res) => {
  if (!QB_CLIENT_ID) return res.status(500).json({ error: 'QB_CLIENT_ID not configured on proxy' });
  const redirectUri = req.body.redirect_uri || QB_REDIRECT_URI;
  if (!redirectUri) return res.status(500).json({ error: 'QB_REDIRECT_URI not configured' });
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID, response_type: 'code', scope: QB_SCOPES,
    redirect_uri: redirectUri, state: 'qb_oauth',
  });
  res.json({ auth_url: `${QB_AUTH_URL}?${params}`, environment: QB_ENVIRONMENT, redirect_uri: redirectUri });
});

app.post('/qb/auth-callback', requireProxySecret, async (req, res) => {
  const { code, realmId, redirect_uri } = req.body;
  if (!code || !realmId) return res.status(400).json({ error: 'Missing code or realmId' });
  const redirectUri = redirect_uri || QB_REDIRECT_URI;
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) return res.status(400).json({ error: tokenData.error_description || 'Token exchange failed' });
  storedTokens = {
    access_token: tokenData.access_token, refresh_token: tokenData.refresh_token, realm_id: realmId,
    environment: QB_ENVIRONMENT,
    expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + (tokenData.x_refresh_token_expires_in || 8726400) * 1000).toISOString(),
    connected_at: new Date().toISOString(),
  };
  const savedToBase44 = await saveTokensToBase44(storedTokens, realmId);
  if (!savedToBase44) saveTokensToFile(storedTokens);
  res.json({ success: true, realm_id: realmId, environment: QB_ENVIRONMENT });
});

app.post('/qb/auth-disconnect', requireProxySecret, (req, res) => {
  storedTokens = null;
  try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch (e) {}
  res.json({ success: true });
});

app.post('/qb/get-company', requireProxySecret, async (req, res) => {
  try {
    const tokens = await getValidTokens();
    const data = await qbFetch(`/companyinfo/${tokens.realm_id}?minorversion=65`);
    res.json({ company: data.CompanyInfo });
  } catch (e) { return handleQBError(e, res); }
});

// QB lead-level operations — these require business logic that lives in CRM context.
// The proxy handles raw QB API calls; orchestration (matching leads, syncing fields) 
// requires the caller to pass data and the proxy to execute QB API calls.

app.post('/qb/lead-status', requireProxySecret, async (req, res) => {
  // Returns QB customer + invoice data for a lead given qb_customer_id or name/email
  const { qb_customer_id, name, email } = req.body;
  try {
    let customer = null;
    if (qb_customer_id) {
      const data = await qbFetch(`/customer/${qb_customer_id}?minorversion=65`);
      customer = data.Customer;
    } else if (email || name) {
      const q = email
        ? `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${(email||'').replace(/'/g,"\\'")}' MAXRESULTS 1`
        : `SELECT * FROM Customer WHERE DisplayName LIKE '${(name||'').replace(/'/g,"\\'")}' MAXRESULTS 1`;
      const qr = await qbQuery(q);
      customer = qr?.QueryResponse?.Customer?.[0] || null;
    }
    if (!customer) return res.json({ found: false });
    const invoiceQr = await qbQuery(`SELECT * FROM Invoice WHERE CustomerRef = '${customer.Id}' MAXRESULTS 100`);
    const invoices = invoiceQr?.QueryResponse?.Invoice || [];
    res.json({ found: true, customer, invoices });
  } catch (e) { return handleQBError(e, res); }
});

app.post('/qb/sync-lead', requireProxySecret, async (req, res) => {
  // Creates or updates a QB customer from lead data, creates invoice if amount provided
  const { lead } = req.body;
  if (!lead) return res.status(400).json({ error: 'lead required in body' });
  try {
    const displayName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
    // Find or create customer
    let customer = null;
    if (lead.qb_customer_id) {
      const data = await qbFetch(`/customer/${lead.qb_customer_id}?minorversion=65`);
      customer = data.Customer;
    } else {
      const qr = await qbQuery(`SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g,"\\'")}' MAXRESULTS 1`);
      customer = qr?.QueryResponse?.Customer?.[0] || null;
    }
    if (!customer) {
      const payload = { DisplayName: displayName };
      if (lead.email) payload.PrimaryEmailAddr = { Address: lead.email };
      if (lead.phone) payload.PrimaryPhone = { FreeFormNumber: lead.phone };
      if (lead.property_address) payload.BillAddr = { Line1: lead.property_address, City: lead.city || '' };
      const created = await qbFetch('/customer?minorversion=65', { method: 'POST', body: JSON.stringify(payload) });
      customer = created.Customer;
    }
    res.json({ success: true, customer_id: customer.Id, customer });
  } catch (e) { return handleQBError(e, res); }
});

app.post('/qb/clear-stale', requireProxySecret, (req, res) => {
  // Stale QB data clearing is a CRM-side operation (updating Lead entity fields).
  // This endpoint acknowledges the request — actual field clearing done by caller.
  res.json({ success: true, message: 'Stale QB fields should be cleared on the CRM entity directly.' });
});

app.post('/qb/diagnose-customer', requireProxySecret, async (req, res) => {
  const { name, email, qb_customer_id } = req.body;
  try {
    const results = {};
    if (qb_customer_id) {
      const data = await qbFetch(`/customer/${qb_customer_id}?minorversion=65`).catch(e => ({ error: e.message }));
      results.by_id = data;
    }
    if (email) {
      const qr = await qbQuery(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${(email||'').replace(/'/g,"\\'")}' MAXRESULTS 5`);
      results.by_email = qr?.QueryResponse?.Customer || [];
    }
    if (name) {
      const qr = await qbQuery(`SELECT * FROM Customer WHERE DisplayName LIKE '${(name||'').replace(/'/g,"\\'")}' MAXRESULTS 5`);
      results.by_name = qr?.QueryResponse?.Customer || [];
    }
    res.json({ success: true, results });
  } catch (e) { return handleQBError(e, res); }
});

app.post('/qb/report-match-failures', requireProxySecret, (req, res) => {
  // Match failure reporting is a CRM-side logging operation.
  res.json({ success: true, message: 'Match failure logged. Review CRM QBSyncLog entity for details.' });
});

app.post('/qb/resync-all', requireProxySecret, async (req, res) => {
  // Returns all QB customers + estimates for full CRM re-sync. Caller does the matching.
  try {
    const customersQr = await qbQuery('SELECT * FROM Customer MAXRESULTS 1000');
    const customers = customersQr?.QueryResponse?.Customer || [];
    res.json({ success: true, customers, total: customers.length });
  } catch (e) { return handleQBError(e, res); }
});

app.post('/qb/import-estimates', requireProxySecret, async (req, res) => {
  try {
    const { since, customer_id } = req.body;
    let whereClause = since ? ` WHERE MetaData.LastUpdatedTime > '${since}'` : '';
    if (customer_id) whereClause = ` WHERE CustomerRef = '${customer_id}'`;
    const all = [];
    let pos = 1;
    while (true) {
      const qr = await qbQuery(`SELECT * FROM Estimate${whereClause} STARTPOSITION ${pos} MAXRESULTS 1000`);
      const batch = qr?.QueryResponse?.Estimate || [];
      all.push(...batch);
      if (batch.length < 1000) break;
      pos += 1000;
    }
    res.json({ success: true, estimates: all, total: all.length });
  } catch (e) { return handleQBError(e, res); }
});

app.post('/qb/sync-lead-estimates', requireProxySecret, async (req, res) => {
  const { qb_customer_id, lead_name } = req.body;
  if (!qb_customer_id && !lead_name) return res.status(400).json({ error: 'qb_customer_id or lead_name required' });
  try {
    let customerId = qb_customer_id;
    if (!customerId && lead_name) {
      const qr = await qbQuery(`SELECT * FROM Customer WHERE DisplayName LIKE '${lead_name.replace(/'/g,"\\'")}' MAXRESULTS 1`);
      customerId = qr?.QueryResponse?.Customer?.[0]?.Id;
    }
    if (!customerId) return res.json({ success: false, error: 'Customer not found in QB' });
    const qr = await qbQuery(`SELECT * FROM Estimate WHERE CustomerRef = '${customerId}' MAXRESULTS 100`);
    const estimates = qr?.QueryResponse?.Estimate || [];
    res.json({ success: true, estimates, total: estimates.length, customer_id: customerId });
  } catch (e) { return handleQBError(e, res); }
});

app.post('/qb/diagnose-lead-estimates', requireProxySecret, async (req, res) => {
  const { qb_customer_id, lead_name, lead_email } = req.body;
  try {
    const results = {};
    if (qb_customer_id) {
      const qr = await qbQuery(`SELECT * FROM Estimate WHERE CustomerRef = '${qb_customer_id}' MAXRESULTS 100`);
      results.by_customer_id = qr?.QueryResponse?.Estimate || [];
    }
    if (lead_name) {
      const cqr = await qbQuery(`SELECT * FROM Customer WHERE DisplayName LIKE '${lead_name.replace(/'/g,"\\'")}' MAXRESULTS 5`);
      results.customer_name_matches = cqr?.QueryResponse?.Customer || [];
    }
    res.json({ success: true, results });
  } catch (e) { return handleQBError(e, res); }
});

app.post('/qb/fetch-estimate-pdf', requireProxySecret, async (req, res) => {
  const { estimate_id } = req.body;
  if (!estimate_id) return res.status(400).json({ error: 'estimate_id required' });
  try {
    const tokens = await getValidTokens();
    const url = `${QB_API_BASE}/${tokens.realm_id}/estimate/${estimate_id}/pdf?minorversion=65`;
    const pdfRes = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/pdf' } });
    if (!pdfRes.ok) return res.status(pdfRes.status).json({ error: `PDF fetch failed: ${pdfRes.status}` });
    const buffer = await pdfRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    res.json({ success: true, pdf_base64: base64, content_type: 'application/pdf' });
  } catch (e) { return handleQBError(e, res); }
});

// ── /calendar/* routes ────────────────────────────────────────────────────────
// Requires env vars: GOOGLE_SERVICE_ACCOUNT_JSON (base64-encoded service account JSON)
// or per-owner OAuth tokens. Return 501 until credentials are wired.

app.post('/calendar/check-conflicts', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs GOOGLE_SERVICE_ACCOUNT_JSON' });
});

app.post('/calendar/create-event', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs GOOGLE_SERVICE_ACCOUNT_JSON' });
});

app.post('/calendar/delete-event', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs GOOGLE_SERVICE_ACCOUNT_JSON' });
});

app.post('/calendar/get-blocked-slots', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs GOOGLE_SERVICE_ACCOUNT_JSON' });
});

app.post('/calendar/sync-lead', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs GOOGLE_SERVICE_ACCOUNT_JSON' });
});

// ── /contacts/* routes ────────────────────────────────────────────────────────

app.post('/contacts/sync-lead', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs GOOGLE_SERVICE_ACCOUNT_JSON' });
});

// ── /reminders/* routes ───────────────────────────────────────────────────────
// Requires: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN_YARON,
//           BASE44_APP_ID, BASE44_API_KEY (to read leads), COMPANY_PHONE, COMPANY_NAME

app.post('/reminders/send-lead', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs Gmail OAuth tokens and lead data access' });
});

// ── Reminder system (Railway-owned) ─────────────────────────────────────────
// Atomic per-reminder claims live in Railway Postgres; Base44 is used only to
// read CRM leads and to write the post-success REMINDER_SENT Activity.
// Phase 2: REMINDER_DRY_RUN=true forces dry-run (no emails, no claim writes).
app.use('/reminders', require('./lib/reminderRouter'));

// Public, unauthenticated customer-action pages (confirm / reschedule / contact).
// Token-gated by HMAC-signed expiring tokens — no proxy secret, no login.
app.use('/r', require('./lib/actionRouter'));

// ── Lead ingestion (CRM → Railway Postgres) ────────────────────────────────
// Protected by a DEDICATED secret (X-Ingest-Secret / REMINDER_INGEST_SECRET),
// separate from the proxy's X-Proxy-Secret. Creates/updates rows in the
// reminder_leads table only — no Base44, no Gmail, no reminder claims.
app.use('/api/reminders', require('./lib/leadIngestRouter'));

// ── /gmail/* routes ───────────────────────────────────────────────────────────

app.post('/gmail/check-connection', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN_*' });
});

app.post('/gmail/fetch-emails', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs Gmail OAuth tokens' });
});

app.post('/gmail/send-email', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs Gmail OAuth tokens' });
});

app.post('/gmail/send-email-via-account', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs per-owner Gmail OAuth tokens' });
});

app.post('/gmail/sync-emails', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs Gmail OAuth tokens' });
});

// ── /signnow/* routes ─────────────────────────────────────────────────────────
// Requires: SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_USERNAME, SIGNNOW_PASSWORD

app.post('/signnow/list-templates', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET' });
});

app.post('/signnow/prepare', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs SignNow credentials' });
});

app.post('/signnow/upload', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs SignNow credentials' });
});

app.post('/signnow/check-status', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs SignNow credentials' });
});

app.post('/signnow/download-pdf', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs SignNow credentials' });
});

// ── /leads/* routes ───────────────────────────────────────────────────────────
// Requires: BASE44_APP_ID, BASE44_API_KEY (to read/write Lead entity for duplicate check)

app.post('/leads/submit-capture', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — needs BASE44_APP_ID and BASE44_API_KEY for duplicate check and lead creation' });
});

// ── /handoff/* routes ─────────────────────────────────────────────────────────

app.post('/handoff/sync-estimates-for-lead', requireProxySecret, (req, res) => {
  res.status(501).json({ success: false, error: 'Railway endpoint not implemented yet — Handoff estimate sync runs via the Handoff RPA worker service' });
});

// POST /handoff/import-estimate
// Called by the Handoff RPA worker instead of BASE44_IMPORT_URL.
// Receives a single estimate payload and writes it to Base44 via the entity API.
// Requires env vars: BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional, defaults to api.base44.com)
app.post('/handoff/import-estimate', requireProxySecret, async (req, res) => {
  if (!BASE44_APP_ID || !BASE44_API_KEY) {
    return res.status(503).json({ success: false, error: 'BASE44_APP_ID and BASE44_API_KEY not configured on proxy' });
  }

  const { source, estimateId, estimateNumber, exportData } = req.body;

  if (!estimateId && !exportData) {
    return res.status(400).json({ success: false, error: 'estimateId or exportData required' });
  }

  let parsed = {};
  try {
    parsed = exportData ? JSON.parse(exportData) : req.body;
  } catch {
    parsed = req.body;
  }

  // Normalise fields from Handoff RPA payload
  const customerName = parsed.customerName || parsed.customer_name || parsed.client_name || parsed.name || '';
  const customerPhone = parsed.phone || parsed.customerPhone || parsed.client_phone || '';
  const customerEmail = parsed.email || parsed.customerEmail || parsed.client_email || '';
  const estimateAmount = parseFloat(parsed.amount || parsed.total || parsed.estimateAmount || 0) || 0;
  const estimateStatus = parsed.status || parsed.txnStatus || 'Pending';
  const estimateDate = parsed.date || parsed.txnDate || new Date().toISOString().slice(0, 10);
  const handoffEstimateId = String(estimateId || parsed.id || '');
  const handoffEstimateNumber = String(estimateNumber || parsed.number || parsed.estimateNumber || handoffEstimateId);

  if (!customerName) {
    return res.status(400).json({ success: false, error: 'customerName is required in estimate payload' });
  }

  const apiBase = BASE44_API_URL;
  const headers = {
    'Authorization': `Bearer ${BASE44_API_KEY}`,
    'X-App-ID': BASE44_APP_ID,
    'Content-Type': 'application/json',
  };

  try {
    // Check if this estimate already exists
    const checkUrl = `${apiBase}/entities/HandoffEstimate?filter=${encodeURIComponent(JSON.stringify({ handoff_estimate_id: handoffEstimateId }))}`;
    const checkRes = await fetch(checkUrl, { headers });
    const existing = await checkRes.json().catch(() => []);
    const existingRecord = Array.isArray(existing) ? existing[0] : null;

    const payload = {
      handoff_estimate_id: handoffEstimateId,
      handoff_estimate_number: handoffEstimateNumber,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      estimate_amount: estimateAmount,
      estimate_status: estimateStatus,
      estimate_date: estimateDate,
      source: 'Handoff',
      sync_source: 'Handoff',
      match_status: 'unmatched',
      last_synced_at: new Date().toISOString(),
      raw_payload: JSON.stringify(parsed).slice(0, 2000),
    };

    if (existingRecord) {
      // Update existing
      const updateRes = await fetch(`${apiBase}/entities/HandoffEstimate/${existingRecord.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
      if (!updateRes.ok) {
        const err = await updateRes.text();
        return res.status(500).json({ success: false, error: `Base44 update failed: ${err.slice(0, 200)}` });
      }
      console.log(`[handoff] Updated estimate ${handoffEstimateId} (${customerName})`);
      return res.json({ success: true, updated: true, id: existingRecord.id });
    } else {
      // Create new
      const createRes = await fetch(`${apiBase}/entities/HandoffEstimate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        return res.status(500).json({ success: false, error: `Base44 create failed: ${err.slice(0, 200)}` });
      }
      const created = await createRes.json();
      console.log(`[handoff] Imported estimate ${handoffEstimateId} (${customerName}) → id ${created.id}`);
      return res.json({ success: true, imported: true, id: created.id });
    }
  } catch (e) {
    console.error('[handoff] import-estimate error:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── QB Estimate Sync (replaces Base44 scheduled syncEstimatesFromQBDirect) ────
// Fully ported from base44/functions/syncEstimatesFromQBDirect/entry.ts (sync mode).
// QB fetch uses internal qbQuery (static IP, managed tokens). CRM reads/writes use
// the Base44 REST API via ./lib/base44.js (service-role key, no Base44 credits).
// Matching engine is the verbatim port in ./lib/qbMatch.js.
// Run manually: POST /sync/qb-estimates | POST /sync/qb-estimate-pdfs (X-Proxy-Secret).
// Auto-run: set QB_SYNC_CRON_ENABLED=true (every 15 min) — off by default so the
// Base44 scheduler stays the source of truth until parity is verified.

const SANDBOX = process.env.QB_SANDBOX === 'true';

function toDateStr(v) {
  if (!v) return undefined;
  try { return new Date(isNaN(Number(v)) ? v : Number(v)).toISOString().split('T')[0]; } catch { return undefined; }
}

// Fetch ALL QB estimates — same query as proxy GET /estimates?since=1970-01-01
// (WHERE MetaData.LastUpdatedTime > '1970-01-01...', paginated).
async function fetchAllQbEstimates() {
  const all = [];
  let pos = 1;
  const whereClause = ` WHERE MetaData.LastUpdatedTime > '1970-01-01T00:00:00Z'`;
  while (true) {
    const qr = await qbQuery(`SELECT * FROM Estimate${whereClause} STARTPOSITION ${pos} MAXRESULTS 1000`);
    const batch = qr?.QueryResponse?.Estimate || [];
    all.push(...batch);
    if (batch.length < 1000) break;
    pos += 1000;
  }
  return all;
}

async function fetchQbCustomer(customerId, cache) {
  if (cache[customerId] !== undefined) return cache[customerId];
  try {
    const data = await qbFetch(`/customer/${customerId}?minorversion=65`);
    cache[customerId] = data.Customer || null;
  } catch (e) {
    console.warn(`[qb-sync] Failed to fetch customer ${customerId}:`, e.message);
    cache[customerId] = null;
  }
  return cache[customerId];
}

// Full estimate sync — replicate syncEstimatesFromQBDirect sync mode exactly.
async function runQbEstimateSync() {
  if (!b44.isConfigured()) throw new Error('BASE44_APP_ID and BASE44_API_KEY not configured on proxy');

  const stats = { found: 0, fetched: 0, imported: 0, updated: 0, matched: 0, unmatched: 0, skipped: 0, unchanged: 0, failed: 0, errors: [] };

  const qbEstimates = await fetchAllQbEstimates();
  stats.found = qbEstimates.length;
  stats.fetched = qbEstimates.length;
  console.log(`[qb-sync] Estimates fetched: ${stats.found}`);

  const [leads, existingEstimates] = await Promise.all([
    b44.list('Lead', '-created_date', 2000, 0),
    b44.list('HandoffEstimate', '-created_date', 1000, 0),
  ]);
  console.log(`[qb-sync] Loaded ${leads.length} leads, ${existingEstimates.length} existing estimates`);

  const customerCache = {};

  for (const qbEst of qbEstimates) {
    try {
      const qbId = qbEst.Id;
      const qbNumber = qbEst.DocNumber;
      const totalAmt = qbEst.TotalAmt || 0;
      const status = qbEst.TxnStatus || qbEst.EmailStatus || 'Draft';
      const qbAppUrl = `${SANDBOX ? 'https://sandbox.qbo.intuit.com' : 'https://app.qbo.intuit.com'}/app/estimate?txnId=${qbId}`;

      const customerId = qbEst.CustomerRef?.value;
      const customerRefName = qbEst.CustomerRef?.name || '(Unknown)';

      const fullCustomer = (await fetchQbCustomer(customerId, customerCache)) || {};
      const qbCustomer = {
        ...fullCustomer,
        DisplayName: fullCustomer.DisplayName || customerRefName,
        name: customerRefName,
      };

      const existing = existingEstimates.find(e => e.qb_estimate_id === qbId);
      const matchedLead = qbMatch.findMatchingLead(qbCustomer, leads);

      const sharedBase = {
        qb_estimate_id: qbId,
        qb_estimate_number: qbNumber,
        customer_name: customerRefName,
        customer_email: fullCustomer.PrimaryEmailAddr?.Address || '',
        customer_phone: fullCustomer.PrimaryPhone?.FreeFormNumber || '',
        estimate_amount: totalAmt,
        estimate_status: status,
        estimate_date: qbEst.TxnDate,
        last_synced_at: new Date().toISOString(),
        sync_source: 'QuickBooks',
        qb_app_url: qbAppUrl,
      };

      const qbUpdatedAt = qbEst.MetaData?.LastUpdatedTime;
      const isNewer = !existing?.last_synced_at || !qbUpdatedAt || new Date(qbUpdatedAt) > new Date(existing.last_synced_at);

      if (matchedLead) {
        stats.matched++;
        const matchedFields = { ...sharedBase, lead_id: matchedLead.id, match_status: 'matched', match_method: 'qb_direct' };

        if (existing) {
          if (!isNewer) {
            stats.unchanged++;
          } else {
            const pdfReset = existing.pdf_status === 'failed' ? { pdf_status: 'pending', pdf_retry_count: 0 } : {};
            await b44.update('HandoffEstimate', existing.id, { ...matchedFields, ...pdfReset });
            stats.updated++;
          }
        } else {
          await b44.create('HandoffEstimate', { ...matchedFields, pdf_status: 'pending', pdf_retry_count: 0, source: 'QB Direct Sync' });
          stats.imported++;
          leads.push(matchedLead);
          const amtStr = totalAmt > 0 ? ` — $${Number(totalAmt).toLocaleString('en-US', { minimumFractionDigits: 0 })}` : '';
          await b44.create('Activity', {
            lead_id: matchedLead.id,
            type: 'note',
            timestamp: new Date().toISOString(),
            content: `📋 QB estimate #${qbNumber}${amtStr} synced automatically. Status: ${status}.`,
            author: 'QB Direct Sync',
            source: 'manual',
          }).catch(() => {});
          if (matchedLead.handoff_estimate_status === 'awaiting_qb') {
            await b44.update('Lead', matchedLead.id, { handoff_estimate_status: 'synced' }).catch(() => {});
          }
        }

        const leadUpdate = {};
        if (qbEst.TxnDate && !matchedLead.appointment_date) leadUpdate.appointment_date = toDateStr(qbEst.TxnDate);
        if (qbEst.TxnDate && !matchedLead.follow_up_date) leadUpdate.follow_up_date = toDateStr(qbEst.TxnDate);
        if (Object.keys(leadUpdate).length > 0) {
          await b44.update('Lead', matchedLead.id, leadUpdate).catch(() => {});
        }

      } else {
        stats.unmatched++;
        if (existing) {
          if (!isNewer) {
            stats.unchanged++;
          } else {
            await b44.update('HandoffEstimate', existing.id, { ...sharedBase, match_status: 'unmatched', match_method: 'none' });
            stats.updated++;
          }
        } else {
          await b44.create('HandoffEstimate', { ...sharedBase, match_status: 'unmatched', match_method: 'none', pdf_status: 'pending', pdf_retry_count: 0, source: 'QB Direct Sync - Unmatched' });
          stats.imported++;
        }
      }

    } catch (e) {
      console.error(`[qb-sync] Error on estimate ${qbEst.DocNumber}:`, e.message);
      stats.errors.push(`${qbEst.DocNumber}: ${e.message}`);
    }
  }

  // Save cursor (mirrors saveCursor('quickbooks_estimates', ...))
  try {
    const rows = await b44.filter('SyncCursor', { integration: 'quickbooks_estimates' });
    const summary = { fetched: stats.fetched, imported: stats.imported, updated: stats.updated, skipped: stats.skipped, unchanged: stats.unchanged, failed: stats.failed };
    if (rows[0]) await b44.update('SyncCursor', rows[0].id, { last_successful_sync_at: new Date().toISOString(), last_sync_summary: summary });
    else await b44.create('SyncCursor', { integration: 'quickbooks_estimates', last_successful_sync_at: new Date().toISOString(), last_sync_summary: summary });
  } catch (e) {
    console.warn('[qb-sync] cursor save failed:', e.message);
  }

  console.log(`[qb-sync] done — fetched ${stats.fetched} matched ${stats.matched} imported ${stats.imported} updated ${stats.updated} unchanged ${stats.unchanged} unmatched ${stats.unmatched} errors ${stats.errors.length}`);
  return { ok: true, stats };
}

// Ported from base44/functions/fetchEstimatePdfs/entry.ts (batch path).
// Fetches each pending estimate's PDF from QB, marks the record ready, and stores
// the proxy PDF link. No Base44 function invoked — zero Base44 credits.
async function runQbEstimatePdfSync() {
  if (!b44.isConfigured()) throw new Error('BASE44_APP_ID and BASE44_API_KEY not configured on proxy');

  const all = await b44.list('HandoffEstimate', '-created_date', 500, 0);
  const needsPdf = all.filter(e => e.qb_estimate_id && e.pdf_status !== 'ready' && (e.pdf_retry_count || 0) < 5);
  console.log(`[qb-pdf] ${needsPdf.length} estimates need PDF fetch`);

  const results = { success: 0, failed: 0 };
  // Public base for the stored proxy PDF link. Set QB_PROXY_URL on the Railway
  // service to its own public URL (same value as the Base44 secret) for resolvable links.
  const proxyBaseUrl = process.env.QB_PROXY_URL || '';

  for (const estimate of needsPdf) {
    const id = estimate.id;
    const qbId = estimate.qb_estimate_id;
    const qbNumber = estimate.qb_estimate_number;
    try {
      await b44.update('HandoffEstimate', id, { pdf_status: 'syncing' }).catch(() => {});
      const tokens = await getValidTokens();
      const pdfRes = await fetch(`${QB_API_BASE}/${tokens.realm_id}/estimate/${qbId}/pdf?minorversion=65`, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/pdf' },
      });
      if (!pdfRes.ok) {
        const errText = await pdfRes.text().catch(() => '');
        console.warn(`[qb-pdf] PDF fetch failed (${pdfRes.status}) for ${qbNumber}: ${errText.slice(0, 150)}`);
        await b44.update('HandoffEstimate', id, { pdf_status: 'failed', pdf_retry_count: (estimate.pdf_retry_count || 0) + 1 });
        results.failed++;
        continue;
      }
      // Confirm a real PDF came back (consume bytes — UI uses the proxy link, not the bytes)
      await pdfRes.arrayBuffer();
      const pdfUrl = proxyBaseUrl ? `${proxyBaseUrl}/estimates/${qbId}/pdf` : `/estimates/${qbId}/pdf`;
      await b44.update('HandoffEstimate', id, {
        pdf_url: pdfUrl,
        document_url: pdfUrl,
        pdf_status: 'ready',
        pdf_fetched_at: new Date().toISOString(),
        qb_app_url: `https://qbo.intuit.com/app/estimate?txnId=${qbId}`,
        pdf_retry_count: (estimate.pdf_retry_count || 0) + 1,
      });
      results.success++;
    } catch (e) {
      console.error(`[qb-pdf] Error on estimate ${qbNumber}:`, e.message);
      await b44.update('HandoffEstimate', id, { pdf_status: 'failed', pdf_retry_count: (estimate.pdf_retry_count || 0) + 1 }).catch(() => {});
      results.failed++;
    }
  }

  console.log(`[qb-pdf] done — success ${results.success} failed ${results.failed}`);
  return { ok: true, results, processed: needsPdf.length };
}

// Manual triggers (guarded by X-Proxy-Secret, same as all /qb/* routes)
app.post('/sync/qb-estimates', requireProxySecret, async (req, res) => {
  try {
    const result = await runQbEstimateSync();
    return res.json(result);
  } catch (e) {
    if (e.reconnectRequired) return handleQBError(e, res);
    console.error('[qb-sync] fatal:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/sync/qb-estimate-pdfs', requireProxySecret, async (req, res) => {
  try {
    const result = await runQbEstimatePdfSync();
    return res.json(result);
  } catch (e) {
    if (e.reconnectRequired) return handleQBError(e, res);
    console.error('[qb-pdf] fatal:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[proxy] QuickBooks Proxy running on port ${PORT}`);
  console.log(`[proxy] Environment: ${QB_ENVIRONMENT}`);
  console.log(`[proxy] API Base: ${QB_API_BASE}`);

  // ── TEMPORARY DIAGNOSTIC: print all registered routes at startup ──────────
  // This confirms whether the deployed server.js includes the upload endpoints.
  const routes = [];
  (app._router?.stack || []).forEach(layer => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase()).join(',');
      routes.push(`${methods} ${layer.route.path}`);
    }
  });
  console.log(`[proxy] === REGISTERED ROUTES (${routes.length} total) ===`);
  routes.forEach(r => console.log(`[proxy]   ${r}`));
  const apiRoutes = routes.filter(r => r.includes('/api/'));
  console.log(`[proxy] === /api/* routes (${apiRoutes.length}) ===`);
  apiRoutes.forEach(r => console.log(`[proxy]   ${r}`));
  console.log(`[proxy] Upload endpoint registered: ${routes.some(r => r.includes('/api/files/upload')) ? 'YES ✅' : 'NO ❌'}`);
  console.log(`[proxy] Status endpoint registered: ${routes.some(r => r.includes('/api/files/status')) ? 'YES ✅' : 'NO ❌'}`);
  // ── END DIAGNOSTIC ────────────────────────────────────────────────────────

  // ── QB Estimate Sync Cron ─────────────────────────────────────────────────
  // Off by default. Set QB_SYNC_CRON_ENABLED=true on Railway to start the 15-min
  // loop (estimates sync + PDF fetch). Keeps the Base44 scheduler as fallback until
  // parity is verified, then disable the Base44 automation and leave this running.
  let cronLib = null;
  try { cronLib = require('node-cron'); } catch (e) {
    console.warn('[proxy] node-cron not installed — QB sync cron disabled (npm install will add it)');
  }
  if (cronLib) {
    if (process.env.QB_SYNC_CRON_ENABLED !== 'true') {
      console.log('[proxy] QB sync cron disabled (set QB_SYNC_CRON_ENABLED=true to enable every-15-min sync)');
    } else {
      cronLib.schedule('*/15 * * * *', async () => {
        const t = new Date().toISOString();
        console.log(`[qb-cron] tick ${t}`);
        try {
          const r = await runQbEstimateSync();
          console.log(`[qb-cron] sync ok — matched ${r.stats?.matched} imported ${r.stats?.imported} updated ${r.stats?.updated}`);
        } catch (e) {
          console.error('[qb-cron] sync failed:', e.message);
        }
        try {
          await runQbEstimatePdfSync();
        } catch (e) {
          console.error('[qb-cron] pdf sync failed:', e.message);
        }
      });
      console.log('[proxy] QB sync cron scheduled every 15 minutes (QB_SYNC_CRON_ENABLED=true)');
    }
  }
});