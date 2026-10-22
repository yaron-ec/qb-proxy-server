/* eslint-disable no-undef */
'use strict';

/**
 * qbEstimateSyncCapacity.test.js — the QB Estimate Sync cron's
 * runQbEstimateSync() (server.js) loads its matching set (`leads`) and its
 * de-dup set (`existingEstimates`) via rda.list(entity, sort, limit, 0) —
 * a hard SQL LIMIT, not a true "fetch all."
 *
 * Found during the October 2026 Handoff→QuickBooks→CRM estimate-sync audit:
 * these were previously capped at 2000 leads / 1000 existing estimates.
 * Once either table grows past its cap, rows past the cutoff (ordered
 * -created_date, so the OLDEST rows) silently drop out of both:
 *   - a lead past the 2000 cutoff can never be matched against a new QB
 *     estimate (qbMatch.findMatchingLead never even sees it), and
 *   - a handoff_estimates row past the 1000 cutoff is no longer found by
 *     the existingEstimates.find(qb_estimate_id) de-dup check, so the next
 *     cron tick re-inserts it as a DUPLICATE row instead of updating it —
 *     directly contradicting this same function's own documented
 *     invariant ("Idempotency: runQbEstimateSync uses qb_estimate_id to
 *     prevent duplicate HandoffEstimate records").
 *
 * This is a source-level regression test (matching this repo's existing
 * convention for server.js cron logic, e.g. test/moduleGateCoverage.test.js)
 * rather than a live-DB integration test, since exercising the actual cron
 * requires a real QuickBooks connection server.js establishes at module
 * load time.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function findRdaListCall(entity) {
  const re = new RegExp(`rda\\.list\\(\\s*'${entity}'\\s*,\\s*'-created_date'\\s*,\\s*(\\d+)\\s*,\\s*0\\s*\\)`);
  const m = SOURCE.match(re);
  assert.ok(m, `expected to find an rda.list('${entity}', '-created_date', <limit>, 0) call in server.js`);
  return parseInt(m[1], 10);
}

test('runQbEstimateSync loads leads with a limit comfortably above the legacy 2000-row cap', () => {
  const limit = findRdaListCall('Lead');
  assert.ok(limit >= 10000, `Lead limit (${limit}) must stay well above any realistic leads table size — the old 2000 cap silently excluded older leads from QB estimate matching`);
});

test('runQbEstimateSync loads existing HandoffEstimate rows with a limit comfortably above the legacy 1000-row cap', () => {
  const limit = findRdaListCall('HandoffEstimate');
  assert.ok(limit >= 10000, `HandoffEstimate limit (${limit}) must stay well above any realistic handoff_estimates table size — the old 1000 cap caused duplicate rows once exceeded (de-dup lookup silently missed aged-out rows)`);
});

test('both limits are loaded in the same Promise.all (no behavior change to the sync\'s concurrency/ordering, only the row cap)', () => {
  const idx = SOURCE.indexOf("rda.list('Lead'");
  const nearby = SOURCE.slice(Math.max(0, idx - 200), idx + 400);
  assert.ok(nearby.includes('Promise.all'), 'expected the Lead and HandoffEstimate loads to remain inside the same Promise.all');
  assert.ok(nearby.includes("rda.list('HandoffEstimate'"), 'expected the HandoffEstimate load to remain alongside the Lead load');
});
