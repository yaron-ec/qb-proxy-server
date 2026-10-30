/* eslint-disable no-undef */
'use strict';

/**
 * qbCompanyInfoFailureClassification.test.js — pure unit coverage for
 * server.js#classifyCompanyInfoFailure, extracted the same way as
 * test/qbEstimateSyncManualMatch.test.js's isManuallyMatched (server.js has
 * top-level side effects and is not requirable in a unit test).
 *
 * October 2026 "blank Company Name" incident: handleGetCompany previously
 * threw on ANY CompanyInfo-retrieval failure, and the frontend's own
 * `.catch(() => ({}))` discarded the thrown reason entirely — a 429, a
 * circuit-breaker skip, a genuinely revoked credential, and a bare network
 * error all rendered as the identical blank field, reading as
 * "disconnected" even when the company identity had already been
 * independently verified correct. This function is the fix's classifier;
 * the wiring that calls it (the breaker peek + the typed 200 response) is
 * covered by test/qbGetCompanyWiring.test.js (source-level, same server.js
 * constraint).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const m = SOURCE.match(/function classifyCompanyInfoFailure\(e\) \{[\s\S]*?\n\}/);
assert.ok(m, 'expected to find function classifyCompanyInfoFailure(e) { ... } in server.js');
// eslint-disable-next-line no-eval
const classifyCompanyInfoFailure = eval(`(${m[0]})`);

test('a ReconnectRequiredError (e.reconnectRequired) classifies as reconnect_required', () => {
  assert.strictEqual(classifyCompanyInfoFailure({ reconnectRequired: true }), 'reconnect_required');
});

test('a circuit-breaker skip (circuitOpen or status === "circuit_open") classifies as circuit_open', () => {
  assert.strictEqual(classifyCompanyInfoFailure({ circuitOpen: true }), 'circuit_open');
  assert.strictEqual(classifyCompanyInfoFailure({ status: 'circuit_open' }), 'circuit_open');
});

test('a lingering 401 after qbApiRequest\'s own refresh-and-retry classifies as reconnect_required', () => {
  assert.strictEqual(classifyCompanyInfoFailure({ status: 401 }), 'reconnect_required');
});

test('a 429 classifies as rate_limited', () => {
  assert.strictEqual(classifyCompanyInfoFailure({ status: 429 }), 'rate_limited');
});

test('a 5xx classifies as network_failure (Intuit-side outage, not our connection)', () => {
  assert.strictEqual(classifyCompanyInfoFailure({ status: 500 }), 'network_failure');
  assert.strictEqual(classifyCompanyInfoFailure({ status: 503 }), 'network_failure');
});

test('another 4xx (e.g. 404) classifies as unavailable', () => {
  assert.strictEqual(classifyCompanyInfoFailure({ status: 404 }), 'unavailable');
});

test('a bare exception with no .status at all (raw network/fetch error) classifies as network_failure', () => {
  assert.strictEqual(classifyCompanyInfoFailure(new Error('fetch failed')), 'network_failure');
  assert.strictEqual(classifyCompanyInfoFailure(null), 'network_failure');
});

test('reconnectRequired takes priority over a status code on the same error object', () => {
  assert.strictEqual(classifyCompanyInfoFailure({ reconnectRequired: true, status: 429 }), 'reconnect_required');
});
