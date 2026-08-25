/* eslint-disable no-undef */
'use strict';
/**
 * migrationHelpers.js — Shared utilities for all Base44→Railway migration scripts.
 *
 * ARCHITECTURE
 *   Railway migration script → HTTP POST → Base44 backend function (migrationReader)
 *   → base44.asServiceRole (bypasses RLS) → entity records → Railway Postgres.
 *
 * AUTH MECHANISM
 *   The Base44 REST API requires a user access_token (obtained via email/password
 *   login or Google SSO). Yaron's canonical account uses Google SSO exclusively
 *   and has no password. Creating a password just for migration is not acceptable.
 *
 *   Instead, we use the platform's official service-role mechanism:
 *   - The `migrationReader` backend function runs inside Base44's hosted environment.
 *   - It uses `base44.asServiceRole` which bypasses ALL RLS — no user token needed.
 *   - It authenticates external callers via WORKER_SECRET (shared secret header).
 *   - WORKER_SECRET is already set in both Base44 (Deno.env.get) and Railway
 *     (process.env), since the existing cronJobs route already uses it.
 *
 *   This means:
 *   - No user password required (Google SSO is irrelevant)
 *   - No Google OAuth token exchange required
 *   - No operator authorization required (WORKER_SECRET already exists)
 *   - Read-only by design (the function only supports read_entity)
 *   - Temporary (delete the function after migration)
 *
 * ENDPOINT
 *   https://crm-ec-construction-group.base44.app/functions/migrationReader
 *   (configurable via BASE44_FUNCTIONS_URL env var)
 *
 * Provides:
 *   - fetchBase44Entity: paginated reader (throws on error)
 *   - countBase44Entity: structured count result for preflight (never throws)
 *   - probeBase44Entity: detailed probe for preflight diagnostics
 *   - buildLeadIdCache, buildDealIdCache, buildExpenseIdCache, buildOwnerCache
 *   - resolveOwnerId
 */
const { query } = require('../db/client');

const BASE44_FUNCTIONS_URL = process.env.BASE44_FUNCTIONS_URL ||
  'https://crm-ec-construction-group.base44.app/functions/migrationReader';
const WORKER_SECRET = process.env.WORKER_SECRET;

function hasBase44Creds() {
  // Auth is via WORKER_SECRET (shared secret with the migrationReader backend function).
  // No user password, no Google SSO, no BASE44_API_KEY needed.
  return !!WORKER_SECRET;
}

/**
 * Call the migrationReader backend function to read a page of entity records.
 * The function uses base44.asServiceRole which bypasses all RLS.
 * @param {string} entity - Entity name (e.g. 'Lead', 'Estimate')
 * @param {number} skip - Pagination skip
 * @param {number} limit - Page size (max 5000)
 * @param {object|null} filter - Optional MongoDB-style filter
 * @returns {Promise<{records: array, count: number, hasMore: boolean}>}
 */
async function callMigrationReader(entity, skip = 0, limit = 500, filter = null) {
  if (!hasBase44Creds()) {
    throw new Error('WORKER_SECRET required for migration reader (set in Railway Variables)');
  }

  const res = await fetch(BASE44_FUNCTIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-secret': WORKER_SECRET,
    },
    body: JSON.stringify({
      action: 'read_entity',
      entity,
      skip,
      limit,
      sort: '-created_date',
      ...(filter ? { filter } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Migration reader HTTP ${res.status} ${res.statusText} for ${entity} (skip ${skip}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.success) {
    const errMsg = data.error?.message || data.error?.code || 'unknown error';
    throw new Error(`Migration reader error for ${entity}: ${errMsg}`);
  }

  // okResponse wraps payload in data.data — extract from there
  const payload = data.data || {};
  return {
    records: payload.records || [],
    count: payload.count || 0,
    hasMore: !!payload.hasMore,
  };
}

/**
 * Fetch all records for an entity from Base44 via the migrationReader function.
 * Paginates automatically (skip-based, up to 5000 per page).
 * THROWS on any error — callers must handle.
 */
async function fetchBase44Entity(entityName, limit = 500) {
  if (!hasBase44Creds()) {
    throw new Error('WORKER_SECRET required for migration reader');
  }
  const all = [];
  let skip = 0;
  let page = 0;
  while (true) {
    page++;
    const result = await callMigrationReader(entityName, skip, limit);
    all.push(...result.records);
    if (!result.hasMore) break;
    skip += limit;
    if (page > 1000) throw new Error(`Pagination safety limit exceeded for ${entityName}`);
  }
  return all;
}

/**
 * Structured count result for preflight.
 * Returns { count, status, error, httpStatus } where:
 *   status = 'ok' (read succeeded, count is real)
 *   status = 'zero' (read succeeded, count is genuinely 0)
 *   status = 'error' (read failed — count is NOT real, must fail closed)
 *   status = 'no_creds' (WORKER_SECRET missing)
 * NEVER throws — always returns a structured result.
 */
async function countBase44Entity(entityName) {
  if (!hasBase44Creds()) {
    return { count: null, status: 'no_creds', error: 'WORKER_SECRET not set', httpStatus: null };
  }
  try {
    // Probe with limit=1 to check if any records exist
    const probe = await callMigrationReader(entityName, 0, 1);
    if (probe.records.length === 0) {
      return { count: 0, status: 'zero', error: null, httpStatus: 200 };
    }
    // At least 1 record — fetch all to get accurate count
    const all = await fetchBase44Entity(entityName);
    return { count: all.length, status: 'ok', error: null, httpStatus: 200 };
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
    return { reachable: false, httpStatus: null, firstRecordId: null, error: 'WORKER_SECRET not set', url: BASE44_FUNCTIONS_URL };
  }
  try {
    const result = await callMigrationReader(entityName, 0, 1);
    return {
      reachable: true,
      httpStatus: 200,
      firstRecordId: result.records[0]?.id || null,
      error: null,
      url: BASE44_FUNCTIONS_URL,
    };
  } catch (e) {
    return { reachable: false, httpStatus: null, firstRecordId: null, error: e.message, url: BASE44_FUNCTIONS_URL };
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
  BASE44_FUNCTIONS_URL, WORKER_SECRET,
  hasBase44Creds, callMigrationReader,
  fetchBase44Entity, countBase44Entity, probeBase44Entity,
  buildLeadIdCache, buildDealIdCache, buildExpenseIdCache, buildOwnerCache,
  resolveOwnerId, OWNER_ALIASES,
};