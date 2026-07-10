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

// NOTE: This file is a standalone Node.js server â not a browser or Deno module.
// Run with: node server.js  (requires Node.js 18+)
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const qbMatch = require('./lib/qbMatch');
const b44 = require('./lib/base44');
const app = express();
app.use(express.json());

// ââ Config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ Persistent Token Storage ââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ Auth middleware ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function requireProxySecret(req, res, next) {
  const secret = req.headers['x-proxy-secret'];
  if (!PROXY_SECRET || secret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized â missing or invalid X-Proxy-Secret' });
  }
  next();
}

// ââ Token helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ Health âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: QB_ENVIRONMENT,
    connected: !!storedTokens,
    realm_id: storedTokens?.realm_id || null,
    token_expires_at: storedTokens?.expires_at || null,
  });
});

// ââ Auth routes ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// GET /auth/connect â returns the Intuit OAuth URL
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

// POST /auth/callback â exchange code for tokens (called from your OAuth callback page)
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
  console.log('[proxy] OAuth complete â realm_id:', realmId, 'env:', QB_ENVIRONMENT);
  res.json({ success: true, realm_id: realmId, environment: QB_ENVIRONMENT });
});

// GET /auth/status â connection status
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

// ââ Company Info âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/company', requireProxySecret, async (req, res) => {
  try {
    const tokens = await refreshTokenIfNeeded();
    const data = await qbFetch(`/companyinfo/${tokens.realm_id}?minorversion=65`);
    res.json({ company: data.CompanyInfo });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ââ Customers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// GET /customers?since=ISO_DATE   â paginated fetch of all customers (optional incremental)
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

// POST /customers â create or update a customer
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

// ââ Estimates âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// GET /estimates?since=ISO_DATE&customerId=X   â paginated
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

// POST /estimates â create estimate
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

// ââ Invoices ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// POST /invoices â create invoice
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

// ââ Start âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// âââ Appointment Reminders ââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function runAppointmentReminders() {
  if (!BASE44_REMINDER_URL) {
    console.log('[reminders] BASE44_REMINDER_URL not configured â skipping');
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
  console.log('[reminders] Cron started â every 30 minutes');

  runAppointmentReminders().catch(e =>
    console.error('[reminders] Initial run failed:', e.message)
  );

  setInterval(() => {
    runAppointmentReminders().catch(e =>
      console.error('[reminders] Cron run failed:', e.message)
    );
  }, 30 * 60 * 1000);
}, 60 * 1000);
// ââ File Upload to Cloudflare R2 / S3 âââââââââââââââââââââââââââââââââââââââ
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const S3_PUBLIC_URL = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');

let s3Client = null;
let activeBucket = null;
let activePublicUrl = null;

