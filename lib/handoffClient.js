/* eslint-disable no-undef */
/**
 * handoffClient — Official Handoff REST API client for Railway.
 *
 *   Base URL:  https://api.handoff.ai/core/api/v1/integrations
 *   Auth:      X-API-Key: <hnd_...>   (HANDOFF_API_KEY env var or app_settings)
 *
 *   getApiKey()                    — read key from app_settings or HANDOFF_API_KEY env
 *   fetchEstimates(apiKey)        — GET /estimates (paginated, normalized)
 *   fetchEstimateDetails(id, key) — GET /estimates/:id (with nested line items)
 *   fetchProjects(apiKey)         — GET /projects
 *   fetchContacts(apiKey)         — GET /contacts
 *   checkAuth(apiKey)             — verify key works (GET /estimates?limit=1)
 *   matchEstimateToLead(est, lead) — { match, method } phone/email/name match
 *   matchProjectToLead(proj, lead) — { match, method } phone/email/name/address match
 *   matchContactToLead(ct, lead)   — { match, method } phone/email/name match
 *
 * No GraphQL. No proxy workaround. No Base44. No legacy HANDOFF_AUTH_TOKEN.
 * API key is NEVER logged or returned in any response.
 */
'use strict';

const { query } = require('../db/client');

const DEFAULT_REST_BASE_URL = 'https://api.handoff.ai/core/api/v1/integrations';
const REST_BASE_URL = process.env.HANDOFF_REST_BASE_URL || DEFAULT_REST_BASE_URL;
const MAX_PAGES = 50; // Safety limit for pagination

// ── API key management ──────────────────────────────────────────────────

/**
 * Read the Handoff API key from app_settings or HANDOFF_API_KEY env var.
 * Throws OFFICIAL_API_KEY_REQUIRED if no key is configured.
 * @returns {Promise<string>} The API key (never logged)
 */
async function getApiKey() {
  // 1. Try database (app_settings table)
  try {
    const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', ['handoff_api_key']);
    if (rows[0]) {
      const rawVal = rows[0].value;
      const keyData = typeof rawVal === 'string' ? JSON.parse(rawVal || '{}') : (rawVal || {});
      if (keyData.api_key) return keyData.api_key;
    }
  } catch (e) {
    console.warn('[handoffClient] DB key read failed:', e.message);
  }

  // 2. Fall back to env var
  const envKey = process.env.HANDOFF_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  // 3. No key available — clear missing-key error state
  throw new Error('OFFICIAL_API_KEY_REQUIRED: No Handoff API key in app_settings or HANDOFF_API_KEY env var');
}

// ── REST request helper with retry ──────────────────────────────────────

/**
 * Internal: make a REST request with X-API-Key auth and retry logic.
 * Never logs the API key. Retries on 429 and 5xx, not on 401/403/404.
 */
async function restRequest(path, apiKey, options) {
  options = options || {};
  const url = REST_BASE_URL + path;
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
  if (options.headers) Object.assign(headers, options.headers);

  const maxRetries = options.retries != null ? options.retries : 2;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers: headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await res.json();
        }
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { raw: text }; }
      }

      const txt = await res.text();

      // Auth errors — never retry
      if (res.status === 401 || res.status === 403) {
        throw new Error('AUTH_DENIED: Handoff API returned ' + res.status + ': ' + txt.slice(0, 200));
      }

      // Not found — never retry
      if (res.status === 404) {
        throw new Error('NOT_FOUND: ' + path + ' (' + txt.slice(0, 100) + ')');
      }

      // Rate limited — retry with backoff
      if (res.status === 429) {
        if (attempt < maxRetries) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
          await new Promise(function (r) { setTimeout(r, Math.min(retryAfter, 30) * 1000); });
          continue;
        }
        throw new Error('RATE_LIMITED: Handoff API rate limit exceeded');
      }

      // Server error — retry with exponential backoff
      if (res.status >= 500) {
        if (attempt < maxRetries) {
          await new Promise(function (r) { setTimeout(r, 1000 * Math.pow(2, attempt)); });
          continue;
        }
        throw new Error('TRANSIENT: Handoff API server error ' + res.status + ': ' + txt.slice(0, 200));
      }

      // Other client errors
      throw new Error('Handoff API error ' + res.status + ': ' + txt.slice(0, 300));
    } catch (e) {
      // Non-retryable errors — throw immediately
      if (e.message && (e.message.startsWith('AUTH_DENIED') || e.message.startsWith('NOT_FOUND') || e.message.startsWith('OFFICIAL_API_KEY_REQUIRED'))) {
        throw e;
      }
      lastError = e;
      // Network errors — retry with backoff
      if (attempt < maxRetries) {
        await new Promise(function (r) { setTimeout(r, 1000 * Math.pow(2, attempt)); });
        continue;
      }
    }
  }

  throw lastError || new Error('REQUEST_FAILED: ' + path);
}

