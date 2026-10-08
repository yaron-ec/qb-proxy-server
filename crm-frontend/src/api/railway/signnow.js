/**
 * railway signnow — SignNow documents API client.
 *
 *   listDocuments(externalRef)              -> { documents }
 *   uploadDocument(externalRef, data)        -> { document }
 *   prepareFromTemplate(externalRef, data)  -> { document, message }
 *   sendDocument(docId)                      -> { success, document }
 *   getDocumentStatus(docId)                -> { document }
 *   getOpenLink(docId)                       -> { url, mode: 'editor'|'view' }
 *   downloadSignedPdf(docId)                -> Blob (PDF)
 *   deleteDocument(docId)                   -> { success }
 *   listTemplates()                          -> { templates }
 *   getCrmSources()                          -> { sources }
 *   getFieldMappings(templateId)             -> { template_id, mappings, live_fields, live_fields_error }
 *   setFieldMappings(templateId, mappings)   -> { template_id, mappings }
 */

import { apiCall } from './client';
import { RAILWAY_API_URL } from '@/lib/apiConfig';

export function listDocuments(externalRef) {
  return apiCall(`/api/v1/signnow/by-external/${encodeURIComponent(externalRef)}`, { method: 'GET' });
}

export function uploadDocument(externalRef, data) {
  return apiCall(`/api/v1/signnow/by-external/${encodeURIComponent(externalRef)}/upload`, { method: 'POST', body: data });
}

export function prepareFromTemplate(externalRef, data) {
  return apiCall(`/api/v1/signnow/by-external/${encodeURIComponent(externalRef)}/prepare`, { method: 'POST', body: data });
}

export function getDocumentStatus(docId) {
  return apiCall(`/api/v1/signnow/documents/${encodeURIComponent(docId)}/status`, { method: 'GET' });
}

export function getOpenLink(docId) {
  return apiCall(`/api/v1/signnow/documents/${encodeURIComponent(docId)}/open-link`, { method: 'GET' });
}

export function sendDocument(docId) {
  return apiCall(`/api/v1/signnow/documents/${encodeURIComponent(docId)}/send`, { method: 'POST' });
}

export function deleteDocument(docId) {
  return apiCall(`/api/v1/signnow/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' });
}

export async function downloadSignedPdf(docId) {
  const access = localStorage.getItem('railway_access_token') || '';
  const res = await fetch(`${RAILWAY_API_URL}/api/v1/signnow/documents/${encodeURIComponent(docId)}/pdf`, {
    headers: { 'Authorization': `Bearer ${access}` },
  });
  if (!res.ok) throw new Error('Failed to download PDF: ' + res.status);
  return await res.blob();
}

export function listTemplates() {
  return apiCall(`/api/v1/signnow/templates`, { method: 'GET' });
}

export function getCrmSources() {
  return apiCall(`/api/v1/signnow/crm-sources`, { method: 'GET' });
}

export function getFieldMappings(templateId) {
  return apiCall(`/api/v1/signnow/field-mappings/${encodeURIComponent(templateId)}`, { method: 'GET' });
}

export function setFieldMappings(templateId, mappings) {
  return apiCall(`/api/v1/signnow/field-mappings/${encodeURIComponent(templateId)}`, { method: 'PUT', body: { mappings } });
}