/**
 * railway lead emails — lead-scoped Gmail correspondence client.
 *
 *   getEmails(leadId) -> { items: [...] }  (activities, type='email', source='gmail')
 *
 * Hits GET /api/v1/leads/:id/emails (routes/leadEmails.js) — never the
 * admin-only whole-mailbox search (@/api/railway/client's gmailMessages).
 */
import { apiCall } from './client';

export function getEmails(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/emails`, { method: 'GET' });
}
