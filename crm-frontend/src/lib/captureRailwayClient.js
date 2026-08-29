/**
 * captureRailwayClient — frontend client for the PUBLIC Railway Lead Capture
 * endpoints (no JWT, no proxy secret). Replaces the Base44 checkCalendarConflicts
 * + submitLeadCapture runtime calls in the /capture flow.
 *
 * Base URL is the Railway service (VITE_QB_PROXY_URL), same host that serves
 * /api/public/capture/*. No auth headers — these are intentionally public,
 * rate-limited endpoints.
 */

import { RAILWAY_API_URL as BASE } from '@/lib/apiConfig';

// EC-owned kill-switch: when set to 'false', submit falls back to the existing
// Base44 submitLeadCapture function (rollback during validation). Defaults to
// Railway (enabled). Availability always uses Railway — the 1hr-before +
// duration + 1hr-after buffer rule lives only in the Railway availabilityService.
export function isRailwayCaptureEnabled() {
  return import.meta.env.VITE_RAILWAY_CAPTURE_ENABLED !== 'false';
}

export async function fetchCaptureAvailability({ owner, date, duration = 60 }) {
  if (!BASE) {
    throw Object.assign(new Error('Capture service not configured.'), { code: 'config_error' });
  }
  const url = `${BASE}/api/public/capture/availability?owner=${encodeURIComponent(owner)}&date=${encodeURIComponent(date)}&duration=${duration}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.message || data?.error || 'availability failed'), {
      status: res.status, data, code: data?.error,
    });
  }
  return data;
}

export async function submitCapture(payload, options = {}) {
  if (!isRailwayCaptureEnabled()) {
    throw new Error('Railway capture is disabled. Set VITE_RAILWAY_CAPTURE_ENABLED to enable.');
  }
  if (!BASE) {
    throw Object.assign(new Error('Capture service not configured.'), { code: 'config_error' });
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // Admin conflict-override: attach the Railway JWT ONLY when the caller
  // explicitly passes an adminToken (admin-override submission). Normal
  // submissions stay auth-free. The backend re-verifies the token + role +
  // email allowlist server-side; this header is never trusted alone.
  if (options.adminToken) {
    headers.Authorization = `Bearer ${options.adminToken}`;
  }
  const res = await fetch(`${BASE}/api/public/capture`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.message || data?.error || 'submit failed'), {
      status: res.status, data, code: data?.error,
    });
  }
  return data;
}

// Base44 fallback removed — Railway capture is the sole submission path.
// If isRailwayCaptureEnabled() is false, submit throws (no Base44 rollback).