/**
 * railway leadSubmissions — Submission history API client.
 *
 *   list(externalRef)   -> { items, total }
 *   create(externalRef, data) -> { submission }
 */

import { apiCall } from './client';

export function list(externalRef) {
  return apiCall(`/api/v1/lead-submissions/by-external/${encodeURIComponent(externalRef)}`, { method: 'GET' });
}

export function create(externalRef, data) {
  return apiCall(`/api/v1/lead-submissions/by-external/${encodeURIComponent(externalRef)}`, { method: 'POST', body: data });
}