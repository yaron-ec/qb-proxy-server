/**
 * railway activities — Activity CRUD client.
 *   list({ lead_id, type, source })  -> { items, total }
 *   get(id)                          -> { activity }
 *   create(data)                     -> { activity }
 *   update(id, data)                 -> { activity }
 *   remove(id)                       -> { success, id }
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.lead_id) qs.set('lead_id', params.lead_id);
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  if (params.source && params.source !== 'all') qs.set('source', params.source);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return apiCall(`/api/v1/activities${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/activities/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/activities', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/activities/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/activities/${id}`, { method: 'DELETE' });
}