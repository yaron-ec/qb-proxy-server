/**
 * railway handoff estimates — Handoff Estimate CRUD client.
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.lead_id) qs.set('lead_id', params.lead_id);
  if (params.match_status && params.match_status !== 'all') qs.set('match_status', params.match_status);
  if (params.qb_estimate_id) qs.set('qb_estimate_id', params.qb_estimate_id);
  const q = qs.toString();
  return apiCall(`/api/v1/handoff-estimates${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/handoff-estimates/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/handoff-estimates', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/handoff-estimates/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/handoff-estimates/${id}`, { method: 'DELETE' });
}