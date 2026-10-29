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
  // existing email infrastructure (the same path lib/captureAlerts.js itself
  // uses — notificationRecipients.getAllStaffRecipients() narrowed by
  // notificationPreferences.filterRecipientsForCategory(), never a bespoke
  // recipient list), is idempotent per credential per day, and is best-effort
  // (never throws — a failure here must never break the refresh/revocation
  // path that triggered it).
  //
  // October 2026 production defect (found during the QuickBooks reliability
  // audit, fixed here): this previously destructured a nonexistent
  // `ALERT_RECIPIENTS` export off lib/captureAlerts.js (that module only ever
  // exported `sendNewLeadAlert` — see its own module.exports). The resulting
  // TypeError was silently swallowed by this function's own try/catch, so a
  // genuine QuickBooks reconnect-required condition has likely NEVER actually
  // sent this email in production — the only visible symptom was the
  // `[qb-token] reconnect alert unavailable` warning in server logs, with no
  // admin-facing signal at all beyond the (separate, UI-only)
  // QBReconnectBanner.jsx / System Health card. Fixed by resolving recipients
  // the same way captureAlerts.js does, and pointing the link at
  // `/integrations` specifically (via lib/crmUrl.js, never a raw env var)
  // rather than a bare CRM base URL, since that's the exact screen with the
  // Reconnect action (CLAUDE.md: "admins also see a CRM banner linking to
  // /integrations"). Regression coverage: test/qbTokenManager.test.js's
  // "notifyReconnectRequired" suite exercises this real implementation
  // (unstubbed) for the first time — every other qbTokenManager test stubs
  // the whole function via _setDeps and so never caught this.
  notifyReconnectRequired: async (environment, realmId, reason) => {
    try {
      const emailService = require('./emailService');
      const notificationRecipients = require('./notificationRecipients');
      const notificationPreferences = require('./notificationPreferences');
      const day = new Date().toISOString().slice(0, 10);
      const crm = require('./crmUrl').getCrmBaseUrl();
      const integrationsUrl = `${crm}/integrations`;
      const staffRecipients = await notificationRecipients.getAllStaffRecipients();
      const alertRecipients = await notificationPreferences.filterRecipientsForCategory(
        staffRecipients, notificationPreferences.CATEGORIES.SYSTEM_FAILURE
      );
      for (const to of alertRecipients) {
        await emailService.send({
          to,
          subject: 'Action required: reconnect QuickBooks in the CRM',
          htmlBody: `<p>QuickBooks (${environment}) authorization was revoked or expired at Intuit, so QuickBooks sync is paused.</p>`
            + `<p>An admin must reconnect it: CRM → Settings → Integrations → QuickBooks → Connect (<a href="${integrationsUrl}">${integrationsUrl}</a>).</p>`
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

// Bounded retry-with-backoff for a TRANSIENT data-call failure (429 rate-limit
// or 5xx) — October 2026 production finding: the QB Inbound Reconciliation
// cron's 100-customer sequential loop (lib/qbInboundSync.js, ~2+ QB API calls
// per customer, no pacing at all between them) burst past Intuit's rate limit
// and reported "total=100 synced=0 failed=100" — every call after the first
// 429 failed immediately, since qbApiRequest previously had NO retry/backoff
// for anything other than a 401 (the token-refresh endpoint's OWN 3-attempt
// backoff in callIntuit/REFRESH_ATTEMPTS never applied here — a completely
// separate HTTP endpoint). This mirrors that same, already-reviewed
// attempts/backoff shape for consistency, applied to ordinary QuickBooks data
// calls instead. A 429 with a `Retry-After` header is honored (capped, so a
// misbehaving/huge value from Intuit can never stall a cron tick) in
// preference to the fixed backoff schedule.
const DATA_CALL_RETRY_ATTEMPTS = 3;
const DATA_CALL_BACKOFF_MS = [500, 1500];
const DATA_CALL_MAX_RETRY_AFTER_MS = 5000;

function retryAfterMs(res) {
  const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, DATA_CALL_MAX_RETRY_AFTER_MS);
}

/**
 * The ONE authenticated QuickBooks API request helper. Uses a valid (auto-
 * refreshed) access token; on a 401 it forces one canonical refresh (skipped if
 * another caller already replaced the rejected token) and retries the original
 * request exactly once — never more than once, independent of the transient
 * retry budget below. A 429/5xx gets a bounded retry with backoff (see
 * DATA_CALL_RETRY_ATTEMPTS above) before being returned as a failure — this
 * applies uniformly to every QuickBooks data call (server.js qbFetch, the PDF
 * routes, qbInboundSync.qbQuery, qbSyncTrigger, qbEstimateInvoice), since this
 * is the ONE place such a call is made. Records last_used_at on success. Never
 * retries forever on either axis.
 *   buildUrl(tokens) → absolute URL (needs tokens.realm_id)
 *   init.raw: return { res } with the body unread (binary PDFs)
 * Returns { res, text, json }. Throws ReconnectRequiredError when re-consent is required.
 */
async function qbApiRequest(environment, buildUrl, init = {}, { requireConnected = true } = {}) {
  let tokens = await getValidTokens(environment, { requireConnected });
  if (!tokens) return null;
  let usedRefresh = false;
  let transientAttempt = 1;
  while (true) {
    const { raw: _raw, ...fetchInit } = init;
    const res = await deps.fetch(buildUrl(tokens), {
      ...fetchInit,
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(30000),
    });

    if (res.status === 401 && !usedRefresh) {
      usedRefresh = true;
      console.warn('[qb-token] QuickBooks API 401 — canonical refresh, retrying the request once');
      tokens = await getValidTokens(environment, { force: true, staleAccessToken: tokens.access_token });
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && transientAttempt < DATA_CALL_RETRY_ATTEMPTS) {
      const delay = retryAfterMs(res) ?? DATA_CALL_BACKOFF_MS[transientAttempt - 1];
      console.warn(`[qb-token] QuickBooks API ${res.status} — transient, retry ${transientAttempt}/${DATA_CALL_RETRY_ATTEMPTS - 1} (${delay}ms)`);
      transientAttempt++;
      await deps.sleep(delay);
      continue;
    }

    if (init.raw && res.status !== 401) {
      // Binary (PDF) responses: hand back the unread response.
      if (res.ok) { try { await tokenStore.markUsed(environment, tokens.realm_id); } catch (_) { /* best-effort */ } }
      return { res, realmId: tokens.realm_id };
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    if (res.ok) { try { await tokenStore.markUsed(environment, tokens.realm_id); } catch (_) { /* best-effort */ } }
    return { res, text, json, realmId: tokens.realm_id };
  }
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
