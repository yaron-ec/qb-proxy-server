/**
 * railway sold-welcome-email — admin-only preview/status/manual-send for
 * the automated "Welcome to the EC Construction Group Family!" email.
 */
import { apiCall } from './client';

export function previewSoldWelcomeEmail(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/sold-welcome-email/preview`, { method: 'GET' });
}

export function getSoldWelcomeEmailStatus(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/sold-welcome-email`, { method: 'GET' });
}

export function sendSoldWelcomeEmail(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/sold-welcome-email/send`, { method: 'POST' });
}
