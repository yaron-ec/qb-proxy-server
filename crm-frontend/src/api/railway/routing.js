/**
 * railway routing — Daily Appointment Routing API client.
 *
 *   getDailySchedule({ owner, date, city, projectType })  -> { appointments, schedule, owner_config }
 *   getOwnerConfig()                                       -> { owner_config }
 *   updateOwnerConfig(config)                              -> { owner_config }
 *   backfillGeocodes()                                      -> { total, success, failed, skipped }
 *   reconcileAddresses({ lead_id })                        -> { reconciled, needsReview, failed }
 */

import { apiCall } from './client';

export function getDailySchedule({ owner = 'all', date, city = 'all', projectType = 'all' } = {}) {
  const params = new URLSearchParams({ owner, date, city, project_type: projectType });
  return apiCall(`/api/v1/routing/daily-schedule?${params.toString()}`, { method: 'GET' });
}

export function getOwnerConfig() {
  return apiCall('/api/v1/routing/owner-config', { method: 'GET' });
}

export function updateOwnerConfig(config) {
  return apiCall('/api/v1/routing/owner-config', { method: 'PUT', body: JSON.stringify(config) });
}

export function backfillGeocodes() {
  return apiCall('/api/v1/routing/backfill-geocodes', { method: 'POST' });
}

export function reconcileAddresses(options = {}) {
  return apiCall('/api/v1/routing/reconcile-addresses', { method: 'POST', body: JSON.stringify(options) });
}
