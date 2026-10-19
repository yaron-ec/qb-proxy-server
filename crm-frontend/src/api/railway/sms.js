/**
 * railway sms — lead-scoped two-way SMS client.
 *
 *   getConversation(leadId) -> { items: [...] }      GET  /api/v1/leads/:id/sms
 *   send(leadId, body)      -> { message: {...} }    POST /api/v1/leads/:id/sms
 *
 * Ownership/visibility is enforced server-side (routes/sms.js reuses
 * routes/leads.js#resolveOwnerScope) — never trust/duplicate that check here.
 */
import { apiCall } from './client';

export function getConversation(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/sms`, { method: 'GET' });
}

export function send(leadId, body) {
  return apiCall(`/api/v1/leads/${leadId}/sms`, { method: 'POST', body: { body } });
}
