/* eslint-disable no-undef */
'use strict';

/**
 * qbEstimateSyncManualMatch.test.js — pure unit coverage for
 * server.js#isManuallyMatched, the guard that stops the QB Estimate Sync
 * cron from silently overwriting a human-confirmed estimate<->lead match.
 *
 * Found during the October 2026 Handoff→QuickBooks→CRM estimate-sync audit:
 * every automatic-match write (both the 'matched' and the 'unmatched'
 * branches) unconditionally overwrote lead_id/match_status/match_method on
 * any existing row whenever QuickBooks' MetaData.LastUpdatedTime advanced —
 * including a row a human had just manually re-linked via
 * UnmatchedEstimatesPanel.jsx's "Save & Link" (match_method: 'manual'). The
 * very next time Handoff touched that estimate in QuickBooks (e.g. changing
 * its amount or status), the cron would silently revert the human's
 * correction back to whatever the automatic matcher produced this time —
 * including moving it to a DIFFERENT lead, or back to 'unmatched'.
 *
 * isManuallyMatched(existing) is the extracted, independently-testable
 * guard now checked before automatic re-matching runs at all (source-level
 * proof that it's wired in correctly, including that it `continue`s before
 * qbMatch.findMatchingLead is even called, lives in
 * test/qbEstimateSyncCapacity.test.js, since runQbEstimateSync itself is
 * entangled with a live QuickBooks connection established at server.js
 * module load and can't be exercised directly here).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// isManuallyMatched is a tiny, pure, self-contained function (no closure
// over server.js's module-level state) — extracted from the source so this
// test exercises the ACTUAL shipped implementation rather than a
// hand-copied re-statement of it.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const m = SOURCE.match(/function isManuallyMatched\(existing\) \{[\s\S]*?\n\}/);
assert.ok(m, 'expected to find function isManuallyMatched(existing) { ... } in server.js');
// eslint-disable-next-line no-eval
const isManuallyMatched = eval(`(${m[0]})`);

test('isManuallyMatched: a row with match_method "manual" is manually matched', () => {
  assert.strictEqual(isManuallyMatched({ id: 'est-1', match_method: 'manual' }), true);
});

test('isManuallyMatched: a row with match_method "qb_direct" (automatic) is NOT manually matched', () => {
  assert.strictEqual(isManuallyMatched({ id: 'est-1', match_method: 'qb_direct' }), false);
});

test('isManuallyMatched: a row with match_method "none" (unmatched) is NOT manually matched', () => {
  assert.strictEqual(isManuallyMatched({ id: 'est-1', match_method: 'none' }), false);
});

test('isManuallyMatched: no existing row at all (brand-new estimate) is NOT manually matched', () => {
  assert.strictEqual(isManuallyMatched(null), false);
  assert.strictEqual(isManuallyMatched(undefined), false);
});

test('isManuallyMatched: a row with no match_method set at all is NOT manually matched (never a false positive)', () => {
  assert.strictEqual(isManuallyMatched({ id: 'est-1' }), false);
});
