/**
 * ============================================================
 * CRM INTEGRATION POLICY — READ BEFORE TOUCHING THIS FILE
 * ============================================================
 *
 * FORBIDDEN in all integration/client files:
 *   ✗  base44.functions.invoke(...)
 *   ✗  base44.functions.*  (any method)
 *   ✗  Base44 backend functions for integration calls
 *   ✗  Builder+ / Base44 integration tokens / plan-gated features
 *   ✗  VITE_* secrets (never put secrets in frontend env vars)
 *
 * ALLOWED:
 *   ✓  Google Calendar / Contacts / Gmail → direct Google API (googleapis.com)
 *   ✓  QuickBooks → Railway proxy only (QB_PROXY_URL is server-side only; called via proxy)
 *   ✓  Handoff estimates → QuickBooks/Railway proxy only
 *   ✓  File uploads → Railway proxy only
 *   ✓  base44.entities.*  → database CRUD only (leads, activities, estimates, etc.)
 *   ✓  base44.auth.*      → current user / session only
 *   ✓  base44.connectors.getConnection(...)  → OAuth token for direct Google API calls
 *
 * ARCHITECTURE:
 *   Browser → Railway proxy (HTTPS, secret in proxy env) → QuickBooks API
 *   Browser → Google API directly (OAuth token from connector)
 *   Browser → base44 entities (DB reads/writes only)
 *
 * WHY:
 *   Base44 backend functions are plan-gated (Builder+ required).
 *   Any base44.functions.invoke() call in integration code will silently
 *   fail on lower plans with a 402 error, breaking QB/SignNow/estimates.
 *   Railway proxy has no such limitation and holds secrets server-side.
 *
 * ============================================================
 */

/**
 * Throws at runtime if integration code attempts to use Base44 backend functions.
 * Call this at the top of any integration helper that must never use base44.functions.
 *
 * Example usage:
 *   assertNoBase44Functions('QuickBooks lead status');
 *
 * @param {string} featureName - Human-readable name of the feature/call
 */
export function assertNoBase44Functions(featureName) {
  throw new Error(
    `${featureName}: Base44 backend functions are forbidden for integration calls. ` +
    `Use the Railway proxy or direct Google API only. ` +
    `See src/lib/integrationPolicy.js for the full policy.`
  );
}

/**
 * Validates that a Railway proxy URL is available (set as VITE_QB_PROXY_URL
 * or passed in explicitly). Throws a clear error if missing.
 *
 * @param {string|undefined} proxyUrl
 * @param {string} featureName
 */
export function requireRailwayProxy(proxyUrl, featureName) {
  if (!proxyUrl) {
    throw new Error(
      `${featureName}: Railway proxy URL is not configured. ` +
      `Set VITE_QB_PROXY_URL in your environment or ensure the proxy is reachable. ` +
      `See src/lib/integrationPolicy.js for the full policy.`
    );
  }
}