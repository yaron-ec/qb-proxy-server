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

export async function get(id) {
  const res = await apiCall(`/api/v1/deal-expense-payments/${id}`, { method: 'GET' });
  return res?.payment || res;
}

export async function create(data) {
  const res = await apiCall('/api/v1/deal-expense-payments', { method: 'POST', body: data });
  return res?.payment || res;
}

export async function update(id, data) {
  const res = await apiCall(`/api/v1/deal-expense-payments/${id}`, { method: 'PUT', body: data });
  return res?.payment || res;
}

export function remove(id) {
  return apiCall(`/api/v1/deal-expense-payments/${id}`, { method: 'DELETE' });
}