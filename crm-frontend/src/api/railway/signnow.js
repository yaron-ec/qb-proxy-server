/**
 * railway signnow — SignNow documents API client.
 *
 *   listDocuments(externalRef)              -> { documents }
 *   uploadDocument(externalRef, data)        -> { document }
 *   prepareFromTemplate(externalRef, data)  -> { document, message }
 *   getDocumentStatus(docId)                -> { document }
 *   downloadSignedPdf(docId)                -> Blob (PDF)
 *   deleteDocument(docId)                   -> { success }
 *   listTemplates()                          -> { templates }
 */

import { apiCall } from './client';

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

export function deleteDocument(docId) {
  return apiCall(`/api/v1/signnow/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' });
}

export function listTemplates() {
  return apiCall(`/api/v1/signnow/templates`, { method: 'GET' });
}