#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * diagnoseBase44Access.js — READ-ONLY diagnostic of the exact Base44 REST API
 * request made from the Railway runtime.
 *
 * Performs ONE GET request (limit=1) for the Lead entity and prints every
 * detail of the outgoing request and incoming response.
 *
 * DOES NOT WRITE. DOES NOT MODIFY ANY DATA. DOES NOT TOUCH THE DATABASE.
 *
 * Usage: node scripts/diagnoseBase44Access.js
 *
 * Output is safe to share — BASE44_API_KEY is never printed.
 */

// ── Environment variables (read directly, NOT through helpers, to prove
//    exactly what Railway provides to the process) ──────────────────────────
const RAW_BASE44_API_URL = process.env.BASE44_API_URL;
const RAW_BASE44_APP_ID = process.env.BASE44_APP_ID;
const RAW_BASE44_API_KEY = process.env.BASE44_API_KEY;

// ── Normalize (same logic as migrationHelpers, duplicated here to prove
//    the exact transformation) ──────────────────────────────────────────────
function normalizeBase44Url(url) {
  if (!url) return 'https://base44.app';
  let cleaned = String(url).trim().replace(/\/+$/, '');
  if (cleaned.endsWith('/api')) {
    cleaned = cleaned.slice(0, -4);
  }
  return cleaned;
}

const NORMALIZED_API_URL = normalizeBase44Url(RAW_BASE44_API_URL);
const ENTITY_URL = `${NORMALIZED_API_URL}/api/apps/${RAW_BASE44_APP_ID}/entities/Lead`;
const EXPECTED_URL = 'https://base44.app/api/apps/69f42cee41d29f30bff5c013/entities/Lead';

// ── Header construction (same as migrationHelpers) ────────────────────────
const headers = {
  'Authorization': `Bearer ${RAW_BASE44_API_KEY}`,
  'X-App-Id': String(RAW_BASE44_APP_ID),
};

