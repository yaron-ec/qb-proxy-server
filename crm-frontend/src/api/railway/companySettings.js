/**
 * railway company settings — Company Settings singleton client.
 */
import { apiCall } from './client';

export function get() {
  return apiCall('/api/v1/company-settings', { method: 'GET' });
}

export function upsert(data) {
  return apiCall('/api/v1/company-settings', { method: 'PUT', body: data });
}

export function remove() {
  return apiCall('/api/v1/company-settings', { method: 'DELETE' });
}