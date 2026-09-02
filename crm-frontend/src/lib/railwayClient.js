/**
 * Railway API client — QB/Handoff/SignNow proxy requests.
 *
 * INTEGRATION POLICY — ZERO SERVER SECRET IN BROWSER:
 *   Browser code must NEVER contain the proxy secret or send X-Proxy-Secret.
 *   All requests authenticate via JWT (apiCall from @/api/railway/client).
 *   The backend requireProxySecret middleware accepts JWT auth as an alternative
 *   to the proxy secret header, so browser requests work without any server secret.
 *
 * No Base44. No VITE_QB_PROXY_SECRET env var. No X-Proxy-Secret header.
 */

import { apiCall } from '@/api/railway/client';
import { RAILWAY_API_URL as PROXY_URL } from '@/lib/apiConfig';

/**
 * Make a request to the Railway proxy via JWT-authenticated apiCall.
 * @param {string} path - e.g. '/qb/auth-status'
 * @param {object} body - JSON payload (for POST requests)
 * @param {object} opts - optional { method: 'GET' | 'POST' (default POST) }
 */
export async function railwayRequest(path, body = {}, opts = {}) {
  const method = opts.method || 'POST';
  return apiCall(path, { method, body });
}

/**
 * Normalizes integration errors for user-facing display.
 */
export function normalizeIntegrationError(error) {
  const raw = error?.message || String(error || '');

  if (raw.includes('<!DOCTYPE') || raw.includes('<html')) {
    if (raw.includes('Cannot POST') || raw.includes('Cannot GET') || raw.includes('404')) {
      return 'QuickBooks proxy needs redeploy. Please redeploy the Railway proxy and try again.';
    }
    return 'QuickBooks proxy returned an unexpected response. Please try again.';
  }

  if (raw.includes('QUICKBOOKS_RECONNECT_REQUIRED') || raw.includes('reconnectRequired')) {
    return 'QuickBooks connection expired. Reconnect in Settings → Integrations.';
  }

  if (raw.includes('ENOTFOUND') || raw.includes('fetch failed') || raw.includes('NetworkError') || raw.includes('Cannot reach QB proxy')) {
    return 'Cannot reach QuickBooks proxy. Check connection and try again.';
  }

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

  const clean = raw.replace(/^Proxy \d+:\s*/, '').replace(/^QB \d+:\s*/, '');
  if (clean.length > 180) return clean.slice(0, 180) + '…';
  return clean || 'Integration failed. Please try again.';
}

export async function syncLeadEstimates(leadId) {
  return railwayRequest('/qb/sync-lead-estimates', { lead_name: leadId });
}

export async function diagnoseLeadEstimates(leadId) {
  return railwayRequest('/qb/diagnose-lead-estimates', { lead_name: leadId });
}

export async function fetchEstimatePdf(estimateRecordId) {
  return railwayRequest('/qb/fetch-estimate-pdf', { estimate_id: estimateRecordId });
}
