/**
 * railway deal commissions — Deal Commission CRUD client.
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.deal_id) qs.set('deal_id', params.deal_id);
  if (params.recipient_user_id) qs.set('recipient_user_id', params.recipient_user_id);
  const q = qs.toString();
  return apiCall(`/api/v1/deal-commissions${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/deal-commissions/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/deal-commissions', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/deal-commissions/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/deal-commissions/${id}`, { method: 'DELETE' });
}