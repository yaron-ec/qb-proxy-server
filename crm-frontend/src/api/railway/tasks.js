/**
 * railway tasks — Task CRUD client.
 *
 *   list({ lead_id, deal_id, status, limit })  -> { items, total }
 *   get(id)                                     -> { task }
 *   create(data)                                -> { task }
 *   update(id, data)                            -> { task }
 *   remove(id)                                  -> { success, id }
 */

import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.lead_id) qs.set('lead_id', params.lead_id);
  if (params.deal_id) qs.set('deal_id', params.deal_id);
  if (params.status && params.status !== 'all') qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return apiCall(`/api/v1/tasks${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/tasks/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/tasks', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/tasks/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/tasks/${id}`, { method: 'DELETE' });
}