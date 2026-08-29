/**
 * railway leadQB — QuickBooks lead status API client.
 *
 *   getStatus(externalRef)              -> { lead, crmInvoices, qbInvoices, estimates, qbConnected }
 *   refreshFromQB(externalRef)           -> { success, qbData, message }
 *   syncToQB(externalRef)               -> { success, customer_id, customer }
 */

import { apiCall } from './client';

export function getStatus(externalRef) {
  return apiCall(`/api/v1/lead-qb/by-external/${encodeURIComponent(externalRef)}`, { method: 'GET' });
}

export function refreshFromQB(externalRef) {
  return apiCall(`/api/v1/lead-qb/by-external/${encodeURIComponent(externalRef)}/refresh`, { method: 'POST' });
}

export function syncToQB(externalRef) {
  return apiCall(`/api/v1/lead-qb/by-external/${encodeURIComponent(externalRef)}/sync`, { method: 'POST' });
}