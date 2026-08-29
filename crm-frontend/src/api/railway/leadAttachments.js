/**
 * railway lead attachments — Lead Attachment CRUD client.
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.lead_id) qs.set('lead_id', params.lead_id);
  const q = qs.toString();
  return apiCall(`/api/v1/lead-attachments${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/lead-attachments/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/lead-attachments', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/lead-attachments/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/lead-attachments/${id}`, { method: 'DELETE' });
}