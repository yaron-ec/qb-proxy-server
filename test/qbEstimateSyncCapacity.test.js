/* eslint-disable no-undef */
'use strict';

/**
 * qbEstimateSyncCapacity.test.js — the QB Estimate Sync cron's
 * runQbEstimateSync() (server.js) loads its matching set (`leads`) and
 * checks its de-dup set (existing handoff_estimates rows).
 *
 * Found during the October 2026 Handoff→QuickBooks→CRM estimate-sync audit
 * (two passes):
 *
 * Pass 1: both sets were loaded via a hard rda.list(entity, sort, limit, 0)
 * SQL LIMIT — 2000 leads, 1000 existing estimates. Past either cap, the
 * OLDEST rows (ordered -created_date) silently dropped out: an older lead
 * became permanently unmatchable, and an aged-out handoff_estimates row was
 * no longer found by the in-memory de-dup check, so the next tick
 * re-inserted it as a DUPLICATE — contradicting the function's own
 * documented idempotency invariant. The `leads` cap was raised to 50000
 * (see test below) — it genuinely needs an in-memory candidate set for
 * qbMatch.js's fuzzy phone/email/name heuristics, not a single indexed
 * lookup, and 50000 is comfortably above any realistic row count for a
 * single-company installation (CLAUDE.md's "Multi-company direction": one
 * deployment per company, never shared-DB multi-tenancy at larger scale).
 *
 * Pass 2 (this file's main addition): the de-dup check itself was changed
 * from the capped in-memory `existingEstimates.find(...)` to a direct,
 * indexed per-estimate query (`rda.filter('HandoffEstimate', { qb_estimate_id })`,
 * backed by the existing idx_handoff_estimates_qb_id index) — this removes
 * ANY row-count dependency for duplicate prevention: it is correct
 * regardless of how large handoff_estimates ever grows, never a cap to
 * raise again later.
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

test('runQbEstimateSync loads leads with a limit comfortably above the legacy 2000-row cap', () => {
  const m = SOURCE.match(/rda\.list\(\s*'Lead'\s*,\s*'-created_date'\s*,\s*(\d+)\s*,\s*0\s*\)/);
  assert.ok(m, "expected to find an rda.list('Lead', '-created_date', <limit>, 0) call in server.js");
  const limit = parseInt(m[1], 10);
  assert.ok(limit >= 10000, `Lead limit (${limit}) must stay well above any realistic leads table size — the old 2000 cap silently excluded older leads from QB estimate matching`);
});

function runQbEstimateSyncInnerBody() {
  const start = SOURCE.indexOf('async function runQbEstimateSyncInner()');
  const end = SOURCE.indexOf('\n// Async job wrapper', start);
  assert.ok(start !== -1 && end !== -1, 'expected to locate runQbEstimateSyncInner()\'s body in server.js');
  return SOURCE.slice(start, end);
}

test('runQbEstimateSync no longer bulk-loads existing HandoffEstimate rows with a hard LIMIT', () => {
  // The old `rda.list('HandoffEstimate', '-created_date', <cap>, 0)` bulk
  // preload (inside the matching/dedup function) is gone — de-dup is now a
  // per-estimate indexed query (next test), correct at any table size with
  // no cap to outgrow. runQbEstimatePdfSync's own, unrelated, much smaller
  // rda.list('HandoffEstimate', ..., 500, 0) (estimates still needing a PDF
  // fetch — a naturally small/shrinking subset, not a dedup check) is a
  // different function and out of scope here.
  assert.doesNotMatch(runQbEstimateSyncInnerBody(), /rda\.list\(\s*'HandoffEstimate'/, 'HandoffEstimate should no longer be bulk-loaded via rda.list with a row cap inside the matching/dedup function');
});

test('runQbEstimateSync dedups existing estimates via an indexed per-qb_estimate_id query, not an in-memory array', () => {
  assert.match(SOURCE, /rda\.filter\(\s*'HandoffEstimate'\s*,\s*\{\s*qb_estimate_id:\s*qbId\s*\}\s*\)/, 'expected a direct rda.filter(\'HandoffEstimate\', { qb_estimate_id: qbId }) lookup per estimate');
});

test('a pre-existing duplicate (>1 row sharing a qb_estimate_id) is surfaced with a warning, not silently resolved', () => {
  assert.match(SOURCE, /existingRows\.length > 1/);
  assert.match(SOURCE, /pre-existing duplicate, not created by this tick/);
});

test('runQbEstimateSync has a re-entrancy guard against overlapping runs (cron tick vs. manual job, a slow-running tick, OR a second Railway replica/process)', () => {
  // October 2026, round 2: upgraded from a plain in-process `_estimateSyncRunning`
  // boolean (which never protected against two replicas/processes racing
  // the same database) to a cross-process Postgres advisory lock — see
  // lib/advisoryLock.js's tryWithAdvisoryLock and its namespace registry.
  assert.match(SOURCE, /tryWithAdvisoryLock\(saleDb\.pool,\s*QB_SYNC_LOCK_NAMESPACE,\s*QB_ESTIMATE_SYNC_LOCK_KEY/, 'expected runQbEstimateSync to take the cross-process advisory lock');
  assert.match(SOURCE, /already_in_progress/, 'expected an overlapping run to return a skipped/already_in_progress result rather than racing');
  // The old boolean's name may still appear in prose comments (documenting
  // what it was replaced with, per this codebase's own convention) — what
  // must be gone is its declaration/assignment as an actual guard.
  assert.doesNotMatch(SOURCE, /(?:let|var|const)\s+_estimateSyncRunning\s*=/, 'the old in-process-only boolean guard must be fully removed as a variable, not left alongside the new lock');
});

test('a manually-matched estimate (match_method === \'manual\') is never re-matched or relabeled by the automatic matcher', () => {
  const idx = SOURCE.indexOf('isManuallyMatched(existing)');
  assert.ok(idx !== -1, 'expected an isManuallyMatched(existing) guard');
  // The guard must appear, and `continue`, BEFORE qbMatch.findMatchingLead is
  // called for this iteration — i.e. automatic matching must never even run
  // for an already-manually-confirmed row.
  const matchCallIdx = SOURCE.indexOf('qbMatch.findMatchingLead(qbCustomer, leads)', idx);
  const continueIdx = SOURCE.indexOf('continue;', idx);
  assert.ok(continueIdx !== -1 && continueIdx < matchCallIdx, 'the manual-match guard must `continue` before automatic re-matching runs');
});
