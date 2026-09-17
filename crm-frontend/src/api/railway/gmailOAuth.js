/**
 * railway gmailOAuth — admin-only Gmail (re)connection status + trigger.
 *
 *   getStatus()  -> { connected, has_send_access, has_read_access, scope_recorded, ... }
 *   reconnect()  -> navigates the BROWSER (not a fetch) to Google's consent
 *                   screen via a short-lived, single-purpose setup_token
 *                   minted server-side. Never touches PROXY_SECRET or any
 *                   OAuth token — the browser only ever sees an opaque path.
 *
 * Hits /api/v1/admin/gmail-oauth/* (routes/adminGmailOAuth.js), admin-role
 * only. Distinct from @/api/railway/client's gmailProfile (admin mailbox
 * read check) — this is connection/scope status, not a mailbox call.
 */
import { apiCall } from './client';
import { RAILWAY_API_URL } from '@/lib/apiConfig';

export function getStatus() {
  return apiCall('/api/v1/admin/gmail-oauth/status', { method: 'GET' });
}

export async function reconnect() {
  const { path } = await apiCall('/api/v1/admin/gmail-oauth/start-url', { method: 'GET' });
  window.location.href = `${RAILWAY_API_URL}${path}`;
}
