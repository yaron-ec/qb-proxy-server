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

async function refreshSession() {
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
}

/**
 * Authenticated request to /api/v1/*. Auto-refreshes once on 401.
 * Supports GET/POST/PATCH/PUT/DELETE. Optional AbortSignal via opts.signal.
 */
export async function apiCall(path, { method = 'POST', body, signal } = {}) {
  if (!API_URL) throw new Error('Railway API URL not configured (VITE_RAILWAY_API_URL).');
  const doFetch = (token) => fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  let res = await doFetch(getAccess());
  if (res.status === 401) {
    try {
      await refreshSession();
      res = await doFetch(getAccess());
    } catch (e) {
      clearTokens();
      throw e;
    }
  }
  return parse(res);
}

export { API_URL, ACCESS_KEY, REFRESH_KEY };