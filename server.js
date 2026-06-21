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
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────

const QB_CLIENT_ID     = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI  = process.env.QB_REDIRECT_URI;
const QB_ENVIRONMENT   = process.env.QB_ENVIRONMENT || 'sandbox';
const PROXY_SECRET     = process.env.PROXY_SECRET;
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const BASE44_REMINDER_URL = process.env.BASE44_REMINDER_URL || '';
const ENCRYPTION_KEY   = process.env.ENCRYPTION_KEY || 'default-key-change-in-production';

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

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const encrypted = fs.readFileSync(TOKEN_FILE, 'utf8');
      return decryptToken(encrypted);
    }
  } catch (e) {
    console.error('[proxy] Failed to load tokens:', e.message);
  }
  return null;
}

function saveTokens(tokens) {
  try {
    const encrypted = encryptToken(tokens);
    fs.writeFileSync(TOKEN_FILE, encrypted, 'utf8');
    console.log('[proxy] Tokens saved to disk');
  } catch (e) {
    console.error('[proxy] Failed to save tokens:', e.message);
  }
}

// Load tokens from disk on startup
let storedTokens = loadTokens();

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireProxySecret(req, res, next) {
  const secret = req.headers['x-proxy-secret'];
  if (!PROXY_SECRET || secret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid X-Proxy-Secret' });
  }
  next();
}

// ── Token helpers ────────────────────────────────────────────────────────────

async function refreshTokenIfNeeded() {
  if (!storedTokens) throw new Error('Not connected to QuickBooks. Call /auth/connect first.');
  const expiresAt = new Date(storedTokens.expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) return storedTokens; // still valid

  console.log('[proxy] Access token expiring, refreshing...');
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
  if (!res.ok) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);

  storedTokens = {
    ...storedTokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || storedTokens.refresh_token,
    expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
    last_refresh_at: new Date().toISOString(),
  };
  saveTokens(storedTokens);
  console.log('[proxy] Token refreshed successfully');
  return storedTokens;
}

async function qbFetch(path, options = {}) {
  const tokens = await refreshTokenIfNeeded();
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
  if (!res.ok) {
    const detail = json?.Fault?.Error?.[0]?.Detail || json?.Fault?.Error?.[0]?.Message || text.slice(0, 300);
    throw Object.assign(new Error(`QB ${res.status}: ${detail}`), { status: res.status, qbError: json });
  }
  return json;
}

async function qbQuery(query) {
  return qbFetch(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
}

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: QB_ENVIRONMENT,
    connected: !!storedTokens,
    realm_id: storedTokens?.realm_id || null,
    token_expires_at: storedTokens?.expires_at || null,
  });
});

// ── Auth routes ──────────────────────────────────────────────────────────────

// GET /auth/connect — returns the Intuit OAuth URL
app.get('/auth/connect', requireProxySecret, (req, res) => {
  if (!QB_CLIENT_ID) return res.status(500).json({ error: 'QB_CLIENT_ID not configured on proxy' });
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    response_type: 'code',
    scope: QB_SCOPES,
    redirect_uri: QB_REDIRECT_URI,
    state: 'qb_oauth',
  });
  res.json({ auth_url: `${QB_AUTH_URL}?${params}`, environment: QB_ENVIRONMENT });
});

// POST /auth/callback — exchange code for tokens (called from your OAuth callback page)
app.post('/auth/callback', requireProxySecret, async (req, res) => {
  const { code, realmId } = req.body;
  if (!code || !realmId) return res.status(400).json({ error: 'Missing code or realmId' });

  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: QB_REDIRECT_URI }).toString(),
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

  saveTokens(storedTokens);
  console.log('[proxy] OAuth complete — realm_id:', realmId, 'env:', QB_ENVIRONMENT);
  res.json({ success: true, realm_id: realmId, environment: QB_ENVIRONMENT });
});

