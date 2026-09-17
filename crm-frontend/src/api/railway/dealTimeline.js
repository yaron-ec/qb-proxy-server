/**
 * railway deal timeline — Deal Activity project-history timeline client.
 *
 *   getTimeline(dealId)                        -> { events: [...] }
 *   uploadCompletionForm(dealId, fileMeta)      -> { attachment }
 *
 * Hits the Railway /api/v1/deals/:id/timeline and
 * /api/v1/deals/:id/completion-form endpoints (routes/dealTimeline.js).
 * fileMeta is the already-uploaded-to-R2 result from uploadFileToStorage
 * (lib/fileUpload.js) — this call only creates the lead_attachments row,
 * it never uploads bytes itself.
 */
import { apiCall } from './client';

export function getTimeline(dealId) {
  return apiCall(`/api/v1/deals/${dealId}/timeline`, { method: 'GET' });
}

export async function uploadCompletionForm(dealId, { url, fileName, contentType, size, key } = {}) {
  const res = await apiCall(`/api/v1/deals/${dealId}/completion-form`, {
    method: 'POST',
    body: {
      file_url: url,
      file_name: fileName,
      file_type: contentType,
      file_size: size,
      storage_key: key,
    },
  });
  return res?.attachment || res;
}
