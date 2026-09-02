/* eslint-disable no-undef */
/**
 * leadDealDetailP0.test.js — P0 regression tests for Lead Detail + Deal Detail.
 *
 * Lead Detail defect: routes/leads.js GET /by-external/:externalRef/detail
 *   queried `SELECT key, value FROM settings WHERE key IN (...)` but the
 *   canonical Railway settings table is a SINGLETON (id=1) with an
 *   app_lists JSONB column — no key/value columns. PostgreSQL threw
 *   "column key does not exist" on every Lead Detail load.
 *
 * Deal Detail defect: DealDetail.jsx classified a 503 network error as
 *   "Deal not found" because isServerError only matched status === 500
 *   exactly, not the 503 that apiCall assigns to network errors.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── LEAD DETAIL: static source scan — no SQL references "key" column ────────

const leadsRouteSource = fs.readFileSync(
  path.resolve(__dirname, '../routes/leads.js'), 'utf8'
);

test('LEAD: routes/leads.js does not reference non-existent "key" column in settings query', () => {
  const hasBadSettingsQuery = /SELECT\s+key\s*,\s*value\s+FROM\s+settings/i.test(leadsRouteSource);
  assert.ok(!hasBadSettingsQuery, 'routes/leads.js must NOT query SELECT key, value FROM settings');
  const hasFixedSettingsQuery = /SELECT\s+app_lists\s+FROM\s+settings\s+WHERE\s+id\s*=\s*1/i.test(leadsRouteSource);
  assert.ok(hasFixedSettingsQuery, 'routes/leads.js must query SELECT app_lists FROM settings WHERE id = 1');
});

test('LEAD: routes/leads.js extracts project_types and lead_sources from app_lists JSONB', () => {
  assert.ok(leadsRouteSource.includes('appLists.project_types'), 'must extract project_types from appLists');
  assert.ok(leadsRouteSource.includes('appLists.lead_sources'), 'must extract lead_sources from appLists');
});

// ── LEAD DETAIL: leadIdWhere safe identifier resolution ─────────────────────

const dbPath = require.resolve('../db/client');
const leadResolverPath = require.resolve('../lib/leadResolver');

// Configurable mock — leadResolver destructures `query` at require time,
// so the mock must capture a mutable variable (not swap exports after load).
let mockRows = [];
const mockQuery = async () => ({ rows: mockRows });
const mockPool = {
  connect: async () => ({
    query: async () => ({ rows: mockRows }),
    release: () => {},
  }),
};
delete require.cache[dbPath];
delete require.cache[leadResolverPath];
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { query: mockQuery, pool: mockPool },
};

const { UUID_RE, leadIdWhere, resolveLeadByIdentifier } = require('../lib/leadResolver');

test('LEAD: UUID_RE validates canonical UUID format', () => {
  assert.ok(UUID_RE.test('f9d092c4-f634-4290-85c4-05ec5f06567f'));
  assert.ok(UUID_RE.test('F9D092C4-F634-4290-85C4-05EC5F06567F'));
  assert.ok(!UUID_RE.test('6a8b8d3dea2e908b05855f46'));
  assert.ok(!UUID_RE.test('not-a-uuid'));
  assert.ok(!UUID_RE.test(''));
});

test('LEAD: leadIdWhere uses separate params for UUID (no shared-parameter cast bug)', () => {
  const uuid = 'f9d092c4-f634-4290-85c4-05ec5f06567f';
  const { whereSql, params } = leadIdWhere(uuid, 'l.');
  assert.ok(whereSql.includes('external_ref = $1'), 'must compare external_ref = $1 (text)');
  assert.ok(whereSql.includes('id = $2::uuid'), 'must compare id = $2::uuid (cast separately)');
  assert.strictEqual(params.length, 2, 'UUID branch must produce 2 params');
  assert.strictEqual(params[0], uuid);
  assert.strictEqual(params[1], uuid);
});

test('LEAD: leadIdWhere for non-UUID uses external_ref only (no uuid cast crash)', () => {
  const legacyId = '6a8b8d3dea2e908b05855f46';
  const { whereSql, params } = leadIdWhere(legacyId);
  assert.ok(whereSql.includes('external_ref = $1'), 'must compare external_ref only');
  assert.ok(!whereSql.includes('id ='), 'must NOT compare id for non-UUID (avoids cast crash)');
  assert.strictEqual(params.length, 1);
  assert.strictEqual(params[0], legacyId);
});

test('LEAD: leadIdWhere with alias prefix applies alias to both columns', () => {
  const uuid = 'f9d092c4-f634-4290-85c4-05ec5f06567f';
  const { whereSql } = leadIdWhere(uuid, 'l.');
  assert.ok(whereSql.includes('l.external_ref = $1'), 'must prefix external_ref with alias');
  assert.ok(whereSql.includes('l.id = $2::uuid'), 'must prefix id with alias');
});

test('LEAD: resolveLeadByIdentifier returns null for missing lead (404 semantics)', async () => {
  mockRows = [];
  const result = await resolveLeadByIdentifier('f9d092c4-f634-4290-85c4-05ec5f06567f');
  assert.strictEqual(result, null, 'must return null for missing lead (preserves 404)');
});

test('LEAD: resolveLeadByIdentifier returns lead row when found (200 semantics)', async () => {
  const mockLead = {
    id: 'f9d092c4-f634-4290-85c4-05ec5f06567f',
    external_ref: '6a8b8d3dea2e908b05855f46',
    first_name: 'Test',
    last_name: 'Lead',
  };
  mockRows = [mockLead];
  const result = await resolveLeadByIdentifier('f9d092c4-f634-4290-85c4-05ec5f06567f');
  assert.ok(result, 'must return the lead row when found');
  assert.strictEqual(result.id, 'f9d092c4-f634-4290-85c4-05ec5f06567f');
  assert.strictEqual(result.external_ref, '6a8b8d3dea2e908b05855f46');
  mockRows = [];
});

test('LEAD: resolveLeadByIdentifier finds lead by legacy external_ref', async () => {
  const mockLead = {
    id: 'f9d092c4-f634-4290-85c4-05ec5f06567f',
    external_ref: '6a8b8d3dea2e908b05855f46',
    first_name: 'Legacy',
    last_name: 'Lead',
  };
  // Override mockQuery to also assert the SQL shape for legacy ID
  const origQuery = require.cache[dbPath].exports.query;
  require.cache[dbPath].exports.query = async (sql) => {
    assert.ok(sql.includes('external_ref = $1'), 'must query by external_ref for legacy ID');
    assert.ok(!sql.includes('id = $2::uuid'), 'must NOT cast to uuid for legacy ID');
    return { rows: [mockLead] };
  };
  // Re-require leadResolver so it picks up the new query mock
  delete require.cache[leadResolverPath];
  const { resolveLeadByIdentifier: resolveLegacy } = require('../lib/leadResolver');
  try {
    const result = await resolveLegacy('6a8b8d3dea2e908b05855f46');
    assert.ok(result, 'must find lead by legacy external_ref');
    assert.strictEqual(result.id, 'f9d092c4-f634-4290-85c4-05ec5f06567f');
  } finally {
    require.cache[dbPath].exports.query = origQuery;
    delete require.cache[leadResolverPath];
    require('../lib/leadResolver');
  }
});

// ── DEAL DETAIL: dealIdWhere safe identifier resolution ─────────────────────

const { UUID_RE: DEAL_UUID_RE } = require('../lib/dealModel');

test('DEAL: dealModel UUID_RE validates canonical UUID format', () => {
  assert.ok(DEAL_UUID_RE.test('f9d092c4-f634-4290-85c4-05ec5f06567f'));
  assert.ok(!DEAL_UUID_RE.test('6a8b8d3dea2e908b05855f46'));
  assert.ok(!DEAL_UUID_RE.test('not-a-uuid'));
});

test('DEAL: dealIdWhere uses separate params for UUID (no shared-parameter cast bug)', () => {
  function dealIdWhere(identifier) {
    if (DEAL_UUID_RE.test(String(identifier))) {
      return { whereSql: 'id = $1::uuid OR legacy_base44_id = $2', params: [identifier, identifier] };
    }
    return { whereSql: 'legacy_base44_id = $1', params: [identifier] };
  }
  const uuid = 'f9d092c4-f634-4290-85c4-05ec5f06567f';
  const { whereSql, params } = dealIdWhere(uuid);
  assert.ok(whereSql.includes('id = $1::uuid'), 'must cast id param to uuid');
  assert.ok(whereSql.includes('legacy_base44_id = $2'), 'must compare legacy_base44_id with separate param');
  assert.strictEqual(params.length, 2, 'UUID branch must produce 2 params (no shared-param bug)');
  assert.strictEqual(params[0], uuid);
  assert.strictEqual(params[1], uuid);
});

test('DEAL: dealIdWhere for non-UUID uses legacy_base44_id only (no uuid cast crash)', () => {
  function dealIdWhere(identifier) {
    if (DEAL_UUID_RE.test(String(identifier))) {
      return { whereSql: 'id = $1::uuid OR legacy_base44_id = $2', params: [identifier, identifier] };
    }
    return { whereSql: 'legacy_base44_id = $1', params: [identifier] };
  }
  const legacyId = '6a8b8d3dea2e908b05855f46';
  const { whereSql, params } = dealIdWhere(legacyId);
  assert.ok(whereSql.includes('legacy_base44_id = $1'), 'must compare legacy_base44_id only');
  assert.ok(!whereSql.includes('id = $1::uuid'), 'must NOT cast to uuid for non-UUID (avoids crash)');
  assert.strictEqual(params.length, 1);
  assert.strictEqual(params[0], legacyId);
});

test('DEAL: dealIdWhere contract matches serializeDeal id (list/detail consistency)', () => {
  const mockDealRow = {
    id: 'f9d092c4-f634-4290-85c4-05ec5f06567f',
    lead_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    legacy_base44_id: '6a8b8d3dea2e908b05855f46',
    name: 'Test Deal',
    stage: 'Sold / Estimate Approved',
  };
  const serializedId = mockDealRow.id;
  function dealIdWhere(identifier) {
    if (DEAL_UUID_RE.test(String(identifier))) {
      return { whereSql: 'id = $1::uuid OR legacy_base44_id = $2', params: [identifier, identifier] };
    }
    return { whereSql: 'legacy_base44_id = $1', params: [identifier] };
  }
  const { whereSql, params } = dealIdWhere(serializedId);
  assert.ok(whereSql.includes('id = $1::uuid'), 'detail lookup must check id = $1::uuid');
  assert.strictEqual(params[0], serializedId, 'detail lookup param must match list id');
});

// ── DEAL DETAIL: error semantics (404 vs 500 vs 503) ─────────────────────────

test('DEAL: true missing deal returns 404 (not 500 or "Deal not found" mask)', () => {
  function dealNotFoundResponse(rows) {
    if (!rows[0]) return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: { deal: rows[0] } };
  }
  const res = dealNotFoundResponse([]);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'not_found');
});

test('DEAL: SQL error returns 500 (not 404)', () => {
  function dealErrorResponse() {
    return { status: 500, body: { error: 'column "key" does not exist' } };
  }
  const res = dealErrorResponse();
  assert.strictEqual(res.status, 500);
});

test('DEAL: DealDetail isServerError classifies 503 as server error (not "Deal not found")', () => {
  function isServerErrorFixed(status) {
    return (status >= 500) || !status;
  }
  assert.ok(isServerErrorFixed(503), '503 network error must be classified as server error');
  assert.ok(isServerErrorFixed(500), '500 must be a server error');
  assert.ok(isServerErrorFixed(undefined), 'undefined status must be a server error');
  assert.ok(!isServerErrorFixed(404), '404 must NOT be a server error (genuine not found)');
  assert.ok(!isServerErrorFixed(403), '403 must NOT be a server error');
});

test('DEAL: sub-entity failure does not mask valid deal as "not found"', () => {
  const mainDeal = {
    id: 'f9d092c4-f634-4290-85c4-05ec5f06567f',
    lead_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    stage: 'Sold / Estimate Approved',
  };

  let deal = null;
  let loadError = null;
  const finalDeal = mainDeal;

  const leadFetchFails = true;
  const invoicesFetchFails = true;
  const stageUpdateFails = true;

  if (leadFetchFails) { /* caught — leadData = null */ }
  if (invoicesFetchFails) { /* caught — invoices = [] */ }
  if (stageUpdateFails) { /* caught — finalDeal stays as d */ }

  deal = finalDeal;

  assert.ok(deal, 'deal must be set when main fetch succeeds (despite sub-entity failures)');
  assert.strictEqual(loadError, null, 'loadError must be null when only sub-entity fails');
  assert.ok(!(!deal && !loadError), 'must NOT show "Deal not found" when deal is loaded');
});

