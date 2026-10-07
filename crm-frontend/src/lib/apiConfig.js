/**
 * apiConfig — SINGLE canonical API base URL for all Railway API clients.
 *
 * One env var: VITE_RAILWAY_API_URL (set at build time, e.g. in
 * crm-frontend/.env.exit for EC's own production build).
 *
 * All frontend API clients (capture, auth, leads, deals, emails, etc.)
 * import RAILWAY_API_URL from this module. No hardcoded fallback URLs
 * in individual client files.
 *
 * Compatibility aliases (VITE_QB_PROXY_URL, VITE_RAILWAY_CAPTURE_URL) are
 * normalized HERE only — no other file reads them directly.
 *
 * PRODUCTIZATION: this module previously fell back to EC's own live
 * production URL (https://qb-proxy-server-production.up.railway.app) when
 * none of these env vars were set, with a comment attributing this to a
 * since-retired Base44 preview-mode build path. Under the productized
 * single-tenant-per-deployment model that fallback is a genuine
 * cross-company data-leakage risk: a Company #4 frontend built with a
 * misconfigured pipeline (VITE_RAILWAY_API_URL never injected) would
 * silently send/receive data against EC's OWN live production backend
 * instead of its own, rather than failing visibly. EC's own build always
 * sets VITE_RAILWAY_API_URL explicitly (crm-frontend/.env.exit), so removing
 * this fallback has zero effect on EC's actual behavior — it only removes a
 * trap for every other installation. `isApiConfigured()` already existed
 * for exactly this case (see lib/AuthContext.jsx's clean "not configured"
 * error path) but could never actually return false while this fallback
 * existed; it is now a real, working safety net instead of dead code.
 */

const _url = import.meta.env.VITE_RAILWAY_API_URL
  || import.meta.env.VITE_QB_PROXY_URL
  || import.meta.env.VITE_RAILWAY_CAPTURE_URL
  || null;

export const RAILWAY_API_URL = _url;

export function getApiUrl() {
  return RAILWAY_API_URL;
}

export function isApiConfigured() {
  return !!RAILWAY_API_URL;
}