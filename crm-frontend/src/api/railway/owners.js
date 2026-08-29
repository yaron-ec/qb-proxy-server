/**
 * railway owners — Sales-rep / owner directory client (R1A foundation).
 *
 *   list() -> { items }  (active owners with display_name + email)
 */

import { apiCall } from './client';

export function list() {
  return apiCall('/api/v1/owners', { method: 'GET' });
}