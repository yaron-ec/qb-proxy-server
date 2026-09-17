/**
 * railway owners — Sales-rep / owner directory client (R1A foundation).
 *
 *   list()                    -> { items }  (active owners with display_name + email)
 *   listAll()                 -> { items }  (admin-only: every owner incl. inactive/merged, with reference_counts — read-only audit)
 *   update(id, data)          -> { owner }  (admin-only: edit email/display_name/is_active)
 *   mergePreview(mergeId, keepId) -> preview of what a merge would repoint (admin-only, no mutation)
 *   merge(keepId, mergeId)    -> { success, stats, preserved }  (admin-only: transactional duplicate consolidation)
 */

import { apiCall } from './client';

export function list() {
  return apiCall('/api/v1/owners', { method: 'GET' });
}

export function listAll() {
  return apiCall('/api/v1/owners/all', { method: 'GET' });
}

export function update(id, data) {
  return apiCall(`/api/v1/owners/${id}`, { method: 'PATCH', body: data });
}

export function mergePreview(mergeId, keepId) {
  return apiCall(`/api/v1/owners/${mergeId}/merge-preview?keep_id=${encodeURIComponent(keepId)}`, { method: 'GET' });
}

export function merge(keepId, mergeId) {
  return apiCall('/api/v1/owners/merge', { method: 'POST', body: { keep_id: keepId, merge_id: mergeId } });
}