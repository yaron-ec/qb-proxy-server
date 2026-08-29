/**
 * railway sync cursors — Sync Cursor CRUD client (admin only).
 */
import { apiCall } from './client';

export function list() {
  return apiCall('/api/v1/sync-cursors', { method: 'GET' });
}

export function get(integration) {
  return apiCall(`/api/v1/sync-cursors/${encodeURIComponent(integration)}`, { method: 'GET' });
}

export function upsert(integration, data) {
  return apiCall(`/api/v1/sync-cursors/${encodeURIComponent(integration)}`, { method: 'PUT', body: data });
}

export function remove(integration) {
  return apiCall(`/api/v1/sync-cursors/${encodeURIComponent(integration)}`, { method: 'DELETE' });
}