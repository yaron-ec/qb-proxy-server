/**
 * railway routing — Daily Appointment Routing API client.
 *
 *   getDailySchedule({ owner, date, city, projectType })  -> { appointments, schedule, owner_config }
 *   backfillGeocodes()                                     -> { total, success, failed, skipped }
 *   getOwnerConfig()                                       -> { owner_starts }
 *   updateOwnerConfig(owner_starts)                        -> { owner_starts }
 */

import { apiCall } from './client';

export function getDailySchedule(params = {}) {
  const qs = new URLSearchParams();
  if (params.owner) qs.set('owner', params.owner);
  if (params.date) qs.set('date', params.date);
  if (params.city && params.city !== 'all') qs.set('city', params.city);
  if (params.projectType && params.projectType !== 'all') qs.set('project_type', params.projectType);
  const q = qs.toString();
  return apiCall(`/api/v1/routing/daily-schedule${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function backfillGeocodes() {
  return apiCall('/api/v1/routing/backfill-geocodes', { method: 'POST' });
}

export function getOwnerConfig() {
  return apiCall('/api/v1/routing/owner-config', { method: 'GET' });
}

export function updateOwnerConfig(ownerStarts) {
  return apiCall('/api/v1/routing/owner-config', { method: 'PUT', body: { owner_starts: ownerStarts } });
}