/**
 * railway deals — Sales (Deal) CRUD client (Stage 2, Railway-native).
 *
 *   list({ stage, leadId, assignedRep, search, sort, limit }) -> { items, total }
 *   get(id)                                                    -> { deal }
 *   create(data)                                              -> { deal }
 *   update(id, data)                                           -> { deal }
 *   remove(id)                                                -> { success, id }
 *
 * CANONICAL IDs are Railway UUIDs: deal.id and deal.lead_id (a Railway Lead UUID).
 * Legacy Base44 IDs (legacy_base44_id, legacy_base44_lead_id) are optional
 * migration metadata on create and are returned in responses, but are NEVER
 * required for normal CRUD and cannot be changed after create.
 *
 * Hits the Railway /api/v1/deals CRUD surface. The frontend is NOT switched to
 * this client yet (Stage 4); it is provided now so the swap is a one-line import
 * change per page. Existing pages keep calling base44.functions.invoke('getSoldDeals')
 * until Stage 4 — no behavior change in this stage.
 */
import { apiCall } from './client';

export function list(params = {}) {
  const qs = new URLSearchParams();
  if (params.stage && params.stage !== 'all') qs.set('stage', params.stage);
  if (params.leadId) qs.set('lead_id', params.leadId);
  if (params.assignedRep && params.assignedRep !== 'all') qs.set('assigned_rep', params.assignedRep);
  if (params.search) qs.set('search', params.search);
  if (params.sort) qs.set('sort', params.sort);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return apiCall(`/api/v1/deals${q ? `?${q}` : ''}`, { method: 'GET' });
}

export function get(id) {
  return apiCall(`/api/v1/deals/${id}`, { method: 'GET' });
}

export function create(data) {
  return apiCall('/api/v1/deals', { method: 'POST', body: data });
}

export function update(id, data) {
  return apiCall(`/api/v1/deals/${id}`, { method: 'PUT', body: data });
}

export function remove(id) {
  return apiCall(`/api/v1/deals/${id}`, { method: 'DELETE' });
}