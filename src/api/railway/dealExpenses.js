/**
 * railway deal expenses — Deal Expense CRUD client.
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.deal_id) qs.set('deal_id', params.deal_id);
  if (params.category && params.category !== 'all') qs.set('category', params.category);
  if (params.payment_status && params.payment_status !== 'all') qs.set('payment_status', params.payment_status);
  const q = qs.toString();
  return apiCall(`/api/v1/deal-expenses${q ? `?${q}` : ''}`, { method: 'GET' });
}

export async function get(id) {
  const res = await apiCall(`/api/v1/deal-expenses/${id}`, { method: 'GET' });
  return res?.expense || res;
}

export async function create(data) {
  const res = await apiCall('/api/v1/deal-expenses', { method: 'POST', body: data });
  return res?.expense || res;
}

export async function update(id, data) {
  const res = await apiCall(`/api/v1/deal-expenses/${id}`, { method: 'PUT', body: data });
  return res?.expense || res;
}

export function remove(id) {
  return apiCall(`/api/v1/deal-expenses/${id}`, { method: 'DELETE' });
}