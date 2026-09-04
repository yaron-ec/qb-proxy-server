/**
 * railway client — PERMANENT Railway API transport layer.
 *
 * Calls the Railway public API (/api/v1/*) using a Railway JWT access token.
 * NEVER contains or sends: Gmail OAuth, Google tokens, PROXY_SECRET, or any
 * server secret. The browser only ever holds Railway access + refresh tokens.
 *
 * Token storage: access + refresh in localStorage. A 401 triggers a single
 * refresh attempt via /api/v1/auth/refresh; on refresh failure the caller is
 * expected to re-authenticate.
 *
 * This is the canonical transport. src/lib/railwayApi.js re-exports these for
 * backward compatibility with existing importers.
 */

import { RAILWAY_API_URL as API_URL } from '@/lib/apiConfig';

const ACCESS_KEY = 'railway_access_token';
const REFRESH_KEY = 'railway_refresh_token';

function getAccess() { return localStorage.getItem(ACCESS_KEY) || ''; }
function getRefresh() { return localStorage.getItem(REFRESH_KEY) || ''; }

export function setTokens(access, refresh) {
  if (access) localStorage.setItem(ACCESS_KEY, access);
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function isLoggedIn() { return !!getAccess(); }

export function getRefreshToken() { return getRefresh(); }

export function getApiUrl() { return API_URL; }

async function parse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || `Railway API ${res.status}`), { status: res.status, data });
  return data;
}

// Refresh lock: serializes concurrent refresh attempts so that only ONE
// /api/v1/auth/refresh call runs at a time. Without this, when the 15-min
// access token expires, multiple concurrent apiCall instances (Leads page,
// FollowUpReminderPopup 60s poll, Dashboard widgets, etc.) all get 401 at
// once and each calls refreshSession(). The first refresh rotates (revokes)
// the old refresh token and stores the new one. The second refresh sends
// the now-revoked old token, gets 401, and calls clearTokens() — wiping the
// NEW tokens that the first refresh just stored. Subsequent calls then
// find no refresh token → "no refresh token" error on the Leads page.
// The lock ensures all concurrent 401s wait for the single refresh, then
// retry with the new access token.
let _refreshPromise = null;

async function refreshSession() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    const refresh = getRefresh();
    if (!refresh) {
      // Clear stale access token so isLoggedIn() returns false on next boot,
      // forcing the user back to the login page instead of looping.
      clearTokens();
      const err = new Error('no refresh token');
      err.status = 401; // Treat as auth_required (not network_error) so the UI
                        // routes to login instead of showing "Connection problem".
      throw err;
    }
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    const data = await parse(res);
    if (data.access) setTokens(data.access, data.refresh || getRefresh());
    return data;
  })();
  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

/**
 * Authenticated request to /api/v1/*. Auto-refreshes once on 401 or 403.
 * Supports GET/POST/PATCH/PUT/DELETE. Optional AbortSignal via opts.signal.
 *
 * On 401: access token expired — refresh and retry.
 * On 403: authorization failed — the JWT may carry a STALE role from issuance
 *   time. rotateRefreshToken reads the CURRENT canonical role from the
 *   database, so the refreshed JWT carries the correct role. This resolves
 *   the auth split-brain without requiring the user to re-login: if an admin
 *   was recently elevated in the database, the 403 triggers a refresh that
 *   issues a new JWT with role=admin, and the retry succeeds.
 */
export async function apiCall(path, { method = 'POST', body, signal, timeoutMs = 30000 } = {}) {
  if (!API_URL) throw new Error('Railway API URL not configured (VITE_RAILWAY_API_URL).');
  // Auto-timeout: prevents indefinite "Saving..." / loading states if the server
  // is unreachable or slow. Caller-supplied signal takes precedence.
  const controller = signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const abortSignal = signal || (controller ? controller.signal : undefined);
  const doFetch = (token) => fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: abortSignal,
  });

  try {
    let res = await doFetch(getAccess());
    if (res.status === 401) {
      try {
        await refreshSession();
        res = await doFetch(getAccess());
      } catch (e) {
        clearTokens();
        // Ensure the error has a status property so the frontend can distinguish
        // auth failures from server errors. Network errors from fetch don't
        // have a status — assign 401 so the UI shows "Session expired" not
        // "Deal not found" (which masks the real problem).
        if (!e.status) e.status = 401;
        throw e;
      }
    } else if (res.status === 403) {
      // Stale-role recovery: refresh once to get a new JWT with the current
      // canonical role from the database. If the retry also returns 403, the
      // user genuinely lacks access — don't clear tokens (still authenticated).
      try {
        await refreshSession();
        res = await doFetch(getAccess());
      } catch (e) {
        // Refresh failed — keep the original 403 response for the caller.
        // Ensure the error has a status so the UI shows "Access denied" not
        // "Deal not found".
        if (!e.status) e.status = 403;
      }
    }
    if (timer) clearTimeout(timer);
    return parse(res);
  } catch (e) {
    if (timer) clearTimeout(timer);
    // AbortError → timeout: convert to a 503 so the UI shows a clear error
    // instead of hanging forever in a "Saving..." / loading state.
    if (e.name === 'AbortError') {
      const timeoutErr = new Error('Request timed out — please try again');
      timeoutErr.status = 503;
      throw timeoutErr;
    }
    // Network errors from fetch (TypeError) don't have a status property.
    // Assign 503 so the frontend can distinguish "network error" from "not found".
    // Without this, ANY network error shows as "Deal not found" / "Lead not found",
    // masking the real problem (server unreachable, DNS failure, CORS, etc.).
    if (!e.status) e.status = 503;
    throw e;
  }
}

export { API_URL, ACCESS_KEY, REFRESH_KEY };