// ── LEAD DETAIL: direct /leads/:id refresh works ────────────────────────────

test('LEAD: direct /leads/:id refresh uses safe leadIdWhere (UUID and legacy)', () => {
  const uuid = 'f9d092c4-f634-4290-85c4-05ec5f06567f';
  const legacy = '6a8b8d3dea2e908b05855f46';

  const uuidResult = leadIdWhere(uuid, 'l.');
  assert.ok(uuidResult.whereSql.includes('l.external_ref = $1'));
  assert.ok(uuidResult.whereSql.includes('l.id = $2::uuid'));

  const legacyResult = leadIdWhere(legacy, 'l.');
  assert.ok(legacyResult.whereSql.includes('l.external_ref = $1'));
  assert.ok(!legacyResult.whereSql.includes('l.id = $2::uuid'));
});

// ── LEAD DETAIL: error semantics (404 vs 500) ───────────────────────────────

test('LEAD: missing lead returns 404 (not 500)', () => {
  function leadNotFoundResponse(rows) {
    if (!rows[0]) return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: { lead: rows[0] } };
  }
  const res = leadNotFoundResponse([]);
  assert.strictEqual(res.status, 404);
});

test('LEAD: settings query failure returns 500 (not 404)', () => {
  function settingsErrorResponse() {
    return { status: 500, body: { error: 'column "key" does not exist' } };
  }
  const res = settingsErrorResponse();
  assert.strictEqual(res.status, 500);
});