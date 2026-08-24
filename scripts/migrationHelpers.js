/* eslint-disable no-undef */
'use strict';
/**
 * migrationHelpers.js — Shared utilities for all Base44→Railway migration scripts.
 *
 * CRITICAL FIX: The Base44 REST API endpoint is:
 *   https://base44.app/api/apps/${appId}/entities/${entityName}
 *
 * The SDK (@base44/sdk) uses:
 *   - Axios baseURL: https://base44.app/api  (the /api prefix is REQUIRED)
 *   - Entity path: /apps/${appId}/entities/${entityName}  (relative to /api)
 *   - Pagination: ?limit=N&skip=N&sort=-created_date  (NOT "offset")
 *   - Auth: Authorization: Bearer ${token}
 *   - App ID header: X-App-Id: ${appId}  (REQUIRED — SDK sets this on every request)
 *
 * countBase44Entity now returns a structured result { count, status, error, httpStatus }
 * so the preflight can distinguish TRUE ZERO from FAILED/UNAUTHORIZED/WRONG APP.
 *
 * Provides:
 *   - fetchBase44Entity: paginated Base44 REST API reader (throws on error)
 *   - countBase44Entity: structured count result for preflight (never throws)
 *   - probeBase44Entity: detailed probe for preflight diagnostics
 *   - buildLeadIdCache, buildDealIdCache, buildExpenseIdCache, buildOwnerCache
 *   - resolveOwnerId
 */
const { query } = require('../db/client');

const BASE44_API_URL = process.env.BASE44_API_URL || 'https://base44.app';
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;

function hasBase44Creds() {
  return !!(BASE44_APP_ID && BASE44_API_KEY);
}

/**
 * Build the correct Base44 REST API URL for an entity.
 * Format: https://base44.app/api/apps/${appId}/entities/${entityName}
 * The /api prefix is REQUIRED — the SDK's axios client uses baseURL: ${serverUrl}/api.
 */
function buildEntityUrl(entityName) {
  return `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/entities/${entityName}`;
}

/**
 * Standard auth headers for all Base44 REST API requests.
 * The SDK sets X-App-Id on every request — the API requires it.
 */
function base44Headers() {
  return {
    'Authorization': `Bearer ${BASE44_API_KEY}`,
    'X-App-Id': String(BASE44_APP_ID),
  };
}

/**
 * Fetch all records for an entity from Base44 via REST API.
 * Uses correct pagination (skip, not offset).
 * THROWS on any error — callers must handle.
 */
