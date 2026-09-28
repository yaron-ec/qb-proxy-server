/**
 * railway system info — GET /api/v1/system/info client
 * (PRODUCTIZATION PHASE 2, System Health).
 */
import { apiCall } from './client';

export function get() {
  return apiCall('/api/v1/system/info', { method: 'GET' });
}