// GET /auth/status — connection status
app.get('/auth/status', requireProxySecret, (req, res) => {
  if (!storedTokens) return res.json({ connected: false });
  const refreshExpired = storedTokens.refresh_expires_at
    ? new Date(storedTokens.refresh_expires_at) < new Date()
    : false;
  res.json({
    connected: !refreshExpired,
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
    const tokens = await refreshTokenIfNeeded();
    const data = await qbFetch(`/companyinfo/${tokens.realm_id}?minorversion=65`);
    res.json({ company: data.CompanyInfo });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
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
    res.status(e.status || 500).json({ error: e.message });
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
    res.status(e.status || 500).json({ error: e.message, qbError: e.qbError });
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

    res.json({ customer });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Estimates ─────────────────────────────────────────────────────────────────

// GET /estimates?since=ISO_DATE&customerId=X   — paginated
app.get('/estimates', requireProxySecret, async (req, res) => {
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
      const qr = await qbQuery(`SELECT * FROM Estimate${whereClause} STARTPOSITION ${pos} MAXRESULTS 1000`);
      const batch = qr?.QueryResponse?.Estimate || [];
      all.push(...batch);
      if (batch.length < 1000) break;
      pos += 1000;
    }
    res.json({ estimates: all, total: all.length, environment: QB_ENVIRONMENT });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
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
    res.status(e.status || 500).json({ error: e.message, qbError: e.qbError });
  }
});

// GET /estimates/:id/pdf
app.get('/estimates/:id/pdf', requireProxySecret, async (req, res) => {
  try {
    const tokens = await refreshTokenIfNeeded();
    const url = `${QB_API_BASE}/${tokens.realm_id}/estimate/${req.params.id}/pdf?minorversion=65`;
    const pdfRes = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/pdf' },
    });
    if (!pdfRes.ok) return res.status(pdfRes.status).json({ error: `PDF fetch failed: ${pdfRes.status}` });
    const buffer = await pdfRes.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /invoices — create invoice
app.post('/invoices', requireProxySecret, async (req, res) => {
  try {
    const data = await qbFetch('/invoice?minorversion=65', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, qbError: e.qbError });
  }
});

// GET /invoices/:id/pdf
app.get('/invoices/:id/pdf', requireProxySecret, async (req, res) => {
  try {
    const tokens = await refreshTokenIfNeeded();
    const url = `${QB_API_BASE}/${tokens.realm_id}/invoice/${req.params.id}/pdf?minorversion=65`;
    const pdfRes = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/pdf' },
    });
    if (!pdfRes.ok) return res.status(pdfRes.status).json({ error: `PDF fetch failed: ${pdfRes.status}` });
    const buffer = await pdfRes.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// ─── Appointment Reminders ────────────────────────────────────────────────────

async function runAppointmentReminders() {
  if (!BASE44_REMINDER_URL) {
    console.log('[reminders] BASE44_REMINDER_URL not configured — skipping');
    return { skipped: true };
  }

  console.log('[reminders] Triggering at', new Date().toISOString());

  const res = await fetch(BASE44_REMINDER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-secret': WORKER_SECRET,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reminder API ${res.status}: ${text.slice(0, 300)}`);
  }

  const result = await res.json();
  console.log('[reminders] Complete:', JSON.stringify(result));
  return result;
}

app.post('/remind', (req, res) => {
  const provided = req.headers['x-worker-secret'] || '';

  if (WORKER_SECRET && provided !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  runAppointmentReminders()
    .then(result => res.json({ success: true, result }))
    .catch(e => {
      console.error('[reminders] Failed:', e.message);
      res.status(500).json({ success: false, error: e.message });
    });
});

// Start reminder cron: first run 60s after boot, then every 30 minutes
setTimeout(() => {
  console.log('[reminders] Cron started — every 30 minutes');

  runAppointmentReminders().catch(e =>
    console.error('[reminders] Initial run failed:', e.message)
  );

  setInterval(() => {
    runAppointmentReminders().catch(e =>
      console.error('[reminders] Cron run failed:', e.message)
    );
  }, 30 * 60 * 1000);
}, 60 * 1000);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[proxy] QuickBooks Proxy running on port ${PORT}`);
  console.log(`[proxy] Environment: ${QB_ENVIRONMENT}`);
  console.log(`[proxy] API Base: ${QB_API_BASE}`);
});
