/* eslint-disable no-undef */
'use strict';

/**
 * qbPostRecoveryAcceptanceReport.int.test.js — real-Postgres proof of
 * scripts/qbPostRecoveryAcceptanceReport.js's buildReport(), the read-only
 * tool built for the November 2026 "final acceptance" request's item 3
 * (Production Acceptance): so that whenever the circuit breaker closes
 * after Intuit's quota resets, a single command reports breaker state,
 * verified recovery, sync cursors, locally-measured usage by entity, and
 * company-wide duplicate QuickBooks document numbers.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db;
if (DB_URL) {
  db = require('../../db/client');
}

test.beforeEach(async () => {
  if (!DB_URL) return;
  await db.query(`DELETE FROM qb_payment_allocations`);
  await db.query(`DELETE FROM qb_payments_cache`);
  await db.query(`DELETE FROM qb_invoices_cache`);
  await db.query(`DELETE FROM qb_api_usage_by_entity_daily`);
  await db.query(`DELETE FROM sync_cursors WHERE integration IN ('quickbooks_estimates','quickbooks_inbound_reconcile','quickbooks_full_reconcile')`);
  await db.query(`DELETE FROM app_settings WHERE key = 'qb_rate_limit_breaker'`);
});

test('buildReport: a closed breaker + both cursors recently successful + no duplicates reports overall_ready_for_acceptance_review=true', { skip }, async () => {
  const { buildReport } = require('../../scripts/qbPostRecoveryAcceptanceReport');
  await db.query(
    `INSERT INTO app_settings (key, value, type) VALUES ('qb_rate_limit_breaker', $1::jsonb, 'json')`,
    [JSON.stringify({ state: 'closed', consecutive_failures: 0, opens_count: 2, cooldown_until: null, last_transition_at: new Date(Date.now() - 60000).toISOString() })]
  );
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO sync_cursors (integration, last_successful_sync_at, last_attempted_at) VALUES ($1, $2, $2)`,
    ['quickbooks_estimates', now]
  );
  await db.query(
    `INSERT INTO sync_cursors (integration, last_successful_sync_at, last_attempted_at) VALUES ($1, $2, $2)`,
    ['quickbooks_inbound_reconcile', now]
  );
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_doc_number, qb_customer_id, total_amt, balance, paid) VALUES ('INV-1','DOC-1','CUST-1',100,0,100)`
  );

  const report = await buildReport();
  assert.strictEqual(report.verdict.breaker_closed, true);
  assert.strictEqual(report.verdict.sync_verified_caught_up, true);
  assert.strictEqual(report.verdict.zero_duplicate_invoice_doc_numbers, true);
  assert.strictEqual(report.verdict.zero_duplicate_payment_doc_numbers, true);
  assert.strictEqual(report.verdict.overall_ready_for_acceptance_review, true);
});

test('buildReport: an open breaker reports overall_ready_for_acceptance_review=false regardless of cursors', { skip }, async () => {
  const { buildReport } = require('../../scripts/qbPostRecoveryAcceptanceReport');
  await db.query(
    `INSERT INTO app_settings (key, value, type) VALUES ('qb_rate_limit_breaker', $1::jsonb, 'json')`,
    [JSON.stringify({ state: 'open', consecutive_failures: 5, opens_count: 3, cooldown_until: new Date(Date.now() + 600000).toISOString() })]
  );
  const report = await buildReport();
  assert.strictEqual(report.verdict.breaker_closed, false);
  assert.strictEqual(report.verdict.overall_ready_for_acceptance_review, false);
});

test('buildReport: a company-wide duplicate invoice doc number is detected and fails the verdict', { skip }, async () => {
  const { buildReport } = require('../../scripts/qbPostRecoveryAcceptanceReport');
  await db.query(
    `INSERT INTO app_settings (key, value, type) VALUES ('qb_rate_limit_breaker', $1::jsonb, 'json')`,
    [JSON.stringify({ state: 'closed', consecutive_failures: 0, opens_count: 0, cooldown_until: null })]
  );
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_doc_number, qb_customer_id, total_amt, balance, paid) VALUES
       ('INV-A','DUP-DOC','CUST-1',100,0,100),
       ('INV-B','DUP-DOC','CUST-1',100,0,100)`
  );
  const report = await buildReport();
  assert.strictEqual(report.verdict.zero_duplicate_invoice_doc_numbers, false);
  assert.strictEqual(report.verdict.overall_ready_for_acceptance_review, false);
  assert.strictEqual(report.duplicate_detection.duplicate_invoice_doc_numbers.length, 1);
  assert.deepStrictEqual(report.duplicate_detection.duplicate_invoice_doc_numbers[0].qb_invoice_ids.sort(), ['INV-A', 'INV-B']);
});

test('buildReport: a company-wide duplicate payment doc number is detected and fails the verdict', { skip }, async () => {
  const { buildReport } = require('../../scripts/qbPostRecoveryAcceptanceReport');
  await db.query(
    `INSERT INTO qb_payments_cache (qb_payment_id, qb_doc_number, qb_customer_id, total_amt) VALUES
       ('PMT-A','DUP-PMT','CUST-1',50),
       ('PMT-B','DUP-PMT','CUST-1',50)`
  );
  const report = await buildReport();
  assert.strictEqual(report.verdict.zero_duplicate_payment_doc_numbers, false);
  assert.strictEqual(report.duplicate_detection.duplicate_payment_doc_numbers.length, 1);
});

test('buildReport: locally-measured usage windows sum qb_api_usage_by_entity_daily correctly and never fabricate a verified-usage claim', { skip }, async () => {
  const { buildReport } = require('../../scripts/qbPostRecoveryAcceptanceReport');
  await db.query(
    `INSERT INTO qb_api_usage_by_entity_daily (call_date, entity, subsystem, call_count) VALUES
       (CURRENT_DATE, 'Invoice', 'cdc', 2),
       (CURRENT_DATE - 1, 'Payment', 'cdc', 3),
       (CURRENT_DATE - 6, 'Customer', 'direct_get', 5)`
  );
  const report = await buildReport();
  assert.strictEqual(report.locally_measured_usage.last_24h_approx.total, 2);
  assert.strictEqual(report.locally_measured_usage.last_72h_approx.total, 5);
  assert.strictEqual(report.locally_measured_usage.last_7d_approx.total, 10);
  assert.strictEqual(report.locally_measured_usage.comparison.projection_is_verified, false);
});

test('buildReport: a missing circuit breaker row or missing cursors never throws — degrades gracefully rather than crashing', { skip }, async () => {
  // No breaker row, no cursors, no cache rows at all — the earliest
  // possible state for a brand-new install. qbRateLimitBreaker.getState()
  // defaults a missing row to 'closed' (nothing has ever failed), and
  // qbRecoveryVerification.isQbSyncCaughtUp() deliberately treats a
  // never-run cursor as "not evidence of a failed catch-up" (see that
  // module's own header) — so this is legitimately NOT a failure state,
  // only a never-synced one. This test proves buildReport never throws
  // and always returns a well-formed report in that state, not that the
  // verdict is false.
  const { buildReport } = require('../../scripts/qbPostRecoveryAcceptanceReport');
  const report = await buildReport();
  assert.ok(report.generated_at);
  assert.strictEqual(typeof report.verdict.overall_ready_for_acceptance_review, 'boolean');
  assert.strictEqual(report.verdict.zero_duplicate_invoice_doc_numbers, true);
  assert.strictEqual(report.verdict.zero_duplicate_payment_doc_numbers, true);
});
