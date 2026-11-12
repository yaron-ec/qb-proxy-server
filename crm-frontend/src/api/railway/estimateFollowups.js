/**
 * railway estimateFollowups — the automated 14-day estimate follow-up email
 * sequence. Lead-scoped calls reuse the backend's own
 * routes/leads.js#resolveOwnerScope ownership filter server-side — never
 * duplicated or trusted here.
 */
import { apiCall } from './client';

// ── Lead-scoped ──────────────────────────────────────────────────────────
export function getState(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/estimate-followup`, { method: 'GET' });
}

export function getPreview(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/estimate-followup/preview`, { method: 'GET' });
}

export function confirmSent(leadId, { handoffEstimateId, sentAt, note } = {}) {
  return apiCall(`/api/v1/leads/${leadId}/estimate-followup/confirm-sent`, {
    method: 'POST', body: { handoffEstimateId, sentAt, note },
  });
}

export function manualEnroll(leadId, { handoffEstimateId, note } = {}) {
  return apiCall(`/api/v1/leads/${leadId}/estimate-followup/manual-enroll`, {
    method: 'POST', body: { handoffEstimateId, note },
  });
}

export function pause(leadId, reason) {
  return apiCall(`/api/v1/leads/${leadId}/estimate-followup/pause`, { method: 'POST', body: { reason } });
}

export function resume(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/estimate-followup/resume`, { method: 'POST', body: {} });
}

export function stop(leadId, reason) {
  return apiCall(`/api/v1/leads/${leadId}/estimate-followup/stop`, { method: 'POST', body: { reason } });
}

// ── Admin/manager-only global oversight ─────────────────────────────────
export function getAdminOverview() {
  return apiCall('/api/v1/estimate-followups/admin/overview', { method: 'GET' });
}

export function getDryRunReport() {
  return apiCall('/api/v1/estimate-followups/admin/dry-run-report', { method: 'GET' });
}

export function getAutomationStatus() {
  return apiCall('/api/v1/estimate-followups/admin/automation-status', { method: 'GET' });
}

export function getAmbiguousReplies() {
  return apiCall('/api/v1/estimate-followups/admin/ambiguous-replies', { method: 'GET' });
}

export function resolveAmbiguousReply(id) {
  return apiCall(`/api/v1/estimate-followups/admin/ambiguous-replies/${id}/resolve`, { method: 'POST', body: {} });
}

// Automatic post-appointment QuickBooks estimate sync — admin monitoring
// for failed/overdue jobs (see lib/postAppointmentEstimateSync.js).
export function getPostAppointmentSyncStatus() {
  return apiCall('/api/v1/estimate-followups/admin/post-appointment-sync-status', { method: 'GET' });
}

export function listTemplates() {
  return apiCall('/api/v1/estimate-followups/templates', { method: 'GET' });
}

export function getTemplateHistory(templateKey) {
  return apiCall(`/api/v1/estimate-followups/templates/${templateKey}/history`, { method: 'GET' });
}

export function saveTemplate(templateKey, { subject, bodyHtml } = {}) {
  return apiCall(`/api/v1/estimate-followups/templates/${templateKey}`, {
    method: 'PUT', body: { subject, bodyHtml },
  });
}
