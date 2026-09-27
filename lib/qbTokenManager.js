/* eslint-disable no-undef */
'use strict';

/**
 * qbTokenManager — the ONE QuickBooks OAuth access-token refresh implementation.
 *
 * Why this exists (production finding): two independent refresh paths ran in
 * the SAME API process on the SAME 15-minute cron minute —
 *   - server.js getValidTokens (estimate sync cron, Lead/QB routes): mutexed,
 *     but kept the tokens IN MEMORY and never re-read the database, and
 *   - lib/qbInboundSync.js getValidTokens (inbound reconciliation cron, the
 *     QB webhook's lib/qbSyncTrigger.js): read the database, refreshed with NO
 *     lock, persisted, and dropped refresh_token_expires_at.
 * Intuit rotates the refresh token. When the inbound path rotated it, server.js
 * kept the stale in-memory pair: /health (which read that copy) reported
 * tokenExpired=true while the database held a fresh token, and server.js's next
 * refresh presented an already-rotated refresh token — the path that ends in
 * invalid_grant → "revoked" → reconnect required.
 *
 * Contract:
 *   - The persisted credential (lib/qbTokenStore → integration_credentials) is
 *     the single source of truth; it is re-read on every call (one SELECT).
 *   - A refresh is single-flight per process AND across processes: a
 *     session-level Postgres advisory lock (not a transaction — no row locks are
 *     held during the Intuit HTTP call), after which the credential is re-read;
 *     if another holder already refreshed, that token is used and Intuit is not
 *     called again.
 *   - Every refresh persists the rotated refresh token AND its new expiry.
 *   - An invalid/revoked refresh token marks the credential revoked and throws
 *     ReconnectRequiredError (reconnectRequired = true). Other failures record a
 *     sanitized error and throw; nothing is ever logged with a token value.
 */

const tokenStore = require('./qbTokenStore');

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REFRESH_LOCK_KEY = 0x51425246; // 'QBRF'
const EARLY_REFRESH_MS = 5 * 60 * 1000;

class ReconnectRequiredError extends Error {
  constructor(reason) {
    super(`QUICKBOOKS_RECONNECT_REQUIRED: ${reason}`);
    this.code = 'QUICKBOOKS_RECONNECT_REQUIRED';
    this.reconnectRequired = true;
  }
}

function accessTokenExpired(tokens, now = Date.now()) {
  if (!tokens || !tokens.expires_at) return true;
  return now >= new Date(tokens.expires_at).getTime() - EARLY_REFRESH_MS;
}

function refreshTokenExpired(tokens, now = Date.now()) {
  if (!tokens || !tokens.refresh_expires_at) return false;
  return now >= new Date(tokens.refresh_expires_at).getTime();
}

let deps = {
  fetch: (...a) => fetch(...a),
  pool: () => require('../db/client').pool,
  clientId: () => process.env.QB_CLIENT_ID,
  clientSecret: () => process.env.QB_CLIENT_SECRET,
};
/** Test seam only. */
function _setDeps(d) { deps = { ...deps, ...d }; }

const inFlight = new Map(); // environment → Promise<tokens>

async function callIntuit(tokens, environment) {
  const creds = Buffer.from(`${deps.clientId()}:${deps.clientSecret()}`).toString('base64');
  const res = await deps.fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok) {
    const code = data.error || `http_${res.status}`;
    const desc = data.error_description || code;
    if (['invalid_grant', 'token_revoked', 'AuthenticationFailed'].includes(code)) {
      console.error(`[qb-token] refresh token invalid/revoked (${code}) — reconnect required`);
      try { await tokenStore.markRevoked(environment); } catch (_) { /* best-effort */ }
      throw new ReconnectRequiredError(`Refresh failed: ${desc}`);
    }
    try { await tokenStore.markError(environment, tokens.realm_id, `Refresh failed: ${code}`); } catch (_) { /* best-effort */ }
    throw new Error(`Token refresh failed: ${desc}`);
  }
  const now = Date.now();
  return {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: new Date(now + (data.expires_in || 3600) * 1000).toISOString(),
    refresh_expires_at: data.x_refresh_token_expires_in
      ? new Date(now + data.x_refresh_token_expires_in * 1000).toISOString()
      : tokens.refresh_expires_at,
    last_refresh_at: new Date(now).toISOString(),
  };
}

async function refreshUnderLock(environment, { force, staleAccessToken }) {
  const client = await deps.pool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [REFRESH_LOCK_KEY]);
    try {
      // Re-read under the lock: another process (or an earlier holder) may
      // already have refreshed — then reuse its token, never rotate twice.
      const current = await tokenStore.loadPersistedTokens(environment);
      if (!current) throw new ReconnectRequiredError('No tokens stored — QB has never been connected');
      const someoneElseRefreshed = force
        ? (staleAccessToken && current.access_token !== staleAccessToken)
        : !accessTokenExpired(current);
      if (someoneElseRefreshed) return current;
      if (!current.refresh_token) throw new ReconnectRequiredError('No refresh token stored');
      if (refreshTokenExpired(current)) throw new ReconnectRequiredError('Refresh token expired');
      const refreshed = await callIntuit(current, environment);
      await tokenStore.savePersistedTokens(environment, refreshed);
      console.log(`[qb-token] access token refreshed — expires ${refreshed.expires_at}`);
      return refreshed;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [REFRESH_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/**
 * Valid tokens for `environment`, refreshing if the access token is expired or
 * within 5 minutes of expiry. Returns null when QuickBooks was never connected
 * and `{ requireConnected: false }` (the inbound-sync contract); otherwise throws
 * ReconnectRequiredError.
 *   force + staleAccessToken: refresh after an API 401 — skipped if the stored
 *   access token already differs from the one that was rejected.
 */
async function getValidTokens(environment, { force = false, staleAccessToken = null, requireConnected = true } = {}) {
  const stored = await tokenStore.loadPersistedTokens(environment);
  if (!stored) {
    if (!requireConnected) return null;
    throw new ReconnectRequiredError('No tokens stored — QB has never been connected');
  }
  if (!force && !accessTokenExpired(stored)) return stored;
  if (force && staleAccessToken && stored.access_token !== staleAccessToken) return stored;
  const key = `${environment}:${force ? 'force' : 'expiry'}`;
  if (!inFlight.has(key)) {
    inFlight.set(key, refreshUnderLock(environment, { force, staleAccessToken })
      .finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

module.exports = {
  getValidTokens, ReconnectRequiredError, accessTokenExpired, refreshTokenExpired,
  REFRESH_LOCK_KEY, _setDeps,
};