// ── Response normalization (pure functions, testable without DB/API) ─────

/**
 * Extract an array of items from various REST response formats.
 * Handles: bare array, { data: [...] }, { items: [...] }, { results: [...] },
 * { estimates: [...] }, { projects: [...] }, { contacts: [...] }
 */
function extractArray(rawResponse) {
  if (Array.isArray(rawResponse)) return rawResponse;
  if (rawResponse && typeof rawResponse === 'object') {
    if (Array.isArray(rawResponse.data)) return rawResponse.data;
    if (Array.isArray(rawResponse.items)) return rawResponse.items;
    if (Array.isArray(rawResponse.results)) return rawResponse.results;
    if (Array.isArray(rawResponse.estimates)) return rawResponse.estimates;
    if (Array.isArray(rawResponse.projects)) return rawResponse.projects;
    if (Array.isArray(rawResponse.contacts)) return rawResponse.contacts;
    // Single object — wrap in array (for detail endpoints)
    if (rawResponse.id || rawResponse._id) return [rawResponse];
  }
  return [];
}

/**
 * Extract pagination cursor from a REST response.
 * Handles: nextCursor, cursor, nextPageToken, pagination.cursor
 */
function extractCursor(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'object') return null;
  return rawResponse.nextCursor || rawResponse.cursor || rawResponse.nextPageToken ||
    (rawResponse.pagination && rawResponse.pagination.cursor) || null;
}

/**
 * Normalize a raw estimate object to the CRM's flattened format.
 * Resilient to field name variations in the REST API response.
 */
function normalizeEstimate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var contact = raw.contact || raw.customer || raw.client || {};
  var proposal = raw.proposal || raw.document || {};

  // Total: try cents fields first, then plain total
  var total = 0;
  if (raw.totalUsdCents != null) total = raw.totalUsdCents / 100;
  else if (raw.totalCents != null) total = raw.totalCents / 100;
  else if (raw.total != null) total = Number(raw.total);
  else if (raw.amount != null) total = Number(raw.amount);

  return {
    id: String(raw.id || raw._id || raw.estimateId || raw.estimate_id || ''),
    name: raw.name || raw.title || raw.estimateName || raw.estimate_number || '',
    state: raw.state || raw.status || '',
    total: total,
    createdAt: raw.createdAt || raw.created_at || raw.date || null,
    clientName: contact.name || raw.customerName || raw.clientName || raw.customer_name || '',
    clientPhone: contact.phoneNumber || contact.phone || raw.customerPhone || raw.customer_phone || '',
    clientEmail: contact.email || raw.customerEmail || raw.customer_email || '',
    proposalLink: proposal.publicLink || proposal.url || raw.proposalLink || raw.document_url || null,
    lineItems: raw.lineItems || raw.line_items || raw.items || null,
    projectId: raw.projectId || raw.project_id || (raw.project && raw.project.id) || null,
    projectName: raw.projectName || (raw.project && raw.project.name) || (raw.project && raw.project.number) || null,
  };
}

/**
 * Normalize a raw project object to the CRM's flattened format.
 */
