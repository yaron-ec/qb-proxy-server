/**
 * railway leads — Lead list/get client (R1A foundation: read-only).
 *
 *   list({ status, source, ownerEmail, search, sort, limit }) -> { items, total }
 *   get(id)                                                   -> { lead }
 *
 * Writes (create/update/duplicate-check) arrive in R1B.
 */

import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.status && params.status !== 'all') qs.set('status', params.status);
  if (params.source && params.source !== 'all') qs.set('source', params.source);
  if (params.ownerEmail && params.ownerEmail !== 'all') qs.set('owner_email', params.ownerEmail);
  if (params.search) qs.set('search', params.search);
  if (params.sort) qs.set('sort', params.sort);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return apiCall(`/api/v1/leads${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/leads/${id}`, { method: 'GET' });
}

/**
 * Get a lead by its external_ref (the Base44 lead ID).
 * Returns 404 if the lead doesn't exist in Railway yet.
 */
export function getByExternal(externalRef) {
  return apiCall(`/api/v1/leads/by-external/${encodeURIComponent(externalRef)}`, { method: 'GET' });
}

/**
 * Upsert + update contact fields by external_ref (Base44 lead ID).
 * Validates email/phone, checks for duplicates on other leads.
 * Returns { lead } on success, throws with status 409 on duplicate conflict.
 */
export function updateByExternal(externalRef, data) {
  return apiCall(`/api/v1/leads/by-external/${encodeURIComponent(externalRef)}`, {
    method: 'PUT',
    body: data,
  });
}

/**
 * Update a lead by Railway ID (full CRM field update).
 * Supports: status, notes, owner_id, assigned_rep, follow_up_*, meeting_stage,
 * project_type, budget_range, start_timeframe, source, referral_name, lead_score,
 * is_new_intake_lead, customer_reminders_disabled, record_type, reviewed_at, message, photo_urls.
 * Returns { lead } on success.
 */
export function update(id, data) {
  return apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: data });
}

/**
 * Delete a lead by Railway ID.
 * Returns { success, id } on success.
 */
export function remove(id) {
  return apiCall(`/api/v1/leads/${id}`, { method: 'DELETE' });
}

/**
 * Delete a lead by external_ref (Base44 lead ID).
 * Returns { success, external_ref } on success.
 */
export function deleteByExternal(externalRef) {
  return apiCall(`/api/v1/leads/by-external/${encodeURIComponent(externalRef)}`, { method: 'DELETE' });
}

/**
 * Get composite lead detail by external_ref (Base44 lead ID).
 * Returns { lead, activities, deals, contactOwners, projectTypes, leadSources }.
 * Replaces the Base44 getLeadDetail function.
 */
export function getDetailByExternal(externalRef) {
  return apiCall(`/api/v1/leads/by-external/${encodeURIComponent(externalRef)}/detail`, { method: 'GET' });
}

/**
 * Update appointment fields by external_ref (Base44 lead ID).
 * Updates ONLY appointment fields (appointment_date, appointment_time, meeting_stage,
 * follow_up_date, follow_up_time, follow_up_type). Separate from contact update.
 * Returns { lead }.
 */
export function updateAppointmentByExternal(externalRef, data, opts = {}) {
  return apiCall(`/api/v1/leads/by-external/${encodeURIComponent(externalRef)}/appointment`, { method: 'PUT', body: data, signal: opts.signal });
}

/**
 * Trigger Google Calendar sync for a lead via the native Railway calendarOutbox
 * system. Enqueues main + travel events (1hr buffer before/after) processed by
 * the calendar outbox worker. No Base44, no direct Google API calls from the
 * endpoint. Returns { success, appointment_id, message }.
 */
export function syncCalendar(externalRef) {
  return apiCall(`/api/v1/leads/by-external/${encodeURIComponent(externalRef)}/sync-calendar`, { method: 'POST' });
}

/**
 * Trigger Google Contact sync for a lead via the Railway service account.
 * Returns { success, resource_name } on success, or 501 if contacts scope
 * is not configured on the service account. No Base44.
 */
export function syncContact(externalRef) {
  return apiCall(`/api/v1/leads/by-external/${encodeURIComponent(externalRef)}/sync-contact`, { method: 'POST' });
}

// ── REMOVED: Base44 proxy functions ──────────────────────────────────────────
// The following functions were REMOVED because they proxied to Base44 functions
// via Railway, violating the architecture requirement:
//   proxyQBStatus, proxyQBSync, proxySignNow, getSubmissions,
//   getSignNowDocuments, deleteSignNowDocument
//
// These must be replaced with NATIVE Railway implementations:
//   - QB: native endpoints reading from Postgres + calling Intuit API directly
//   - SignNow: native endpoints calling SignNow API directly + Postgres table
//   - Submissions: native lead_submissions table in Postgres
//
// Until native implementations are built, the frontend components
// (QBStatusPanel, SignNowPanel, SubmissionHistory) show a
// "pending native migration" state.