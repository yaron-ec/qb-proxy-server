/* eslint-disable no-undef */
/**
 * integrationCredentialStore.js — reusable encrypted credential-management layer.
 *
 * Generic persistence for OAuth tokens / API credentials of every external
 * integration the proxy talks to (QuickBooks now; Gmail, Google Calendar,
 * Google Contacts, SignNow, Handoff, Microsoft 365, Slack, Dropbox, and
 * future integrations later). It holds NO integration-specific business logic.
 *
 * Table: integration_credentials — one logical credential per
 *   (provider, credential_type, environment, account_identifier).
 *
 * Non-secret operational columns (visible without decryption):
 *   provider, credential_type, environment, account_identifier, display_name,
 *   status, expires_at, key_version, connected_at, refreshed_at, last_used_at,
 *   last_error_at, created_at, updated_at.
 * Secret column: encrypted_payload (AES-256-CBC of the full JSON payload with
 *   ENCRYPTION_KEY, format: "version:iv:cipher"). Plaintext secrets are NEVER
 *   stored in any other column. `last_error_message` is a short sanitized
 *   operational message (max 255 chars) — it MUST NEVER contain tokens, codes,
 *   bodies, client secrets, keys, or stack traces.
 *
 * ── Encryption key versioning ──────────────────────────────────────────────
 * CURRENT_KEY_VERSION is the only version today (1, derived from ENCRYPTION_KEY
 * via scrypt). The version is stored BOTH as the `key_version` column (queryable)
 * AND embedded in the encrypted blob (self-describing). On load, the stored
 * key_version is checked against KNOWN_KEY_VERSIONS; unknown versions are
 * rejected with a clear error — never silently guessed. To introduce version 2
 * later, register it in KNOWN_KEY_VERSIONS and add a key-derivation branch in
 * keyForVersion — NO schema change required (the column already exists).
 *
 * `provider`, `credential_type`, `environment`, `status` are free-form TEXT
 * validated here at the application layer (no DB enums) — adding a new
 * provider or credential_type requires NO schema migration.
 *
 * Storage selection:
 *   - DATABASE_URL set            -> Postgres (production / any DB-backed env)
 *   - no DATABASE_URL, not prod   -> dev filesystem (.integration-credentials.dev.json)
 *   - no DATABASE_URL, prod       -> REFUSE writes (throw); reads return null.
 * The dev filesystem format stores the SAME metadata fields + encrypted payload
 * as Postgres (no behavioral difference).
 *
 * "Active" = status = 'connected'. loadActiveCredential returns the single
 * connected record for (provider, credential_type, environment), returns null
 * if none, and REFUSES (throws) if more than one exists — it never picks an
 * arbitrary record.
 *
 * Lifecycle helpers:
 *   markCredentialUsed(...)  -> updates last_used_at; never touches
 *                               connected_at / refreshed_at / created_at.
 *   markCredentialError(...) -> updates last_error_at + last_error_message
 *                               (sanitized, truncated to 255); never changes
 *                               status and never stores secrets.
 *
 * Schema is applied by `npm run migrate`
 * (db/migrations/2026-07-integration-credentials.sql), NOT at server startup.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/client');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const DEV_FILE = path.join(__dirname, '..', '.integration-credentials.dev.json');
const ALLOWED_STATUSES = ['connected', 'disconnected', 'expired', 'revoked', 'error'];

// ── Encryption key versioning ────────────────────────────────────────────────
const CURRENT_KEY_VERSION = 1;
const KNOWN_KEY_VERSIONS = new Set([1]);

function assertKnownKeyVersion(v) {
  if (!KNOWN_KEY_VERSIONS.has(Number(v))) {
    throw new Error('Unknown encryption key version: ' + v + '. Known versions: ' + Array.from(KNOWN_KEY_VERSIONS).sort().join(', '));
  }
}

// ── Encryption (AES-256-CBC, format "version:iv:cipher" hex) ──────────────────
function assertKey() {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not configured — cannot encrypt integration credentials');
}

// Derive the 32-byte key for a given version. Version 1 derives from ENCRYPTION_KEY
// via scrypt. Future versions can use a separate env var (e.g. ENCRYPTION_KEY_V2).
function keyForVersion(keyVersion) {
  assertKey();
  // Version 1: scrypt(ENCRYPTION_KEY, 'salt', 32)
  return crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
}

function encryptPayload(obj, keyVersion) {
  const kv = keyVersion === undefined ? CURRENT_KEY_VERSION : keyVersion;
  assertKnownKeyVersion(kv);
  const key = keyForVersion(kv);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return kv + ':' + iv.toString('hex') + ':' + encrypted;
}

function decryptPayload(encrypted, keyVersion) {
  const kv = keyVersion === undefined ? CURRENT_KEY_VERSION : keyVersion;
  assertKnownKeyVersion(kv);
  const key = keyForVersion(kv);
  const parts = String(encrypted).split(':');
  if (parts.length < 3) throw new Error('Malformed encrypted payload (expected version:iv:cipher)');
  const embeddedVersion = parseInt(parts[0], 10);
  if (Number.isNaN(embeddedVersion) || embeddedVersion !== kv) {
    throw new Error('Encryption key version mismatch: blob version ' + parts[0] + ' does not match expected ' + kv);
  }
  const ivHex = parts[1];
  const cipherHex = parts.slice(2).join(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// ── Storage selection ──────────────────────────────────────────────────────────
function canUseFilesystemFallback() {
  return !process.env.DATABASE_URL && process.env.NODE_ENV !== 'production';
}

function backend() {
  if (process.env.DATABASE_URL) return 'pg';
  if (canUseFilesystemFallback()) return 'dev';
  return 'none';
}

function assertWritableBackend() {
  if (backend() === 'none') {
    throw new Error('Cannot persist integration credentials: no DATABASE_URL and NODE_ENV=production (filesystem-only storage refused)');
  }
}

// ── Validation (application-level; no DB enums) ───────────────────────────────
function validateKey({ provider, credentialType, environment, accountIdentifier }) {
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('provider is required (non-empty string)');
  if (typeof credentialType !== 'string' || !credentialType.trim()) throw new Error('credentialType is required (non-empty string)');
  if (typeof environment !== 'string' || !environment.trim()) throw new Error('environment is required (non-empty string)');
  if (typeof accountIdentifier !== 'string' || !accountIdentifier.trim()) throw new Error('accountIdentifier is required (non-empty string)');
}

function validateServiceEnv({ provider, credentialType, environment }) {
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('provider is required (non-empty string)');
  if (typeof credentialType !== 'string' || !credentialType.trim()) throw new Error('credentialType is required (non-empty string)');
  if (typeof environment !== 'string' || !environment.trim()) throw new Error('environment is required (non-empty string)');
}

function validateStatus(status) {
  if (typeof status !== 'string' || !ALLOWED_STATUSES.includes(status)) {
    throw new Error('status must be one of ' + ALLOWED_STATUSES.join(', ') + ' (got: ' + String(status) + ')');
  }
}

function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be a JSON object');
  }
}

// Sanitize an operational error message before storage. Flattens to a single
// line (no stack traces), collapses whitespace, and truncates to 255 chars.
// The caller is responsible for NOT passing tokens/codes/secrets/bodies; this
// helper enforces length + shape but cannot detect arbitrary secret strings.
function sanitizeErrorMessage(msg) {
  if (msg === null || msg === undefined) return null;
  let s = String(msg);
  s = s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 255) s = s.slice(0, 255);
  return s || null;
}

const toIso = (v) => (v instanceof Date ? v.toISOString() : (v || null));

// ── Postgres backend ───────────────────────────────────────────────────────────
async function pgSave(args) {
  const { provider, credentialType, environment, accountIdentifier, displayName, status, expiresAt, payload, connectedAt, refreshedAt, keyVersion } = args;
  const kv = keyVersion === undefined ? CURRENT_KEY_VERSION : keyVersion;
  assertKnownKeyVersion(kv);
  const enc = encryptPayload(payload, kv);
  // last_used_at / last_error_at / last_error_message are intentionally NOT in
  // the ON CONFLICT SET list — they are operational metadata preserved across
  // refresh / re-save (reconnect) and only changed by markCredentialUsed/Error.
  await db.query(
    `INSERT INTO integration_credentials
       (provider, credential_type, environment, account_identifier, display_name, status, expires_at,
        encrypted_payload, key_version, connected_at, refreshed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (provider, credential_type, environment, account_identifier) DO UPDATE SET
       display_name      = COALESCE(EXCLUDED.display_name, integration_credentials.display_name),
       status            = EXCLUDED.status,
       expires_at        = EXCLUDED.expires_at,
       encrypted_payload = EXCLUDED.encrypted_payload,
       key_version       = EXCLUDED.key_version,
       connected_at      = COALESCE(integration_credentials.connected_at, EXCLUDED.connected_at),
       refreshed_at      = EXCLUDED.refreshed_at,
       updated_at        = NOW()`,
    [provider, credentialType, environment, accountIdentifier, displayName || null, status, expiresAt || null,
     enc, kv, connectedAt || new Date().toISOString(), refreshedAt || null]
  );
}

function pgRowToObj(row) {
  return {
    id: row.id,
    provider: row.provider,
    credentialType: row.credential_type,
    environment: row.environment,
    accountIdentifier: row.account_identifier,
    displayName: row.display_name || null,
    status: row.status,
    expiresAt: toIso(row.expires_at),
    keyVersion: row.key_version,
    payload: decryptPayload(row.encrypted_payload, row.key_version),
    connectedAt: toIso(row.connected_at),
    refreshedAt: toIso(row.refreshed_at),
    lastUsedAt: toIso(row.last_used_at),
    lastErrorAt: toIso(row.last_error_at),
    lastErrorMessage: row.last_error_message || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function pgLoad(args) {
  const r = await db.query(
    'SELECT * FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4',
    [args.provider, args.credentialType, args.environment, args.accountIdentifier]
  );
  return r.rows.length ? pgRowToObj(r.rows[0]) : null;
}

async function pgLoadActive({ provider, credentialType, environment }) {
  const r = await db.query(
    'SELECT * FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND status=$4 ORDER BY updated_at DESC',
    [provider, credentialType, environment, 'connected']
  );
  if (r.rows.length === 0) return null;
  if (r.rows.length > 1) {
    throw new Error(
      'Multiple connected credentials exist for provider="' + provider + '" credentialType="' + credentialType + '" environment="' + environment + '" (' + r.rows.length + ' rows). ' +
      'Refusing to pick an arbitrary record — remove duplicates or specify account_identifier.'
    );
  }
  return pgRowToObj(r.rows[0]);
}

async function pgDelete(args) {
  await db.query(
    'DELETE FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4',
    [args.provider, args.credentialType, args.environment, args.accountIdentifier]
  );
}

async function pgDeleteAll({ provider, credentialType, environment }) {
  await db.query(
    'DELETE FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3',
    [provider, credentialType, environment]
  );
}

async function pgHas(args) {
  const r = await db.query(
    'SELECT 1 FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4',
    [args.provider, args.credentialType, args.environment, args.accountIdentifier]
  );
  return r.rows.length > 0;
}

async function pgCount({ provider, credentialType, environment, status }) {
  if (status) {
    const r = await db.query(
      'SELECT COUNT(*)::int AS n FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND status=$4',
      [provider, credentialType, environment, status]
    );
    return r.rows[0].n;
  }
  const r = await db.query(
    'SELECT COUNT(*)::int AS n FROM integration_credentials WHERE provider=$1 AND credential_type=$2 AND environment=$3',
    [provider, credentialType, environment]
  );
  return r.rows[0].n;
}

async function pgUpdateStatus(args) {
  await db.query(
    'UPDATE integration_credentials SET status=$5, updated_at=NOW() WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4',
    [args.provider, args.credentialType, args.environment, args.accountIdentifier, args.status]
  );
}

// last_used_at: updated on every successful authenticated integration request.
// Never modifies connected_at / refreshed_at / created_at.
async function pgMarkUsed(args) {
  await db.query(
    'UPDATE integration_credentials SET last_used_at = NOW(), updated_at = NOW() WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4',
    [args.provider, args.credentialType, args.environment, args.accountIdentifier]
  );
}

// last_error_at + last_error_message: records an operational failure. Sanitizes
// and truncates the message. Never changes status (the caller decides whether
// to also call updateCredentialStatus, e.g. status='revoked' on auth revoked).
async function pgMarkError(args) {
  await db.query(
    'UPDATE integration_credentials SET last_error_at = NOW(), last_error_message = $5, updated_at = NOW() WHERE provider=$1 AND credential_type=$2 AND environment=$3 AND account_identifier=$4',
    [args.provider, args.credentialType, args.environment, args.accountIdentifier, sanitizeErrorMessage(args.message)]
  );
}

// ── Dev filesystem backend (same metadata + encrypted payload as Postgres) ────
// Map key is JSON.stringify([provider, credentialType, environment, accountIdentifier])
// so any character is safe; each row also carries its own fields for filtering.
function devRead() {
  try {
    if (fs.existsSync(DEV_FILE)) return JSON.parse(fs.readFileSync(DEV_FILE, 'utf8'));
  } catch (e) {
    console.error('[credentialStore] dev file load failed:', e.message);
  }
  return {};
}

function devWrite(map) {
  fs.writeFileSync(DEV_FILE, JSON.stringify(map, null, 2), 'utf8');
}

function devKey(args) {
  return JSON.stringify([args.provider, args.credentialType, args.environment, args.accountIdentifier]);
}

function devRowToObj(row) {
  return {
    id: row.provider + ':' + row.credentialType + ':' + row.environment + ':' + row.accountIdentifier,
    provider: row.provider,
    credentialType: row.credentialType,
    environment: row.environment,
    accountIdentifier: row.accountIdentifier,
    displayName: row.displayName || null,
    status: row.status,
    expiresAt: row.expiresAt || null,
    keyVersion: row.keyVersion,
    payload: decryptPayload(row.encryptedPayload, row.keyVersion),
    connectedAt: row.connectedAt || null,
    refreshedAt: row.refreshedAt || null,
    lastUsedAt: row.lastUsedAt || null,
    lastErrorAt: row.lastErrorAt || null,
    lastErrorMessage: row.lastErrorMessage || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function devSave(args) {
  const map = devRead();
  const k = devKey(args);
  const existing = map[k] || {};
  const kv = args.keyVersion === undefined ? CURRENT_KEY_VERSION : args.keyVersion;
  assertKnownKeyVersion(kv);
  map[k] = {
    provider: args.provider,
    credentialType: args.credentialType,
    environment: args.environment,
    accountIdentifier: args.accountIdentifier,
    displayName: args.displayName || existing.displayName || null,
    status: args.status,
    expiresAt: args.expiresAt || null,
    encryptedPayload: encryptPayload(args.payload, kv),
    keyVersion: kv,
    connectedAt: existing.connectedAt || args.connectedAt || new Date().toISOString(),
    refreshedAt: args.refreshedAt || null,
    // Operational metadata is preserved across refresh / re-save (reconnect);
    // only markCredentialUsed/Error change these.
    lastUsedAt: existing.lastUsedAt || null,
    lastErrorAt: existing.lastErrorAt || null,
    lastErrorMessage: existing.lastErrorMessage || null,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  devWrite(map);
  console.warn('[credentialStore] DEV FALLBACK: credential written to filesystem (.integration-credentials.dev.json) — NOT persistent in production.');
}

function devLoad(args) {
  const map = devRead();
  const row = map[devKey(args)];
  return row ? devRowToObj(row) : null;
}

function devLoadActive({ provider, credentialType, environment }) {
  const map = devRead();
  const matches = Object.values(map).filter((row) =>
    row.provider === provider && row.credentialType === credentialType && row.environment === environment && row.status === 'connected'
  ).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      'Multiple connected credentials exist for provider="' + provider + '" credentialType="' + credentialType + '" environment="' + environment + '" (' + matches.length + ' rows). ' +
      'Refusing to pick an arbitrary record — remove duplicates or specify account_identifier.'
    );
  }
  return devRowToObj(matches[0]);
}

function devDelete(args) {
  const map = devRead();
  delete map[devKey(args)];
  devWrite(map);
}

function devDeleteAll({ provider, credentialType, environment }) {
  const map = devRead();
  for (const k of Object.keys(map)) {
    const row = map[k];
    if (row && row.provider === provider && row.credentialType === credentialType && row.environment === environment) delete map[k];
  }
  devWrite(map);
}

function devHas(args) {
  return !!devRead()[devKey(args)];
}

function devCount({ provider, credentialType, environment, status }) {
  return Object.values(devRead()).filter((row) =>
    row.provider === provider && row.credentialType === credentialType && row.environment === environment && (!status || row.status === status)
  ).length;
}

function devUpdateStatus(args) {
  const map = devRead();
  const k = devKey(args);
  if (map[k]) {
    map[k].status = args.status;
    map[k].updatedAt = new Date().toISOString();
    devWrite(map);
  }
}

function devMarkUsed(args) {
  const map = devRead();
  const k = devKey(args);
  if (map[k]) {
    map[k].lastUsedAt = new Date().toISOString();
    map[k].updatedAt = new Date().toISOString();
    devWrite(map);
  }
}

function devMarkError(args) {
  const map = devRead();
  const k = devKey(args);
  if (map[k]) {
    map[k].lastErrorAt = new Date().toISOString();
    map[k].lastErrorMessage = sanitizeErrorMessage(args.message);
    map[k].updatedAt = new Date().toISOString();
    devWrite(map);
  }
}

// ── Facade ───────────────────────────────────────────────────────────────────
async function saveCredential(args) {
  validateKey(args);
  validateStatus(args.status);
  validatePayload(args.payload);
  assertWritableBackend();
  if (backend() === 'pg') { await pgSave(args); return pgLoad(args); }
  devSave(args);
  return devLoad(args);
}

async function loadCredential(args) {
  validateKey(args);
  if (backend() === 'pg') return pgLoad(args);
  if (backend() === 'dev') return devLoad(args);
  console.warn('[credentialStore] DATABASE_URL not configured — no credentials available in production.');
  return null;
}

async function loadActiveCredential(args) {
  validateServiceEnv(args);
  if (backend() === 'pg') return pgLoadActive(args);
  if (backend() === 'dev') return devLoadActive(args);
  console.warn('[credentialStore] DATABASE_URL not configured — no credentials available in production.');
  return null;
}

async function deleteCredential(args) {
  validateKey(args);
  if (backend() === 'pg') return pgDelete(args);
  if (backend() === 'dev') return devDelete(args);
  // 'none': nothing persisted to delete — no-op.
}

async function deleteCredentials(args) {
  validateServiceEnv(args);
  if (backend() === 'pg') return pgDeleteAll(args);
  if (backend() === 'dev') return devDeleteAll(args);
  // 'none': no-op.
}

async function hasCredential(args) {
  validateKey(args);
  if (backend() === 'pg') return pgHas(args);
  if (backend() === 'dev') return devHas(args);
  return false;
}

async function countCredentials(args) {
  validateServiceEnv(args);
  if (args.status !== undefined) validateStatus(args.status);
  if (backend() === 'pg') return pgCount(args);
  if (backend() === 'dev') return devCount(args);
  return 0;
}

async function updateCredentialStatus(args) {
  validateKey(args);
  validateStatus(args.status);
  if (backend() === 'pg') { await pgUpdateStatus(args); return pgLoad(args); }
  if (backend() === 'dev') { devUpdateStatus(args); return devLoad(args); }
  // 'none': no-op.
  return null;
}

// Record a successful authenticated integration request. Updates last_used_at
// only; never modifies connected_at / refreshed_at / created_at.
async function markCredentialUsed(args) {
  validateKey(args);
  if (backend() === 'pg') { await pgMarkUsed(args); return pgLoad(args); }
  if (backend() === 'dev') { devMarkUsed(args); return devLoad(args); }
  return null;
}

// Record an operational failure. Updates last_error_at + last_error_message
// (sanitized, max 255 chars, no secrets). Never changes status.
async function markCredentialError(args) {
  validateKey(args);
  if (backend() === 'pg') { await pgMarkError(args); return pgLoad(args); }
  if (backend() === 'dev') { devMarkError(args); return devLoad(args); }
  return null;
}

module.exports = {
  ALLOWED_STATUSES,
  CURRENT_KEY_VERSION,
  KNOWN_KEY_VERSIONS,
  encryptPayload,
  decryptPayload,
  canUseFilesystemFallback,
  saveCredential,
  loadCredential,
  loadActiveCredential,
  deleteCredential,
  deleteCredentials,
  hasCredential,
  countCredentials,
  updateCredentialStatus,
  markCredentialUsed,
  markCredentialError,
  DEV_FILE,
};