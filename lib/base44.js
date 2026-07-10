/* eslint-disable no-undef */
/**
 * Base44 REST entity helpers — used by the Railway QB sync endpoints.
 *
 * Mirrors base44.asServiceRole.entities.* over the HTTP REST API using the
 * service-role BASE44_API_KEY (bypasses RLS), exactly like the existing
 * /handoff/import-estimate route. No SDK, no Base44 credits.
 *
 * Env (already present on the proxy):
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional, defaults to api.base44.com)
 */
'use strict';

const BASE44_APP_ID  = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;
// The old api.base44.com origin returns a ConnectYourDomain HTML 404 page.
// The correct Base44 API origin is https://base44.app (confirmed from VITE_BASE44_BACKEND_URL).
const _rawApiUrl = process.env.BASE44_API_URL || '';
const BASE44_API_URL = (!_rawApiUrl || _rawApiUrl.includes('api.base44.com'))
  ? 'https://base44.app'
  : _rawApiUrl.replace(/\/$/, '');

function isConfigured() {
  return !!(BASE44_APP_ID && BASE44_API_KEY);
}

function headers() {
  return {
    Authorization: `Bearer ${BASE44_API_KEY}`,
    'X-App-Id': BASE44_APP_ID,
    'Content-Type': 'application/json',
  };
}

async function read(res) {
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const ct = res.headers.get('content-type') || '';
    // Detect HTML error pages (ConnectYourDomain etc.) — don't leak to users
    if (ct.includes('text/html') || t.includes('<!DOCTYPE') || t.includes('<html')) {
      throw new Error('Base44 API returned HTML (non-JSON) — check BASE44_API_URL');
    }
    throw new Error('Base44 ' + res.status + ': ' + t.slice(0, 200));
  }
  const text = await res.text();
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    // REST list/filter returns a bare array (confirmed by existing token-load +
    // import-estimate routes). Be defensive in case a future version wraps it.
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.data)) return data.data;
    return data;
  } catch {
    return [];
  }
}

// List with sort + limit (mirrors SDK .list(sort, limit, skip))
async function list(entity, sort = '-created_date', limit = 2000, skip = 0) {
  const params = new URLSearchParams();
  if (sort) params.set('sort', sort);
  if (limit) params.set('limit', String(limit));
  if (skip) params.set('skip', String(skip));
  const url = `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/entities/${entity}?${params.toString()}`;
  const res = await fetch(url, { headers: headers() });
  return read(res);
}

// Filter: query is a Mongo-style object -> ?filter=<json>
async function filter(entity, query) {
  const params = new URLSearchParams();
  params.set('filter', JSON.stringify(query || {}));
  const url = `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/entities/${entity}?${params.toString()}`;
  const res = await fetch(url, { headers: headers() });
  return read(res);
}

async function get(entity, id) {
  const url = `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/entities/${entity}/${id}`;
  const res = await fetch(url, { headers: headers() });
  return read(res);
}

async function create(entity, body) {
  const url = `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/entities/${entity}`;
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) });
  return read(res);
}

async function update(entity, id, body) {
  const url = `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/entities/${entity}/${id}`;
  const res = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(body || {}) });
  return read(res);
}

module.exports = { isConfigured, headers, list, filter, get, create, update };