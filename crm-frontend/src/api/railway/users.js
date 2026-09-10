/**
 * railway users — User management API client.
 *
 *   list()          -> { items, users, count }  (admin-only)
 *   update(id, data) -> { user }                 (admin-only)
 *   remove(id)      -> { success, id }            (admin-only)
 *
 * Used by the Active Leads owner filter to populate the dropdown from
 * the canonical production users (not hard-coded names).
 */
import { apiCall } from './client';

export function list() {
  return apiCall('/api/v1/users', { method: 'GET' });
}

export function update(id, data) {
  return apiCall(`/api/v1/users/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/users/${id}`, { method: 'DELETE' });
}