// ── Diagnostic report ───────────────────────────────────────────────────────
async function main() {
  console.log('=== BASE44 REST API ACCESS DIAGNOSTIC (READ-ONLY) ===\n');

  // 1. Effective environment variable values
  console.log('--- 1. EFFECTIVE ENVIRONMENT VARIABLES ---\n');
  console.log(`BASE44_API_URL (raw):        ${RAW_BASE44_API_URL || '(not set — normalizeBase44Url will default to https://base44.app)'}`);
  console.log(`BASE44_API_URL (normalized): ${NORMALIZED_API_URL}`);
  console.log(`BASE44_APP_ID:               ${RAW_BASE44_APP_ID || '(NOT SET ❌)'}`);
  console.log(`BASE44_API_KEY set:          ${RAW_BASE44_API_KEY ? 'YES ✅' : 'NO ❌'}`);
  console.log(`BASE44_API_KEY length:       ${RAW_BASE44_API_KEY ? RAW_BASE44_API_KEY.length : 0}`);
  console.log(`BASE44_API_KEY prefix:       ${RAW_BASE44_API_KEY ? RAW_BASE44_API_KEY.slice(0, 4) + '...' : 'N/A'}`);
  console.log('');

  // 2. Exact URL produced by buildEntityUrl('Lead')
  console.log('--- 2. EXACT URL PRODUCED BY buildEntityUrl("Lead") ---\n');
  console.log(`URL:       ${ENTITY_URL}`);
  console.log(`Expected:  ${EXPECTED_URL}`);
  console.log(`Match:     ${ENTITY_URL === EXPECTED_URL ? 'YES ✅' : 'NO ❌'}`);
  console.log('');

  // 3. URL structure validation
  console.log('--- 3. URL STRUCTURE VALIDATION ---\n');
  const hasOneApi = (ENTITY_URL.match(/\/api\//g) || []).length === 1;
  const hasCorrectAppId = ENTITY_URL.includes('/apps/69f42cee41d29f30bff5c013/');
  const hasNoDuplicateApps = (ENTITY_URL.match(/\/apps\//g) || []).length === 1;
  const hasNoDoubleSlash = !/\/\//.test(ENTITY_URL.replace(/^https?:\/\//, ''));
  const hasNoUndefined = !ENTITY_URL.includes('undefined');
  console.log(`Exactly one /api/:           ${hasOneApi ? 'YES ✅' : 'NO ❌'}`);
  console.log(`Correct app ID in path:      ${hasCorrectAppId ? 'YES ✅' : 'NO ❌'}`);
  console.log(`No duplicate /apps/:         ${hasNoDuplicateApps ? 'YES ✅' : 'NO ❌'}`);
  console.log(`No double slashes:           ${hasNoDoubleSlash ? 'YES ✅' : 'NO ❌'}`);
  console.log(`No 'undefined' in URL:       ${hasNoUndefined ? 'YES ✅' : 'NO ❌'}`);
  console.log('');

  // 4. Header presence
  console.log('--- 4. HEADER PRESENCE ---\n');
  console.log(`Authorization header present: ${headers.Authorization ? 'YES ✅' : 'NO ❌'}`);
  console.log(`Authorization scheme:        ${headers.Authorization ? headers.Authorization.split(' ')[0] : 'N/A'}`);
  console.log(`X-App-Id header present:     ${headers['X-App-Id'] ? 'YES ✅' : 'NO ❌'}`);
  console.log(`X-App-Id value:              ${headers['X-App-Id'] || 'N/A'}`);
  console.log('');

  // 5. READ-ONLY GET request with auth (limit=1)
  console.log('--- 5. READ-ONLY GET REQUEST (with auth, limit=1) ---\n');
  const authedUrl = `${ENTITY_URL}?limit=1&skip=0&sort=-created_date`;
  console.log(`Request URL: ${authedUrl}`);
  console.log('Request headers:');
  console.log(`  Authorization: Bearer ${RAW_BASE44_API_KEY ? '***' : '(missing)'}`);
  console.log(`  X-App-Id: ${headers['X-App-Id'] || '(missing)'}`);
  console.log('');

  try {
    const res = await fetch(authedUrl, { headers });
    const body = await res.text();
    console.log(`HTTP Status:       ${res.status} ${res.statusText}`);
    console.log(`Content-Type:      ${res.headers.get('content-type') || 'N/A'}`);
    console.log(`Response body (first 500 chars):`);
    console.log(body.slice(0, 500) || '(empty)');
    console.log('');
    console.log(`Diagnosis: ${res.status === 200 ? 'SUCCESS ✅ — URL and auth are correct' : res.status === 404 ? '404 NOT FOUND — URL path is wrong (not an auth issue)' : res.status === 401 || res.status === 403 ? `${res.status} AUTH ERROR — URL is correct, but BASE44_API_KEY is not a valid bearer token` : `Unexpected status ${res.status}`}`);
  } catch (e) {
    console.log(`Network error: ${e.message}`);
    console.log('Diagnosis: Cannot reach Base44 API at all — DNS or network issue');
  }
  console.log('');

  // 6. READ-ONLY GET request WITHOUT auth (to distinguish URL issue from auth issue)
  console.log('--- 6. READ-ONLY GET REQUEST (NO auth, limit=1) — URL validation only ---\n');
  console.log(`Request URL: ${authedUrl}`);
  console.log('Request headers: (none — testing URL path only)');
  console.log('');

  try {
    const res = await fetch(authedUrl, { headers: {} });
    const body = await res.text();
    console.log(`HTTP Status:       ${res.status} ${res.statusText}`);
    console.log(`Content-Type:      ${res.headers.get('content-type') || 'N/A'}`);
    console.log(`Response body (first 200 chars):`);
    console.log(body.slice(0, 200) || '(empty)');
    console.log('');
    console.log(`Diagnosis: ${res.status === 404 ? '404 even without auth → URL PATH IS WRONG (the endpoint does not exist at this path)' : res.status === 401 || res.status === 403 ? `${res.status} without auth → URL is CORRECT (endpoint exists), auth is the issue` : `Status ${res.status} without auth`}`);
  } catch (e) {
    console.log(`Network error: ${e.message}`);
  }
  console.log('');

  // 7. Comparison against known-working SDK request
  console.log('--- 7. COMPARISON AGAINST KNOWN-WORKING SDK REQUEST ---\n');
  console.log('The @base44/sdk uses:');
  console.log('  baseURL:    https://base44.app/api');
  console.log('  path:       /apps/${appId}/entities/${entityName}');
  console.log('  full URL:   https://base44.app/api/apps/69f42cee41d29f30bff5c013/entities/Lead');
  console.log('  auth:       Authorization: Bearer ${user_access_token}');
  console.log('  app header: X-App-Id: ${appId}');
  console.log('  pagination: ?limit=N&skip=N&sort=-created_date');
  console.log('');
  console.log(`Migration script URL:  ${ENTITY_URL}`);
  console.log(`SDK URL:               ${EXPECTED_URL}`);
  console.log(`URLs match:            ${ENTITY_URL === EXPECTED_URL ? 'YES ✅' : 'NO ❌ — this is the root cause'}`);
  console.log('');

  // 8. Root cause summary
  console.log('--- 8. ROOT CAUSE SUMMARY ---\n');
  if (!RAW_BASE44_APP_ID) {
    console.log('ROOT CAUSE: BASE44_APP_ID is not set on Railway.');
    console.log('FIX: Set BASE44_APP_ID=69f42cee41d29f30bff5c013 in Railway environment variables.');
  } else if (!RAW_BASE44_API_KEY) {
    console.log('ROOT CAUSE: BASE44_API_KEY is not set on Railway.');
    console.log('FIX: Set BASE44_API_KEY to a valid Base44 user access token in Railway environment variables.');
  } else if (ENTITY_URL !== EXPECTED_URL) {
    console.log('ROOT CAUSE: The URL produced by buildEntityUrl() does not match the known-working SDK URL.');
    console.log(`  Produced:  ${ENTITY_URL}`);
    console.log(`  Expected:  ${EXPECTED_URL}`);
    console.log('FIX: Check BASE44_API_URL and BASE44_APP_ID values on Railway.');
  } else {
    console.log('URL is correct. If the authenticated request returned 401/403, the issue is BASE44_API_KEY.');
    console.log('If the authenticated request returned 404, the URL is wrong despite matching the expected format.');
    console.log('If the authenticated request returned 200, access is working — re-run the preflight.');
  }
  console.log('');

  console.log('=== DIAGNOSTIC COMPLETE — NO WRITES PERFORMED ===');
  process.exit(0);
}

main().catch(e => {
  console.error('Diagnostic fatal:', e);
  process.exit(1);
});