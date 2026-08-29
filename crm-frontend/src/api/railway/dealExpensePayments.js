/**
 * railway deal expense payments — Deal Expense Payment CRUD client.
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.expense_id) qs.set('expense_id', params.expense_id);
  if (params.deal_id) qs.set('deal_id', params.deal_id);
  const q = qs.toString();
  return apiCall(`/api/v1/deal-expense-payments${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/deal-expense-payments/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/deal-expense-payments', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/deal-expense-payments/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/deal-expense-payments/${id}`, { method: 'DELETE' });
}