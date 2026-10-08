/**
 * railway qb — QuickBooks Item/invoice-config discovery and Deal-scoped
 * Estimate/Invoice creation (CRM STABILITY PHASE completion pass).
 *
 *   listItems()                  -> { items }                (read-only, admin)
 *   getInvoiceConfig()           -> { config }                (admin)
 *   setInvoiceConfig(config)     -> { config }                (admin)
 *   createEstimate(dealId)       -> { created, qb_estimate_id, qb_estimate_number }
 *   createInvoice(dealId)        -> { created, qb_invoice_id, qb_doc_number }
 */
import { apiCall } from './client';

export function listItems() {
  return apiCall('/api/v1/qb/items', { method: 'GET' });
}

export function getInvoiceConfig() {
  return apiCall('/api/v1/qb/invoice-config', { method: 'GET' });
}

export function setInvoiceConfig(config) {
  return apiCall('/api/v1/qb/invoice-config', { method: 'PUT', body: config });
}

export function createEstimate(dealId) {
  return apiCall(`/api/v1/deals/${encodeURIComponent(dealId)}/qb-estimate`, { method: 'POST' });
}

export function createInvoice(dealId) {
  return apiCall(`/api/v1/deals/${encodeURIComponent(dealId)}/qb-invoice`, { method: 'POST' });
}
