/**
 * fileUpload.js
 *
 * Uploads files securely through the Railway proxy server.
 * The Railway proxy secret is NEVER exposed to the client — it stays server-side.
 *
 * Flow: Browser → Railway proxy /api/files/upload → R2/S3
 */

import { railwayRequest } from '@/lib/railwayClient';

/**
 * Upload a File object to R2/S3 via the Railway proxy.
 * Returns { url, key, fileName, contentType, size }
 * Throws on failure.
 */
export async function uploadFileToStorage(file) {
  // Send the file directly as multipart/form-data to the Railway proxy
  const formData = new FormData();
  formData.append('file', file);

  const API_BASE = import.meta.env.VITE_RAILWAY_API_URL || '';
  const PROXY_SECRET = import.meta.env.VITE_PROXY_SECRET || '';

  const res = await fetch(`${API_BASE}/api/files/upload`, {
    method: 'POST',
    headers: { 'X-Proxy-Secret': PROXY_SECRET },
    body: formData,
  });

  const data = await res.json();
  if (!data || !data.success || data.error) {
    throw new Error(data?.error || 'Upload failed');
  }

  return {
    url: data.url,
    key: data.key,
    fileName: data.fileName,
    contentType: data.contentType,
    size: data.size,
  };
}

/**
 * Check if file upload storage is configured on the proxy.
 * Returns { configured, provider, bucket }
 */
export async function checkUploadStorageStatus() {
  try {
    return await railwayRequest('/api/files/status', { method: 'GET' });
  } catch (e) {
    return { configured: false, error: e.message };
  }
}

/**
 * Safely extract the R2 object key (uploads/YYYY/MM/...) from a stored key or
 * a legacy malformed URL. Returns null when no uploads/ portion is present.
 * Never derives a key from an arbitrary relative URL that lacks uploads/.
 */
export function extractKey(urlOrKey) {
  if (!urlOrKey || typeof urlOrKey !== "string") return null;
  const idx = urlOrKey.indexOf("uploads/");
  if (idx < 0) return null;
  const key = urlOrKey.slice(idx).split("?")[0].split("#")[0];
  return key.startsWith("uploads/") ? key : null;
}

/**
 * Request a short-lived presigned GET URL for one private R2 object.
 * disposition: "inline" (View) or "attachment" (Download).
 */
export async function getSignedFileUrl(key, disposition = "inline") {
  if (!key || !String(key).startsWith("uploads/")) {
    const derived = extractKey(key);
    if (!derived) throw new Error("No receipt object key available.");
    key = derived;
  }
  const data = await railwayRequest('/api/files/signed-url', {
    method: 'POST',
    body: { key, disposition },
  });
  if (!data || data.error || !data.url) {
    throw new Error(data?.error || "Could not generate a receipt link.");
  }
  return data.url;
}

/**
 * Delete one R2 object via the Railway proxy. Accepts a stored key or a legacy
 * URL containing uploads/. Throws on failure.
 */
export async function deleteFileFromStorage(keyOrUrl) {
  const key = typeof keyOrUrl === "string" && keyOrUrl.startsWith("uploads/") ? keyOrUrl : extractKey(keyOrUrl);
  if (!key) {
    throw new Error("No receipt object key to delete.");
  }
  const data = await railwayRequest('/api/files/delete', {
    method: 'DELETE',
    body: { key },
  });
  if (!data || data.error || data.success === false) {
    throw new Error(data?.error || "Receipt file deletion failed.");
  }
  return true;
}