function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var contact = raw.contact || raw.customer || raw.client || {};
  return {
    id: String(raw.id || raw._id || raw.projectId || raw.project_id || ''),
    number: raw.number || raw.projectNumber || raw.project_number || '',
    name: raw.name || raw.title || raw.projectName || '',
    state: raw.state || raw.status || '',
    createdAt: raw.createdAt || raw.created_at || raw.date || null,
    clientName: contact.name || raw.customerName || raw.clientName || '',
    clientPhone: contact.phoneNumber || contact.phone || raw.customerPhone || '',
    clientEmail: contact.email || raw.customerEmail || '',
    address: raw.address || raw.propertyAddress || raw.property_address || raw.location || '',
  };
}

/**
 * Normalize a raw contact object to the CRM's flattened format.
 */
function normalizeContact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(raw.id || raw._id || raw.contactId || raw.contact_id || ''),
    name: raw.name || raw.fullName || raw.full_name || '',
    email: raw.email || '',
    phone: raw.phone || raw.phoneNumber || raw.phone_number || '',
    address: raw.address || raw.propertyAddress || raw.property_address || '',
    createdAt: raw.createdAt || raw.created_at || null,
  };
}

// ── REST API methods ─────────────────────────────────────────────────────

/**
 * Fetch all estimates from the Handoff REST API (paginated).
 * @param {string} apiKey — hnd_ API key
 * @returns {Promise<Array>} flattened, normalized estimate objects
 */
async function fetchEstimates(apiKey) {
  var all = [];
  var cursor = null;
  var pageCount = 0;

  do {
    var path = cursor ? '/estimates?cursor=' + encodeURIComponent(cursor) : '/estimates';
    var data = await restRequest(path, apiKey);
    var items = extractArray(data);
    for (var i = 0; i < items.length; i++) {
      var norm = normalizeEstimate(items[i]);
      if (norm) all.push(norm);
    }
    cursor = extractCursor(data);
    pageCount++;
  } while (cursor && pageCount < MAX_PAGES);

  return all;
}

/**
 * Fetch a single estimate with nested line items.
 * @param {string} estimateId
 * @param {string} apiKey
 * @returns {Promise<Object>} normalized estimate with lineItems
 */
async function fetchEstimateDetails(estimateId, apiKey) {
  var data = await restRequest('/estimates/' + encodeURIComponent(estimateId), apiKey);
  return normalizeEstimate(data);
}

/**
 * Fetch all projects from the Handoff REST API (paginated).
 */
async function fetchProjects(apiKey) {
  var all = [];
  var cursor = null;
  var pageCount = 0;

  do {
    var path = cursor ? '/projects?cursor=' + encodeURIComponent(cursor) : '/projects';
    var data = await restRequest(path, apiKey);
    var items = extractArray(data);
    for (var i = 0; i < items.length; i++) {
      var norm = normalizeProject(items[i]);
      if (norm) all.push(norm);
    }
    cursor = extractCursor(data);
    pageCount++;
  } while (cursor && pageCount < MAX_PAGES);

  return all;
}

/**
 * Fetch all contacts from the Handoff REST API (paginated).
 */
async function fetchContacts(apiKey) {
  var all = [];
  var cursor = null;
  var pageCount = 0;

  do {
    var path = cursor ? '/contacts?cursor=' + encodeURIComponent(cursor) : '/contacts';
    var data = await restRequest(path, apiKey);
    var items = extractArray(data);
    for (var i = 0; i < items.length; i++) {
      var norm = normalizeContact(items[i]);
      if (norm) all.push(norm);
    }
    cursor = extractCursor(data);
    pageCount++;
  } while (cursor && pageCount < MAX_PAGES);

  return all;
}

/**
 * Verify the API key works by making a lightweight request.
 * @returns {{ connected: boolean, reason?: string, warning?: string }}
 */
async function checkAuth(apiKey) {
  try {
    await restRequest('/estimates?limit=1', apiKey, { retries: 0 });
    return { connected: true };
  } catch (e) {
    if (e.message && e.message.startsWith('AUTH_DENIED')) {
      return { connected: false, reason: 'invalid_key' };
    }
    // Other errors (rate limit, server error) — key might still be valid
    return { connected: true, warning: e.message };
  }
}

// ── Lead matching (preserved from GraphQL version — unchanged) ───────────

