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

export function get(id) {
  return apiCall(`/api/v1/deal-expenses/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/deal-expenses', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/deal-expenses/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/deal-expenses/${id}`, { method: 'DELETE' });
}