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
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  // Admin-visible alert when OAuth re-consent is genuinely required. Reuses the
  // existing email infrastructure (the same path as new-lead alerts), is
  // idempotent per credential per day, and is best-effort (never throws).
  notifyReconnectRequired: async (environment, realmId, reason) => {
    try {
      const emailService = require('./emailService');
      const { ALERT_RECIPIENTS } = require('./captureAlerts');
      const day = new Date().toISOString().slice(0, 10);
      const crm = process.env.CRM_PUBLIC_URL || '';
      for (const to of ALERT_RECIPIENTS) {
        await emailService.send({
          to,
          subject: 'Action required: reconnect QuickBooks in the CRM',
          htmlBody: `<p>QuickBooks (${environment}) authorization was revoked or expired at Intuit, so QuickBooks sync is paused.</p>`
            + `<p>An admin must reconnect it: CRM → Settings → QuickBooks → Connect${crm ? ` (<a href="${crm}">${crm}</a>)` : ''}.</p>`
            + `<p>Reason reported by Intuit: ${String(reason || 'unknown').replace(/[<>&]/g, '')}</p>`,
          idempotencyKey: `qb-reconnect-required:${environment}:${realmId || 'unknown'}:${day}:${to}`,
          role: 'integration-alert',
        }).catch(e => console.warn('[qb-token] reconnect alert email failed (non-fatal):', e.message));
      }
    } catch (e) {
      console.warn('[qb-token] reconnect alert unavailable (non-fatal):', e.message);
    }
  },
};
/** Test seam only. */
function _setDeps(d) { deps = { ...deps, ...d }; }

const inFlight = new Map(); // environment → Promise<tokens>

// Intuit answered but did not issue a token (429 / 5xx): the refresh token was
// not consumed, so a bounded retry with backoff is safe. A network failure is
// NOT retried here — the request may have reached Intuit and rotated the token;
// it surfaces as a transient error and the next call retries under the lock.
const REFRESH_ATTEMPTS = 3;
const REFRESH_BACKOFF_MS = [500, 1500];
const REVOKED_CODES = ['invalid_grant', 'token_revoked', 'AuthenticationFailed'];

async function callIntuit(tokens, environment) {
  for (let attempt = 1; ; attempt++) {
    const res = await postRefresh(tokens);
    if ((res.status === 429 || res.status >= 500) && attempt < REFRESH_ATTEMPTS) {
      console.warn(`[qb-token] Intuit token endpoint ${res.status} — transient, retry ${attempt}/${REFRESH_ATTEMPTS - 1}`);
      await deps.sleep(REFRESH_BACKOFF_MS[attempt - 1]);
      continue;
    }
    return interpretRefresh(res, tokens, environment);
  }
}

async function postRefresh(tokens) {
  const creds = Buffer.from(`${deps.clientId()}:${deps.clientSecret()}`).toString('base64');
  return deps.fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
    signal: AbortSignal.timeout(20000),
  });
}