var normPhone = function (p) { return (p || '').replace(/\D/g, '').slice(-10); };
var normEmail = function (e) { return (e || '').toLowerCase().trim(); };
var normName = function (n) { return (n || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z\s]/g, ''); };

/**
 * Match an estimate to a lead by phone, email, or name.
 * @returns {{ match: boolean, method: string }}
 */
function matchEstimateToLead(est, lead) {
  var leadPhone = normPhone(lead.phone);
  var leadEmail = normEmail(lead.email);
  var leadName = normName((lead.first_name || '') + ' ' + (lead.last_name || ''));

  var estPhone = normPhone(est.clientPhone || '');
  var estEmail = normEmail(est.clientEmail || '');
  var estName = normName(est.clientName || '');

  if (estPhone && leadPhone && estPhone === leadPhone) return { match: true, method: 'name_phone' };
  if (estEmail && leadEmail && estEmail === leadEmail) return { match: true, method: 'name_email' };
  if (estName && leadName && estName === leadName) return { match: true, method: 'name_exact' };

  if (estName && leadName) {
    var ep = estName.split(' '), lp = leadName.split(' ');
    if (ep.length >= 2 && lp.length >= 2 && ep[0] === lp[0] && ep[ep.length - 1] === lp[lp.length - 1]) {
      return { match: true, method: 'name_parts' };
    }
    if (ep[ep.length - 1] && ep[ep.length - 1] === lp[lp.length - 1] && ep[ep.length - 1].length > 2) {
      return { match: true, method: 'name_last' };
    }
  }

  return { match: false, method: 'none' };
}

/**
 * Match a project to a lead by phone, email, name, or address.
 */
function matchProjectToLead(proj, lead) {
  var leadPhone = normPhone(lead.phone);
  var leadEmail = normEmail(lead.email);
  var leadName = normName((lead.first_name || '') + ' ' + (lead.last_name || ''));
  var leadAddress = (lead.property_address || '').toLowerCase().trim();

  var projPhone = normPhone(proj.clientPhone || '');
  var projEmail = normEmail(proj.clientEmail || '');
  var projName = normName(proj.clientName || '');
  var projAddress = (proj.address || '').toLowerCase().trim();

  if (projPhone && leadPhone && projPhone === leadPhone) return { match: true, method: 'name_phone' };
  if (projEmail && leadEmail && projEmail === leadEmail) return { match: true, method: 'name_email' };
  if (projName && leadName && projName === leadName) return { match: true, method: 'name_exact' };
  if (projAddress && leadAddress && (projAddress.indexOf(leadAddress) >= 0 || leadAddress.indexOf(projAddress) >= 0)) {
    return { match: true, method: 'address' };
  }

  return { match: false, method: 'none' };
}

/**
 * Match a contact to a lead by phone, email, or name.
 */
function matchContactToLead(contact, lead) {
  var leadPhone = normPhone(lead.phone);
  var leadEmail = normEmail(lead.email);
  var leadName = normName((lead.first_name || '') + ' ' + (lead.last_name || ''));

  var cPhone = normPhone(contact.phone || '');
  var cEmail = normEmail(contact.email || '');
  var cName = normName(contact.name || '');

  if (cPhone && leadPhone && cPhone === leadPhone) return { match: true, method: 'name_phone' };
  if (cEmail && leadEmail && cEmail === leadEmail) return { match: true, method: 'name_email' };
  if (cName && leadName && cName === leadName) return { match: true, method: 'name_exact' };

  return { match: false, method: 'none' };
}

module.exports = {
  getApiKey: getApiKey,
  fetchEstimates: fetchEstimates,
  fetchEstimateDetails: fetchEstimateDetails,
  fetchProjects: fetchProjects,
  fetchContacts: fetchContacts,
  checkAuth: checkAuth,
  matchEstimateToLead: matchEstimateToLead,
  matchProjectToLead: matchProjectToLead,
  matchContactToLead: matchContactToLead,
  // Pure functions (exported for testing)
  extractArray: extractArray,
  extractCursor: extractCursor,
  normalizeEstimate: normalizeEstimate,
  normalizeProject: normalizeProject,
  normalizeContact: normalizeContact,
  REST_BASE_URL: REST_BASE_URL,
};