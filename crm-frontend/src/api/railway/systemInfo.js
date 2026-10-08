/**
 * railway system info — GET /api/v1/system/info client
 * (PRODUCTIZATION PHASE 2, System Health).
 *
 * get({ verify: true }) requests the live-connectivity-check pass
 * (?verify=1) — slower and rate-limited server-side, since it makes real
 * outbound calls to third-party integrations. Omit it (or pass nothing)
 * for the fast, local, credential-presence-only default.
 */
import { apiCall } from './client';

export function get({ verify = false } = {}) {
  const qs = verify ? '?verify=1' : '';
  return apiCall(`/api/v1/system/info${qs}`, { method: 'GET' });
}
