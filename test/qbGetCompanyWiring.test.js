/* eslint-disable no-undef */
'use strict';

/**
 * qbGetCompanyWiring.test.js — source-level proof (server.js has top-level
 * side effects and is not requirable — same constraint as
 * test/qbLegacyWriteRouteSecurity.test.js) that handleGetCompany:
 *   1. peeks the shared circuit breaker's state (never consumes the trial
 *      slot) before spending a real Intuit call, so a manual Integrations-
 *      page load can never steal the one shared recovery trial a scheduled
 *      sync job needs (October 2026 reliability pass).
 *   2. always responds 200 with a typed { available, reason, message }
 *      shape on failure, instead of throwing — so the frontend's error
 *      handling can't discard the reason the way the old `.catch(() => ({}))`
 *      did.
 *   3. the new /qb/sync-status route exists and is read-only (same auth
 *      gate as /qb/auth-status).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function fnBlock(name) {
  const re = new RegExp(`async function ${name}\\(req, res\\) \\{[\\s\\S]*?\\n\\}`);
  const m = SOURCE.match(re);
  assert.ok(m, `expected to find async function ${name}(req, res) { ... } in server.js`);
  return m[0];
}

test('handleGetCompany peeks (never consumes) the breaker via isCoolingDown before calling qbFetch', () => {
  const block = fnBlock('handleGetCompany');
  assert.ok(/qbRateLimitBreaker['"]\)\.getState\(\)/.test(block), 'must read breaker state');
  assert.ok(/qbRateLimitBreaker['"]\)\.isCoolingDown\(circuitBreaker\)/.test(block), 'must use the pure peek, not checkAndMaybeAllow (which would consume the trial)');
  assert.ok(!/checkAndMaybeAllow/.test(block), 'must never call checkAndMaybeAllow — that would consume the shared trial slot');
});

test('handleGetCompany short-circuits to a 200 JSON response before any qbFetch call when cooling down', () => {
  const block = fnBlock('handleGetCompany');
  const guardIdx = block.indexOf('isCoolingDown(circuitBreaker)');
  const qbFetchIdx = block.indexOf('qbFetch(');
  assert.ok(guardIdx > -1 && qbFetchIdx > -1 && guardIdx < qbFetchIdx, 'the breaker peek must come before the qbFetch call');
  assert.ok(/reason: 'circuit_open'/.test(block));
});

test('handleGetCompany never throws to the client on failure — always res.json with a typed shape', () => {
  const block = fnBlock('handleGetCompany');
  assert.ok(!/handleQBError\(e, res\)/.test(block), 'must no longer delegate to the throw-based handleQBError');
  assert.ok(/classifyCompanyInfoFailure\(e\)/.test(block));
  assert.ok(/available: true, reason: 'verified'/.test(block));
  assert.ok(/available: false,/.test(block));
});

test('/qb/sync-status route is registered with the same read-only auth gate as /qb/auth-status', () => {
  assert.ok(/app\.post\('\/qb\/sync-status', requireProxySecret,/.test(SOURCE), 'expected a requireProxySecret-gated /qb/sync-status route');
});

test('/qb/sync-status delegates to lib/qbSyncStatus#getQbSyncStatus', () => {
  const re = /app\.post\('\/qb\/sync-status'[\s\S]{0,300}/;
  const m = SOURCE.match(re);
  assert.ok(m);
  assert.ok(/getQbSyncStatus\(\)/.test(m[0]));
});
