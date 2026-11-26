/* eslint-disable no-undef */
'use strict';

/**
 * qbSyncCursorPersistence.test.js — source-level proof (server.js is not
 * requirable — same constraint as test/qbLegacyWriteRouteSecurity.test.js)
 * that both QB cron ticks now persist real, classifiable sync evidence to
 * sync_cursors instead of only console.log'ing it (October 2026
 * reliability pass — the Integrations page previously had NO durable
 * record that inbound reconciliation ever ran at all, and the estimate
 * sync cursor conflated "ran" with "succeeded").
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the quickbooks_estimates cursor save classifies the outcome and tracks last_attempted_at separately from last_successful_sync_at', () => {
  const idx = SOURCE.indexOf("integration: 'quickbooks_estimates'");
  assert.ok(idx > -1);
  const block = SOURCE.slice(Math.max(0, idx - 500), idx + 1200);
  assert.ok(/classifySyncOutcome/.test(block));
  assert.ok(/isSuccessfulOutcome/.test(block));
  assert.ok(/last_attempted_at:\s*nowIso/.test(block));
  assert.ok(/if \(isSuccessfulOutcome\(outcome\)\) fields\.last_successful_sync_at = nowIso;/.test(block));
});

test('stats.failed is actually computed (not left permanently 0) before the estimate-sync cursor is saved', () => {
  const idx = SOURCE.indexOf("integration: 'quickbooks_estimates'");
  const block = SOURCE.slice(Math.max(0, idx - 2200), idx);
  assert.ok(/stats\.failed = stats\.errors\.length;/.test(block), 'stats.failed must be derived from the real per-item error count');
});

test('the qb-inbound-cron tick persists a quickbooks_inbound_reconcile cursor with the same classifier', () => {
  const idx = SOURCE.indexOf("integration: 'quickbooks_inbound_reconcile'");
  assert.ok(idx > -1, 'expected a quickbooks_inbound_reconcile sync_cursors write in the qb-inbound-cron tick');
  const block = SOURCE.slice(Math.max(0, idx - 900), idx + 200);
  assert.ok(/classifySyncOutcome/.test(block));
  assert.ok(/isSuccessfulOutcome/.test(block));
  assert.ok(/stopped_early: !!result\?\.stopped_early/.test(block));
});

test('the inbound-reconcile cursor write only happens on a real (non-skipped) tick result', () => {
  const skipIdx = SOURCE.indexOf("console.log('[qb-inbound-cron] skipped");
  const cursorIdx = SOURCE.indexOf("integration: 'quickbooks_inbound_reconcile'");
  assert.ok(skipIdx > -1 && cursorIdx > -1);
  assert.ok(skipIdx < cursorIdx, 'the skip branch must come first (an else branch) relative to the cursor-writing success branch');
});

/**
 * November 2026 CRM acceptance review finding: when the shared circuit
 * breaker was ALREADY open before runQbEstimateSyncInner's very first
 * QuickBooks call, fetchAllQbEstimates() threw a circuitOpen error that
 * propagated straight out of the function — skipping the cursor-save block
 * entirely, so `last_attempted_at` never advanced during a sustained
 * breaker-open outage. This made checkQbSyncScheduler falsely report "the
 * scheduler may not be executing" (a second, misleading alarm for the exact
 * same quota/rate-limit condition checkQbHealth already correctly reports)
 * — confirmed live in production: `quickbooks-sync-scheduler` reported
 * unhealthy with that exact message while the breaker was open.
 */
test('fetchAllQbEstimates() is called inside a try/catch that treats a pre-loop circuitOpen failure as a stopped-early attempt, never an uncaught throw that skips the cursor save', () => {
  const fnIdx = SOURCE.indexOf('async function runQbEstimateSyncInner()');
  assert.ok(fnIdx > -1);
  const cursorIdx = SOURCE.indexOf("integration: 'quickbooks_estimates'", fnIdx);
  assert.ok(cursorIdx > fnIdx, 'the quickbooks_estimates cursor save must still be reachable after runQbEstimateSyncInner starts');
  const block = SOURCE.slice(fnIdx, cursorIdx);
  assert.ok(/try\s*\{\s*qbEstimates = await fetchAllQbEstimates\(\);/.test(block), 'fetchAllQbEstimates() must be called inside a try block');
  assert.ok(/if \(!e\.circuitOpen\) throw e;/.test(block), 'a non-circuitOpen error must still propagate (never silently swallowed)');
  assert.ok(/stats\.stopped_early = true;/.test(block), 'a pre-loop circuitOpen failure must set stopped_early so classifySyncOutcome reports it correctly, never a bare, uncaught throw');
});
