/**
 * railway qbInvoiceMapping — admin review + explicit reassignment of a
 * QuickBooks invoice's deal (crm_sale_id) ownership within one lead.
 *
 *   getByLead(leadId)                        -> { lead, deals, invoices }
 *   reassign(qbInvoiceId, { crm_sale_id, reason }) -> { mapping, old_deal_name, new_deal_name }
 */
import { apiCall } from './client';

export function getByLead(leadId) {
  return apiCall(`/api/v1/qb-invoice-mapping/by-lead/${encodeURIComponent(leadId)}`, { method: 'GET' });
}

export function reassign(qbInvoiceId, data) {
  return apiCall(`/api/v1/qb-invoice-mapping/${encodeURIComponent(qbInvoiceId)}/reassign`, { method: 'POST', body: data });
}
