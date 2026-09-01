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

export async function get(id) {
  const res = await apiCall(`/api/v1/deal-commissions/${id}`, { method: 'GET' });
  return res?.commission || res;
}

export async function create(data) {
  const res = await apiCall('/api/v1/deal-commissions', { method: 'POST', body: data });
  return res?.commission || res;
}

export async function update(id, data) {
  const res = await apiCall(`/api/v1/deal-commissions/${id}`, { method: 'PUT', body: data });
  return res?.commission || res;
}

export function remove(id) {
  return apiCall(`/api/v1/deal-commissions/${id}`, { method: 'DELETE' });
}