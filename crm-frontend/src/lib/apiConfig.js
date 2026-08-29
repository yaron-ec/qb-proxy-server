/**
 * apiConfig — SINGLE canonical API base URL for all Railway API clients.
 *
 * One env var: VITE_RAILWAY_API_URL
 * Production:  https://qb-proxy-server-production.up.railway.app
 *
 * All frontend API clients (capture, auth, leads, deals, emails, etc.)
 * import RAILWAY_API_URL from this module. No hardcoded fallback URLs
 * in individual client files.
 *
 * Compatibility aliases (VITE_QB_PROXY_URL, VITE_RAILWAY_CAPTURE_URL) are
 * normalized HERE only — no other file reads them directly.
 */

// Production fallback — the ONE canonical production API URL.
// Used only when env vars are not injected (e.g., Base44 preview without .env
// loading). Env vars always take priority when present.
const PRODUCTION_FALLBACK = 'https://qb-proxy-server-production.up.railway.app';

const _url = import.meta.env.VITE_RAILWAY_API_URL
  || import.meta.env.VITE_QB_PROXY_URL
  || import.meta.env.VITE_RAILWAY_CAPTURE_URL
  || PRODUCTION_FALLBACK;

export const RAILWAY_API_URL = _url;

export function getApiUrl() {
  return RAILWAY_API_URL;
}

export function isApiConfigured() {
  return !!RAILWAY_API_URL;
}