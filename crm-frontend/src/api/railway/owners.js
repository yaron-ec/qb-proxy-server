/**
 * railway owners — Sales-rep / owner directory client (R1A foundation).
 *
 *   list()           -> { items }  (active owners with display_name + email)
 *   update(id, data) -> { owner }  (admin-only: edit email/display_name)
 */

import { apiCall } from './client';

export function list() {
  return apiCall('/api/v1/owners', { method: 'GET' });
}

export function update(id, data) {
  return apiCall(`/api/v1/owners/${id}`, { method: 'PATCH', body: data });
}