if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  activeBucket = R2_BUCKET_NAME;
  activePublicUrl = R2_PUBLIC_URL;
  console.log('[upload] Cloudflare R2 configured â bucket:', R2_BUCKET_NAME);
} else if (S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && S3_BUCKET_NAME) {
  s3Client = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });
  activeBucket = S3_BUCKET_NAME;
  activePublicUrl = S3_PUBLIC_URL || `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com`;
  console.log('[upload] AWS S3 configured â bucket:', S3_BUCKET_NAME);
} else {
  console.warn('[upload] No R2/S3 credentials configured â file uploads will be disabled');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
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

app.post('/api/files/upload', requireProxySecret, upload.single('file'), async (req, res) => {
  if (!s3Client) {
    return res.status(503).json({
      success: false,
      error: 'File storage not configured. Set R2_* or S3_* environment variables.',
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'No file provided. Use multipart/form-data with field name "file".',
    });
  }

  try {
    const file = req.file;
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ts = now.getTime();
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `uploads/${year}/${month}/${ts}-${sanitized}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: activeBucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ContentDisposition: `inline; filename="${sanitized}"`,
    }));

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
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get('/api/files/status', requireProxySecret, (req, res) => {
  res.json({
    configured: !!s3Client,
    provider: R2_ACCOUNT_ID ? 'cloudflare_r2' : S3_ACCESS_KEY_ID ? 'aws_s3' : 'none',
    bucket: activeBucket || null,
    publicUrl: activePublicUrl || null,
  });
});

// ââ Manual QB estimate sync âââââââââââââââââââââââââââââââââââââââââââââââ
async function getAllQuickBooksEstimates() {
  const all = [];
  let pos = 1;
  while (true) {
    const qr = await qbQuery(`SELECT * FROM Estimate STARTPOSITION ${pos} MAXRESULTS 1000`);
    const batch = qr?.QueryResponse?.Estimate || [];
    all.push(...batch);
    if (batch.length < 1000) break;
    pos += 1000;
  }
  return all;
}

async function getQuickBooksCustomer(customerRef) {
  if (!customerRef?.value) return null;
  try {
    const data = await qbFetch(`/customer/${customerRef.value}?minorversion=65`);
    return data.Customer || null;
  } catch (e) {
    console.warn('[sync] Unable to fetch QB customer:', e.message);
    return null;
  }
}

async function updateQuickBooksEstimateSyncCursor(syncTime) {
  try {
    const existing = await b44.filter('SyncCursor', { entity: 'qb_estimates' });
    const cursor = Array.isArray(existing) ? existing[0] : null;
    const payload = { entity: 'qb_estimates', last_synced_at: syncTime, updated_at: syncTime };
    if (cursor?.id) {
      await b44.update('SyncCursor', cursor.id, payload);
    } else {
      await b44.create('SyncCursor', payload);
    }
  } catch (e) {
    console.warn('[sync] Unable to update SyncCursor:', e.message);
  }
}

app.get('/qb/health', (req, res) => {
  const refreshExpired = storedTokens?.refresh_expires_at
    ? new Date(storedTokens.refresh_expires_at) < new Date()
    : false;
  res.json({
    status: 'ok',
    environment: QB_ENVIRONMENT,
    connected: !!storedTokens && !refreshExpired,
    realmId: storedTokens?.realm_id || null,
    tokenExpiresAt: storedTokens?.expires_at || null,
    refreshExpiresAt: storedTokens?.refresh_expires_at || null,
    reconnectRequired: !storedTokens || refreshExpired,
  });
});

app.post('/sync/qb-estimates', requireProxySecret, async (req, res) => {
  try {
    if (!b44.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'Base44 is not configured for sync' });
    }

    const estimates = await getAllQuickBooksEstimates();
    const leads = await b44.filter('Lead', {});
    const existingRecords = await b44.filter('HandoffEstimate', {});
    const existingByQbId = new Map((existingRecords || []).filter(Boolean).map(record => [String(record.qb_estimate_id || ''), record]));

    let created = 0;
    let updated = 0;
    let matchedLeads = 0;
    let unmatchedLeads = 0;

    for (const estimate of estimates) {
      const qbEstimateId = estimate.Id || estimate.id;
      if (!qbEstimateId) continue;

      const customer = await getQuickBooksCustomer(estimate.CustomerRef);
      const matchedLead = customer ? qbMatch.findMatchingLead(customer, leads || []) : null;
      if (matchedLead) matchedLeads += 1;
      else unmatchedLeads += 1;

      const payload = {
        qb_estimate_id: String(qbEstimateId),
        qb_customer_id: estimate.CustomerRef?.value || null,
        qb_customer_name: customer?.DisplayName || estimate.CustomerRef?.name || null,
        qb_doc_number: estimate.DocNumber || null,
        qb_total_amount: estimate.TotalAmt || null,
        qb_balance: estimate.Balance || null,
        qb_status: estimate.Balance === 0 ? 'paid' : 'open',
        lead_id: matchedLead?.id || matchedLead?._id || null,
        lead_name: matchedLead ? `${matchedLead.first_name || ''} ${matchedLead.last_name || ''}`.trim() : null,
        lead_email: matchedLead?.email || null,
        lead_phone: matchedLead?.phone || null,
        synced_at: new Date().toISOString(),
        source: 'qb_proxy_sync',
        qb_last_updated_at: estimate.MetaData?.LastUpdatedTime || null,
      };

      const existing = existingByQbId.get(String(qbEstimateId));
      if (existing?.id || existing?._id) {
        await b44.update('HandoffEstimate', existing.id || existing._id, payload);
        updated += 1;
      } else {
        await b44.create('HandoffEstimate', payload);
        created += 1;
      }
    }

    const syncTime = new Date().toISOString();
    await updateQuickBooksEstimateSyncCursor(syncTime);

    res.json({
      ok: true,
      stats: {
        estimatesSeen: estimates.length,
        created,
        updated,
        matchedLeads,
        unmatchedLeads,
        cursorUpdated: true,
        syncedAt: syncTime,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/sync/qb-estimate-pdfs', requireProxySecret, async (req, res) => {
  try {
    if (!b44.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'Base44 is not configured for PDF sync' });
    }

    const records = await b44.filter('HandoffEstimate', {});
    const tokens = await refreshTokenIfNeeded();
    const results = { updated: 0, skipped: 0, failed: 0, errors: [] };

    for (const record of records || []) {
      const recordId = record.id || record._id;
      const qbEstimateId = record.qb_estimate_id;
      if (!recordId || !qbEstimateId) {
        results.skipped += 1;
        continue;
      }

      try {
        const pdfUrl = `${QB_API_BASE}/${tokens.realm_id}/estimate/${qbEstimateId}/pdf?minorversion=65`;
        const pdfRes = await fetch(pdfUrl, {
          headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/pdf' },
        });

        const now = new Date().toISOString();
        if (!pdfRes.ok) {
          await b44.update('HandoffEstimate', recordId, {
            pdf_status: 'error',
            pdf_error: `PDF fetch failed: ${pdfRes.status}`,
            pdf_last_checked_at: now,
          });
          results.failed += 1;
          continue;
        }

        const contentType = pdfRes.headers.get('content-type') || '';
        await b44.update('HandoffEstimate', recordId, {
          pdf_status: contentType.includes('pdf') ? 'available' : 'downloaded',
          pdf_content_type: contentType,
          pdf_error: '',
          pdf_last_checked_at: now,
        });
        results.updated += 1;
      } catch (e) {
        results.failed += 1;
        results.errors.push(e.message);
      }
    }

    res.json({
      ok: true,
      results,
      processed: results.updated + results.failed + results.skipped,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const scopedSync = require('./lib/scopedSync');
scopedSync.register(app, {
  requireProxySecret: requireProxySecret,
  qbQuery: qbQuery,
  refreshTokenIfNeeded: refreshTokenIfNeeded,
  QB_API_BASE: QB_API_BASE,
  QB_ENVIRONMENT: QB_ENVIRONMENT,
  s3Client: s3Client,
  activeBucket: activeBucket,
  activePublicUrl: activePublicUrl,
  getAllQuickBooksEstimates: getAllQuickBooksEstimates,
  getQuickBooksCustomer: getQuickBooksCustomer,
});

// ââ Base44 Config Diagnostic (masked, read-only) ââââââââââââââââââââââââââââââ
// Reports masked env values + self-test so we can confirm Base44 connectivity.
app.post('/diag/base44-config', requireProxySecret, async (req, res) => {
  function mask(v) {
    if (!v) return { present: false };
    const s = String(v);
    return { present: true, length: s.length, preview: s.slice(0, 4) + '...' + s.slice(-4), hasApiBase44Com: s.includes('api.base44.com'), hasBase44App: s.includes('base44.app') };
  }
  const b44 = require('./lib/base44');
  const rawUrl = process.env.BASE44_API_URL || '';
  const effectiveUrl = (!rawUrl || rawUrl.includes('api.base44.com')) ? 'https://base44.app' : rawUrl.replace(/\/$/, '');
  const config = {
    raw_BASE44_API_URL: mask(rawUrl),
    effective_API_URL: effectiveUrl,
    BASE44_APP_ID: mask(process.env.BASE44_APP_ID),
    BASE44_API_KEY: mask(process.env.BASE44_API_KEY),
    PROXY_SECRET: mask(process.env.PROXY_SECRET),
    QB_ENVIRONMENT: process.env.QB_ENVIRONMENT || null,
    QB_SANDBOX: process.env.QB_SANDBOX || null,
    R2_configured: !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID),
    b44_isConfigured: b44.isConfigured(),
  };
  // Self-test: try a lightweight entity read
  try {
    const test = await b44.filter('SyncCursor', {});
    config.selfTest = { ok: true, count: Array.isArray(test) ? test.length : 'unknown', responseType: typeof test };
  } catch (e) {
    config.selfTest = { ok: false, error: (e.message || '').slice(0, 200) };
  }
  res.json(config);
});

// === SDK Auth Diagnostic (read-only, temporary - Phase 3 test) ===
// Tests the official Base44 SDK external-backend auth path.
// Does NOT use asServiceRole. Does NOT create/update/delete.
app.post('/diag/sdk-test', requireProxySecret, async (req, res) => {
  const appId = process.env.BASE44_APP_ID;
  const serverUrl = 'https://base44.app';
  const apiKey = process.env.BASE44_API_KEY || '';
  const adminEmail = process.env.ADMIN_EMAIL || '';
  const testLeadId = '6a24f481aed1c5c0a65a5d66';

  const result = {
    sdkVersion: null,
    clientInitialized: false,
    noAuthRead: null,
    apiKeyAsBearerRead: null,
    loginProbe: null,
    testLeadRead: null,
    classification: null
  };

  try {
    const sdk = await import('@base44/sdk');
    result.sdkVersion = '0.8.37';
    const makeClient = sdk.createClient;

    // Test 1: SDK init + read with NO auth
    try {
      const client = makeClient({ appId, serverUrl, requiresAuth: false });
      result.clientInitialized = true;
      const leads = await client.entities.Lead.list('-created_date', 1);
      result.noAuthRead = { status: 'SUCCESS', count: leads.length };
    } catch (e) {
      result.noAuthRead = {
        status: 'ERROR',
        message: (e.message || '').slice(0, 150),
        httpStatus: e.response?.status || null
      };
    }

    // Test 2: Read with BASE44_API_KEY as Bearer token (current approach)
    try {
      const client = makeClient({ appId, serverUrl, token: apiKey, requiresAuth: false });
      const leads = await client.entities.Lead.list('-created_date', 1);
      result.apiKeyAsBearerRead = { status: 'SUCCESS', count: leads.length };
    } catch (e) {
      result.apiKeyAsBearerRead = {
        status: 'ERROR',
        message: (e.message || '').slice(0, 150),
        httpStatus: e.response?.status || null
      };
    }

    // Test 3: Login endpoint probe (confirms server-side login is viable)
    try {
      const loginRes = await fetch(serverUrl + '/api/apps/' + appId + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminEmail || 'probe@test.invalid', password: 'probe_fake_password_only' })
      });
      const loginBody = await loginRes.text();
      result.loginProbe = {
        status: loginRes.status,
        isCaptchaRequired: loginBody.toLowerCase().includes('captcha') || loginBody.toLowerCase().includes('turnstile'),
        isAuthError: loginBody.toLowerCase().includes('invalid') || loginBody.toLowerCase().includes('incorrect'),
        bodyPreview: loginBody.slice(0, 200)
      };
    } catch (e) {
      result.loginProbe = { status: 'FETCH_ERROR', message: (e.message || '').slice(0, 150) };
    }

    // Test 4: Read the dedicated test lead with no auth (expect 403)
    try {
      const client = makeClient({ appId, serverUrl, requiresAuth: false });
      const lead = await client.entities.Lead.get(testLeadId);
      result.testLeadRead = { status: 'SUCCESS', leadId: lead.id };
    } catch (e) {
      result.testLeadRead = {
        status: 'ERROR',
        message: (e.message || '').slice(0, 150),
        httpStatus: e.response?.status || null
      };
    }

    // Classify
    const noAuthFailed = result.noAuthRead.status === 'ERROR';
    const apiKeyFailed = result.apiKeyAsBearerRead.status === 'ERROR';
    const loginAccessible = result.loginProbe && !result.loginProbe.isCaptchaRequired;
    if (noAuthFailed && apiKeyFailed && loginAccessible) {
      result.classification = 'USER_TOKEN_REQUIRED';
    } else if (!noAuthFailed) {
      result.classification = 'SUPPORTED_AND_WORKING';
    } else if (!apiKeyFailed) {
      result.classification = 'SUPPORTED_AND_WORKING';
    } else {
      result.classification = 'EXTERNAL_ENTITY_ACCESS_NOT_SUPPORTED';
    }
  } catch (e) {
    result.initError = (e.message || '').slice(0, 200);
    result.classification = 'UNDETERMINED';
  }

  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[proxy] QuickBooks Proxy running on port ${PORT}`);
  console.log(`[proxy] Environment: ${QB_ENVIRONMENT}`);
  console.log(`[proxy] API Base: ${QB_API_BASE}`);
});
