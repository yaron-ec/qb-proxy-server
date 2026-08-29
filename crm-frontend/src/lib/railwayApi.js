/**
 * railwayApi — backward-compat shim. Re-exports the permanent Railway API
 * modules from @/api/railway so existing importers keep working.
 *
 * New/migrated code should import from @/api/railway directly.
 * This file will be deleted in the final cleanup phase once all importers
 * have been migrated to @/api/railway.
 */

import { apiCall, isLoggedIn, clearTokens, setTokens, API_URL } from '@/api/railway/client';
import { login, logout, me, migrateFromBase44 } from '@/api/railway/auth';

// Re-export transport + auth
export { apiCall, isLoggedIn, clearTokens, setTokens, login, logout, me, migrateFromBase44, API_URL };

// ── Email endpoints (remain here until the email service phase) ──────────────
export const sendEmail = (to, subject, htmlBody, opts = {}) => {
  if (!opts || !opts.idempotencyKey) {
    throw new Error('railwayApi.sendEmail: idempotencyKey is required (deterministic, caller-supplied — no random fallback)');
  }
  return apiCall('/api/v1/emails/send', { body: { to, subject, htmlBody, ...opts } });
};

export const sendTestEmail = (to, nonce) =>
  apiCall('/api/v1/emails/test', { body: { to, nonce } });

export const sendLeadReminder = (leadId) =>
  apiCall(`/api/v1/leads/${leadId}/remind`, { body: {} });

export const sendInvoiceEmail = (invoiceId) =>
  apiCall(`/api/v1/invoices/${invoiceId}/email`, { body: {} });

// ── Gmail READ endpoints (server-side token; no browser Gmail token) ────────
export const gmailProfile = () => apiCall('/api/v1/gmail/profile', { method: 'GET' });
export const gmailMessages = (maxResults = 20, q = 'is:inbox') =>
  apiCall(`/api/v1/gmail/messages?maxResults=${maxResults}&q=${encodeURIComponent(q)}`, { method: 'GET' });
export const gmailMessage = (id) => apiCall(`/api/v1/gmail/messages/${id}`, { method: 'GET' });

export default { login, logout, me, migrateFromBase44, sendEmail, sendTestEmail, sendLeadReminder, sendInvoiceEmail, gmailProfile, gmailMessages, gmailMessage, apiCall, isLoggedIn, clearTokens };