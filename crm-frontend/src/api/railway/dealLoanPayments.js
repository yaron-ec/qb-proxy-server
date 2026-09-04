/**
 * railway deal loan payments — Deal Loan Payment CRUD client.
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.deal_id) qs.set('deal_id', params.deal_id);
  const q = qs.toString();
  return apiCall(`/api/v1/deal-loan-payments${q ? `?${q}` : ''}`, { method: 'GET' });
}

export async function get(id) {
  const res = await apiCall(`/api/v1/deal-loan-payments/${id}`, { method: 'GET' });
  return res?.loanPayment || res;
}

export async function create(data) {
  const res = await apiCall('/api/v1/deal-loan-payments', { method: 'POST', body: data });
  return res?.loanPayment || res;
}

export async function update(id, data) {
  const res = await apiCall(`/api/v1/deal-loan-payments/${id}`, { method: 'PUT', body: data });
  return res?.loanPayment || res;
}

export function remove(id) {
  return apiCall(`/api/v1/deal-loan-payments/${id}`, { method: 'DELETE' });
}