async function fetchBase44Entity(entityName, limit = 500) {
  if (!hasBase44Creds()) throw new Error('BASE44_APP_ID and BASE44_API_KEY required');
  const all = [];
  let skip = 0;
  let page = 0;
  while (true) {
    page++;
    const url = `${buildEntityUrl(entityName)}?limit=${limit}&skip=${skip}&sort=-created_date`;
    const res = await fetch(url, {
      headers: base44Headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Base44 API ${res.status} ${res.statusText} for ${entityName} (page ${page}, skip ${skip}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.items || []);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    skip += limit;
  }
  return all;
}

/**
 * Structured count result for preflight.
 * Returns { count, status, error, httpStatus } where:
 *   status = 'ok' (read succeeded, count is real)
 *   status = 'zero' (read succeeded, count is genuinely 0)
 *   status = 'error' (read failed — count is NOT real, must fail closed)
 *   status = 'no_creds' (credentials missing)
 * NEVER throws — always returns a structured result.
 */
async function countBase44Entity(entityName) {
  if (!hasBase44Creds()) {
    return { count: null, status: 'no_creds', error: 'BASE44_APP_ID and BASE44_API_KEY not set', httpStatus: null };
  }
  try {
    // Fetch with limit=1 to probe — then fetch full to get accurate count
    const url = `${buildEntityUrl(entityName)}?limit=1&skip=0&sort=-created_date`;
    const res = await fetch(url, {
      headers: base44Headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        count: null,
        status: 'error',
        error: `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 150)}`,
        httpStatus: res.status,
      };
    }
    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.items || []);
    if (batch.length === 0) {
      return { count: 0, status: 'zero', error: null, httpStatus: res.status };
    }
    // There's at least 1 record — fetch all to get accurate count
    const all = await fetchBase44Entity(entityName);
    return { count: all.length, status: 'ok', error: null, httpStatus: res.status };
  } catch (e) {
    return { count: null, status: 'error', error: e.message, httpStatus: null };
  }
}

/**
 * Detailed probe for preflight diagnostics.
 * Returns { reachable, httpStatus, firstRecordId, error, url } without fetching all records.
 */
async function probeBase44Entity(entityName) {
  if (!hasBase44Creds()) {
    return { reachable: false, httpStatus: null, firstRecordId: null, error: 'no credentials', url: null };
  }
  const url = `${buildEntityUrl(entityName)}?limit=1&skip=0&sort=-created_date`;
  try {
    const res = await fetch(url, {
      headers: base44Headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        reachable: false,
        httpStatus: res.status,
        firstRecordId: null,
        error: `${res.status} ${res.statusText}: ${body.slice(0, 100)}`,
        url,
      };
    }
    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.items || []);
    return {
      reachable: true,
      httpStatus: res.status,
      firstRecordId: batch[0]?.id || null,
      error: null,
      url,
    };
  } catch (e) {
    return { reachable: false, httpStatus: null, firstRecordId: null, error: e.message, url };
  }
}

async function buildLeadIdCache() {
  const { rows } = await query('SELECT id, external_ref FROM leads WHERE external_ref IS NOT NULL');
  const cache = {};
  for (const r of rows) cache[String(r.external_ref)] = r.id;
  return cache;
}

async function buildDealIdCache() {
  const { rows } = await query('SELECT id, legacy_base44_id FROM deals WHERE legacy_base44_id IS NOT NULL');
  const cache = {};
  for (const r of rows) cache[String(r.legacy_base44_id)] = r.id;
  return cache;
}

async function buildExpenseIdCache() {
  const { rows } = await query('SELECT id, external_ref FROM deal_expenses WHERE external_ref IS NOT NULL');
  const cache = {};
  for (const r of rows) cache[String(r.external_ref)] = r.id;
  return cache;
}

async function buildOwnerCache() {
  const { rows } = await query('SELECT id, display_name, email FROM owners WHERE is_active = true');
  const cache = {};
  for (const r of rows) {
    const nameKey = (r.display_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (nameKey) cache[nameKey] = r.id;
    if (r.email) cache[r.email.toLowerCase()] = r.id;
  }
  return cache;
}

// ── Legacy owner alias mapping ──────────────────────────────────────────────
// Some Base44 leads may have short-form assigned_rep values (e.g. "Yaron" instead
// of "Yaron Drilevich"). This deterministic map ensures they resolve correctly
// to the full-name owner in the Railway owners table. No silent fallback —
// only explicit, deterministic aliases defined here.
const OWNER_ALIASES = {
  'yaron': 'yaron drilevich',
  'michelle': 'michelle roitman drilevich',
};

function resolveOwnerId(assignedRep, ownerCache) {
  if (!assignedRep) return null;
  const key = String(assignedRep).toLowerCase().replace(/\s+/g, ' ').trim();
  // Check direct match first, then alias mapping
  if (ownerCache[key]) return ownerCache[key];
  const alias = OWNER_ALIASES[key];
  if (alias && ownerCache[alias]) return ownerCache[alias];
  return null;
}

module.exports = {
  BASE44_API_URL, BASE44_APP_ID, BASE44_API_KEY,
  hasBase44Creds, buildEntityUrl, base44Headers,
  fetchBase44Entity, countBase44Entity, probeBase44Entity,
  buildLeadIdCache, buildDealIdCache, buildExpenseIdCache, buildOwnerCache,
  resolveOwnerId, OWNER_ALIASES,
};