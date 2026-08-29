/**
 * railway auth — PERMANENT Railway authentication client.
 *
 *   login(email, password)        -> { access, refresh, user }
 *   logout()                        -> clears tokens + revokes refresh
 *   me()                           -> { user }  (requires existing session)
 *   migrateFromBase44(base44Token) -> { access, refresh, user }  [TEMPORARY bridge]
 *
 * migrateFromBase44 is the ONLY Base44-dependent function and is explicitly
 * temporary: it exchanges a Base44 token for a Railway session once per user
 * during the transition. It will be deleted in the final cleanup phase.
 */

import { apiCall, setTokens, clearTokens, getRefreshToken, API_URL } from './client';

export async function login(email, password) {
  const res = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await (async () => {
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j?.error || `Railway API ${res.status}`), { status: res.status, data: j });
    return j;
  })();
  setTokens(data.access, data.refresh);
  return data;
}

export async function logout() {
  try {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: getRefreshToken() }),
    });
  } catch { /* best-effort */ }
  clearTokens();
}

export async function me() { return apiCall('/api/v1/auth/me', { method: 'GET' }); }

// ── Google OAuth SSO — redirect to Railway /api/v1/auth/google ─────────────
// The backend redirects to Google's consent screen. After authentication,
// Google calls back to the Railway backend, which issues a Railway session
// and redirects to the frontend /login with tokens in the URL hash.
// The Login page detects the hash and stores the tokens — no client-side
// token exchange needed.
export function getGoogleLoginUrl(redirectOrigin) {
  const redirect = encodeURIComponent(redirectOrigin || window.location.origin);
  return `${API_URL}/api/v1/auth/google?redirect=${redirect}`;
}

// ── [REMOVED] Base44 → Railway migration bridge ─────────────────────────────
// The /api/v1/auth/migrate endpoint has been removed. Railway auth is now the
// permanent auth layer. This function is retained for backward compatibility
// but will throw a clear error if called (the endpoint returns 404).
// All users must authenticate via /login (Google SSO or email/password).
export async function migrateFromBase44(_base44Token) {
  throw Object.assign(
    new Error('Migration bridge removed. Use login() or Google SSO instead.'),
    { status: 404, code: 'migrate_removed' }
  );
}