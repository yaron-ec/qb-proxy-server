/**
 * railway settings — App configuration lists (statuses, project types, sources, columns).
 *
 *   list()              -> { items: [{ key, value, type }] }
 *   get(key)            -> { key, value, type }
 *   upsert(key, value)  -> { key, value, type }
 *   remove(key)         -> { success, key }
 */

import { apiCall } from './client';

export function list() {
  return apiCall('/api/v1/settings', { method: 'GET' });
}

export function get(key) {
  return apiCall(`/api/v1/settings/${encodeURIComponent(key)}`, { method: 'GET' });
}

export function upsert(key, value, type = 'columns') {
  return apiCall(`/api/v1/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { value, type },
  });
}

export function remove(key) {
  return apiCall(`/api/v1/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
}