async function interpretRefresh(res, tokens, environment) {
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok) {
    const code = data.error || `http_${res.status}`;
    const desc = data.error_description || code;
    if (res.status < 500 && res.status !== 429 && REVOKED_CODES.includes(code)) {
      // Genuine revocation: Intuit refused the refresh token itself. Only an
      // admin OAuth re-consent can fix this — never any stored-credential login.
      console.error(`[qb-token] refresh token invalid/revoked (${code}) — reconnect required`);
      try { await tokenStore.markError(environment, tokens.realm_id, `Reconnect required: ${code}`); } catch (_) { /* best-effort */ }
      try { await tokenStore.markRevoked(environment); } catch (_) { /* best-effort */ }
      await deps.notifyReconnectRequired(environment, tokens.realm_id, code);
      throw new ReconnectRequiredError(`Refresh failed: ${desc}`);
    }
    // Anything else (429/5xx after retries, invalid_client config, unexpected
    // 4xx) is recorded but NEVER marks the credential revoked: the refresh
    // token is still usable once the cause clears.
    try { await tokenStore.markError(environment, tokens.realm_id, `Refresh failed: ${code}`); } catch (_) { /* best-effort */ }
    throw Object.assign(new Error(`Token refresh failed: ${desc}`), { transient: true, status: res.status });
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
      // Compare-and-swap: persist only if the credential we refreshed is still
      // the stored one. A reconnect/disconnect that bypassed the lock must never
      // be overwritten by this (older) refresh result.
      const latest = await tokenStore.loadPersistedTokens(environment);
      if (!latest || latest.refresh_token !== current.refresh_token) {
        console.warn('[qb-token] credential changed during refresh — keeping the newer stored credential');
        if (!latest) throw new ReconnectRequiredError('QuickBooks was disconnected during refresh');
        return latest;
      }
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

/**
 * Persist a credential from the OAuth authorization-code exchange (reconnect)
 * under the SAME advisory lock as refresh, so a refresh in flight can never
 * interleave with (or overwrite) a fresh authorization.
 */
async function saveAuthorizedTokens(environment, tokens) {
  const client = await deps.pool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [REFRESH_LOCK_KEY]);
    try {
      await tokenStore.savePersistedTokens(environment, tokens);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [REFRESH_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/**
 * The ONE authenticated QuickBooks API request helper. Uses a valid (auto-
 * refreshed) access token; on a 401 it forces one canonical refresh (skipped if
 * another caller already replaced the rejected token) and retries the original
 * request exactly once. Records last_used_at on success. Never retries forever.
 *   buildUrl(tokens) → absolute URL (needs tokens.realm_id)
 *   init.raw: return { res } with the body unread (binary PDFs)
 * Returns { res, text, json }. Throws ReconnectRequiredError when re-consent is required.
 */
async function qbApiRequest(environment, buildUrl, init = {}, { requireConnected = true } = {}) {
  let tokens = await getValidTokens(environment, { requireConnected });
  if (!tokens) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { raw: _raw, ...fetchInit } = init;
    const res = await deps.fetch(buildUrl(tokens), {
      ...fetchInit,
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(30000),
    });
    if (init.raw && res.status !== 401) {
      // Binary (PDF) responses: hand back the unread response.
      if (res.ok) { try { await tokenStore.markUsed(environment, tokens.realm_id); } catch (_) { /* best-effort */ } }
      return { res, realmId: tokens.realm_id };
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    if (res.status === 401 && attempt === 1) {
      console.warn('[qb-token] QuickBooks API 401 — canonical refresh, retrying the request once');
      tokens = await getValidTokens(environment, { force: true, staleAccessToken: tokens.access_token });
      continue;
    }
    if (res.ok) { try { await tokenStore.markUsed(environment, tokens.realm_id); } catch (_) { /* best-effort */ } }
    return { res, text, json, realmId: tokens.realm_id };
  }
  /* istanbul ignore next */
  throw new Error('unreachable');
}

/**
 * Proof of real authenticated access (not merely a stored token string): a
 * read-only companyinfo request through the canonical path. Never writes
 * accounting data. Returns { ok, status, reconnectRequired, companyNamePresent, checked_at }.
 */
async function verifyConnection(environment, apiBase) {
  const checked_at = new Date().toISOString();
  try {
    const r = await qbApiRequest(environment, (t) => `${apiBase}/${t.realm_id}/companyinfo/${t.realm_id}?minorversion=65`);
    return { ok: r.res.ok, status: r.res.status, reconnectRequired: false,
      companyNamePresent: !!(r.json && r.json.CompanyInfo && r.json.CompanyInfo.CompanyName), checked_at };
  } catch (e) {
    return { ok: false, status: e.status || null, reconnectRequired: !!e.reconnectRequired,
      transient: !!e.transient || !e.reconnectRequired, error: String(e.message || e).slice(0, 160), checked_at };
  }
}

module.exports = {
  getValidTokens, qbApiRequest, verifyConnection, saveAuthorizedTokens,
  ReconnectRequiredError, accessTokenExpired, refreshTokenExpired,
  REFRESH_LOCK_KEY, _setDeps,
};
