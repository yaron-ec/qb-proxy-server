/**
 * Railway API client
 *
 * ⚠️  INTEGRATION POLICY — DO NOT VIOLATE
 * Do NOT use Base44 backend functions here.
 * This integration must use Railway proxy or direct Google API only.
 * See src/lib/integrationPolicy.js for the full policy.
 *
 * ALLOWED:  fetch() to Railway proxy, base44.entities.* (DB only), base44.auth.*
 * FORBIDDEN: base44.functions.invoke(...), base44.functions.*
 *
 * All QB/Handoff/SignNow calls go through the Railway proxy server.
 * The proxy holds QB_PROXY_SECRET — never exposed to the browser.
 * The proxy URL is the canonical VITE_RAILWAY_API_URL (see src/lib/apiConfig.js).
 */

import { RAILWAY_API_URL as PROXY_URL } from '@/lib/apiConfig';
const PROXY_SECRET = import.meta.env.VITE_QB_PROXY_SECRET || '';

/**
 * Make a POST request to the Railway proxy.
 * @param {string} path - e.g. '/qb/lead-status'
 * @param {object} body - JSON payload
 */
export async function railwayRequest(path, body = {}) {
  if (!PROXY_URL) {
    throw new Error(
      'Railway API URL not configured. Set VITE_RAILWAY_API_URL in your environment.'
    );
  }
  const res = await fetch(`${PROXY_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `Proxy error ${res.status}`), { status: res.status, data });
  }
  return data;
}

/**
 * Normalizes integration errors for user-facing display.
 */
export function normalizeIntegrationError(error) {
  const raw = error?.message || String(error || '');

  // Strip HTML responses (Express 404 pages, etc.)
  if (raw.includes('<!DOCTYPE') || raw.includes('<html')) {
    if (raw.includes('Cannot POST') || raw.includes('Cannot GET') || raw.includes('404')) {
      return 'QuickBooks proxy needs redeploy. Please redeploy the Railway proxy and try again.';
    }
    return 'QuickBooks proxy returned an unexpected response. Please try again.';
  }

  // Reconnect required
  if (raw.includes('QUICKBOOKS_RECONNECT_REQUIRED') || raw.includes('reconnectRequired')) {
    return 'QuickBooks connection expired. Reconnect in Settings → Integrations.';
  }

  // Network errors
  if (raw.includes('ENOTFOUND') || raw.includes('fetch failed') || raw.includes('NetworkError') || raw.includes('Cannot reach QB proxy')) {
    return 'Cannot reach QuickBooks proxy. Check connection and try again.';
  }

  // Plan/subscription errors
  if (
    raw.includes('Builder+') ||
    raw.includes('current plan') ||
    raw.includes('backend function') ||
    raw.includes('subscription plan') ||
    raw.includes('upgrade') ||
    raw.includes('402') ||
    error?.status === 402
  ) {
    return 'QuickBooks integration unavailable. Please check QB connection in Settings.';
  }

  // Clean proxy prefix and truncate
  const clean = raw.replace(/^Proxy \d+:\s*/, '').replace(/^QB \d+:\s*/, '');
  if (clean.length > 180) return clean.slice(0, 180) + '…';
  return clean || 'Integration failed. Please try again.';
}

/**
 * Sync QB estimates for a lead via the syncLeadEstimatesFromQB backend function.
 */
export async function syncLeadEstimates(leadId) {
  return railwayRequest('/qb/sync-lead-estimates', { lead_name: leadId });
}

/**
 * Diagnose QB estimate matching for a lead via the syncLeadEstimatesFromQB backend function.
 */
export async function diagnoseLeadEstimates(leadId) {
  return railwayRequest('/qb/diagnose-lead-estimates', { lead_name: leadId });
}

/**
 * Fetch/save PDF for an estimate via the fetchEstimatePdfs backend function.
 */
export async function fetchEstimatePdf(estimateRecordId) {
  return railwayRequest('/qb/fetch-estimate-pdf', { estimate_id: estimateRecordId });
}