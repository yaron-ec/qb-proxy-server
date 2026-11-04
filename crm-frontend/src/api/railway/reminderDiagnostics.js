/**
 * railway reminder diagnostics — admin-only, read-only appointment
 * notification diagnostic for a single lead.
 */
import { apiCall } from './client';

export function getAppointmentNotificationDiagnostics(leadId) {
  return apiCall(`/api/v1/leads/${leadId}/reminder-diagnostics`, { method: 'GET' });
}
